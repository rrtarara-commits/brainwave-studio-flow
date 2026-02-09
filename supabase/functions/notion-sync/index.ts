import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { createErrorResponse, sanitizeExternalApiError } from '../_shared/error-utils.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const NOTION_API_VERSION = '2022-06-28';

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

interface PropertyMapping {
  [appField: string]: string;
}

interface StatusMapping {
  [appStatus: string]: string;
}

// Fetch all pages from a Notion database with pagination
async function fetchNotionDatabase(
  databaseId: string,
  notionApiKey: string
): Promise<{ pages: NotionPage[]; error?: string }> {
  const allPages: NotionPage[] = [];
  let cursor: string | undefined;

  // Format database ID with dashes if needed
  let formattedId = databaseId.replace(/-/g, '');
  if (formattedId.length === 32) {
    formattedId = `${formattedId.slice(0, 8)}-${formattedId.slice(8, 12)}-${formattedId.slice(12, 16)}-${formattedId.slice(16, 20)}-${formattedId.slice(20)}`;
  }

  console.log(`Fetching Notion database: ${formattedId}`);

  try {
    do {
      const response = await fetch(
        `https://api.notion.com/v1/databases/${formattedId}/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${notionApiKey}`,
            'Notion-Version': NOTION_API_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            start_cursor: cursor,
            page_size: 100,
          }),
        }
      );

      const responseText = await response.text();
      
      if (!response.ok) {
        console.error(`Notion API error: ${response.status} - ${responseText}`);
        return { 
          pages: [], 
          error: `Notion API returned ${response.status}: ${responseText.slice(0, 200)}` 
        };
      }

      const data = JSON.parse(responseText);
      allPages.push(...(data.results || []));
      cursor = data.next_cursor || undefined;

      if (cursor) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } while (cursor);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error fetching Notion database:`, error);
    return { pages: [], error: msg };
  }

  return { pages: allPages };
}

// Extract value from ANY Notion property type
function extractPropertyValue(prop: any): any {
  if (!prop) return null;
  
  const type = prop.type;
  
  switch (type) {
    case 'title':
      return prop.title?.map((t: any) => t.plain_text).join('') || '';
    case 'rich_text':
      return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      return prop.multi_select?.map((s: any) => s.name) || [];
    case 'date':
      return prop.date?.start || null;
    case 'checkbox':
      return prop.checkbox || false;
    case 'url':
      return prop.url || null;
    case 'email':
      return prop.email || null;
    case 'phone_number':
      return prop.phone_number || null;
    case 'files':
      return prop.files?.[0]?.file?.url || prop.files?.[0]?.external?.url || null;
    case 'relation':
      return prop.relation?.map((r: any) => r.id) || [];
    case 'rollup':
      return prop.rollup?.array?.map((a: any) => extractPropertyValue(a)) || null;
    case 'formula':
      return prop.formula?.[prop.formula?.type] || null;
    case 'status':
      return prop.status?.name || null;
    case 'people':
      return prop.people?.map((p: any) => p.name || p.id) || [];
    case 'created_time':
      return prop.created_time || null;
    case 'last_edited_time':
      return prop.last_edited_time || null;
    default:
      console.log(`Unknown property type: ${type}`);
      return null;
  }
}

// Get property value by mapped name (case-insensitive)
function getMappedProperty(props: Record<string, any>, notionPropName: string): any {
  if (!notionPropName) return null;
  const keys = Object.keys(props);
  const found = keys.find(k => k.toLowerCase() === notionPropName.toLowerCase());
  if (found) {
    return extractPropertyValue(props[found]);
  }
  return null;
}

// Fallback: Find property by possible names (case-insensitive, flexible matching)
function findProperty(props: Record<string, any>, ...possibleNames: string[]): any {
  const keys = Object.keys(props);
  for (const name of possibleNames) {
    const found = keys.find(k => k.toLowerCase().replace(/[_\s-]/g, '') === name.toLowerCase().replace(/[_\s-]/g, ''));
    if (found) {
      return extractPropertyValue(props[found]);
    }
  }
  return null;
}

// Get the first "title" type property (Notion databases always have one)
function getTitleProperty(props: Record<string, any>): string {
  for (const [key, value] of Object.entries(props)) {
    if (value?.type === 'title') {
      return extractPropertyValue(value) || 'Untitled';
    }
  }
  return 'Untitled';
}

// Process Projects database using saved mappings
function mapProjectFromNotion(
  page: NotionPage, 
  propertyMapping: PropertyMapping,
  statusMapping: StatusMapping
): any {
  const props = page.properties;
  
  // Get title (always exists in some form)
  const title = getTitleProperty(props);
  
  // Use mapped properties if available, otherwise fall back to fuzzy matching
  let status: any;
  let clientName: any;
  let clientBudget: any;
  let videoFormat: any;
  let billableRevisions: any;
  let internalRevisions: any;

  if (Object.keys(propertyMapping).length > 0) {
    // Use saved mappings
    status = getMappedProperty(props, propertyMapping.status);
    clientName = getMappedProperty(props, propertyMapping.client_name);
    clientBudget = getMappedProperty(props, propertyMapping.client_budget);
    videoFormat = getMappedProperty(props, propertyMapping.video_format);
    billableRevisions = getMappedProperty(props, propertyMapping.billable_revisions);
    internalRevisions = getMappedProperty(props, propertyMapping.internal_revisions);
  } else {
    // Fallback to fuzzy matching for backwards compatibility
    status = findProperty(props, 'Status 1', 'Status', 'State', 'Phase');
    clientName = findProperty(props, 'Billable Client (zapier)', 'Billable Client *', '🤑 Clients', 'Client', 'ClientName', 'Client Name', 'Customer');
    clientBudget = findProperty(props, 'Client Budget', 'Budget', 'Amount', 'Value');
    videoFormat = findProperty(props, 'Video Format', 'Format', 'VideoFormat', 'Type');
    billableRevisions = findProperty(props, 'BillableRevisions', 'Billable Revisions', 'Billable');
    internalRevisions = findProperty(props, 'InternalRevisions', 'Internal Revisions', 'Internal');
  }
  
  const mapped = {
    notion_id: page.id,
    title: title || 'Untitled',
    status: normalizeStatus(status, statusMapping),
    client_name: typeof clientName === 'string' ? clientName : (Array.isArray(clientName) ? clientName[0] : null),
    client_budget: typeof clientBudget === 'number' ? clientBudget : 0,
    video_format: videoFormat,
    billable_revisions: typeof billableRevisions === 'number' ? billableRevisions : 0,
    internal_revisions: typeof internalRevisions === 'number' ? internalRevisions : 0,
    sentiment_score: 0,
  };
  
  console.log(`Mapped project "${title}": status=${mapped.status}, client=${mapped.client_name}`);
  
  return mapped;
}

// Normalize status using saved status mapping or defaults
function normalizeStatus(status: any, statusMapping: StatusMapping): string {
  if (!status) return 'active';
  const statusStr = String(status);
  
  // First check if there's a direct mapping from Notion label to app status
  // statusMapping is: { appStatus: notionLabel }, so we need to reverse it
  const reverseMapping: Record<string, string> = {};
  for (const [appStatus, notionLabel] of Object.entries(statusMapping)) {
    if (notionLabel) {
      reverseMapping[notionLabel.toLowerCase()] = appStatus;
    }
  }
  
  if (reverseMapping[statusStr.toLowerCase()]) {
    return reverseMapping[statusStr.toLowerCase()];
  }
  
  // Fallback to default normalization
  const s = statusStr.toLowerCase().replace(/[_\s-]/g, '');
  
  const defaultStatusMap: Record<string, string> = {
    'active': 'active',
    'inactive': 'on_hold',
    'inprogress': 'in_progress',
    'readyforedit': 'ready_for_edit',
    'inrevision': 'in_revision',
    'completed': 'completed',
    'done': 'completed',
    'onhold': 'on_hold',
    'paused': 'on_hold',
  };
  
  return defaultStatusMap[s] || 'active';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Authentication check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');

    // Create Supabase client with user's JWT for auth validation
    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Validate user - MUST pass token explicitly when verify_jwt=false
    const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check role - only admins can trigger Notion sync
    const { data: roleData, error: roleError } = await userSupabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    if (roleError || !roleData) {
      return new Response(
        JSON.stringify({ error: 'Unable to verify user role' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (roleData.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions. Admin role required.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Notion sync triggered by admin: ${user.email}`);

    const notionApiKey = Deno.env.get('NOTION_API_KEY');
    if (!notionApiKey) {
      throw new Error('NOTION_API_KEY is not configured');
    }

    // Initialize service role client for database operations
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Check if this is a debug/test request
    const url = new URL(req.url);
    const debugMode = url.searchParams.get('debug') === 'true';

    // Fetch all config including mappings
    const { data: configs, error: configError } = await supabase
      .from('app_config')
      .select('key, value')
      .or('key.eq.notion_projects_db,key.eq.notion_team_db,key.eq.notion_clients_db,key.eq.notion_projects_db_mapping,key.eq.notion_projects_db_status_mapping');

    if (configError) {
      throw new Error(`Failed to fetch config: ${configError.message}`);
    }

    const configMap = new Map((configs || []).map((c: any) => [c.key, c.value]));
    const projectsDbId = configMap.get('notion_projects_db');

    if (!projectsDbId) {
      throw new Error('notion_projects_db not configured in settings');
    }

    // Parse property and status mappings
    let propertyMapping: PropertyMapping = {};
    let statusMapping: StatusMapping = {};
    
    try {
      const mappingStr = configMap.get('notion_projects_db_mapping');
      if (mappingStr) {
        propertyMapping = JSON.parse(mappingStr);
      }
    } catch {
      console.log('No property mapping found, using defaults');
    }
    
    try {
      const statusMappingStr = configMap.get('notion_projects_db_status_mapping');
      if (statusMappingStr) {
        statusMapping = JSON.parse(statusMappingStr);
      }
    } catch {
      console.log('No status mapping found, using defaults');
    }

    console.log('Using property mapping:', propertyMapping);
    console.log('Using status mapping:', statusMapping);

    // Fetch Projects
    const { pages, error: fetchError } = await fetchNotionDatabase(projectsDbId, notionApiKey);
    
    if (fetchError) {
      console.error('Notion database fetch error:', fetchError);
      return new Response(
        JSON.stringify({
          success: false,
          errorCode: 'NOTION_ACCESS_ERROR',
          message: 'Unable to access Notion database',
          hint: 'Make sure your Notion integration has access to this database. Go to Notion → Share → Add your integration.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Debug mode: return property structure without syncing
    if (debugMode && pages.length > 0) {
      const samplePage = pages[0];
      const propertyInfo: Record<string, string> = {};
      
      for (const [key, value] of Object.entries(samplePage.properties)) {
        propertyInfo[key] = (value as any).type;
      }
      
      return new Response(
        JSON.stringify({
          success: true,
          mode: 'debug',
          pagesFound: pages.length,
          properties: propertyInfo,
          sampleValues: Object.fromEntries(
            Object.entries(samplePage.properties).map(([k, v]) => [k, extractPropertyValue(v)])
          ),
          hint: 'These are the properties found in your Notion database. Use these names in your mappings.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Map and sync projects using saved mappings
    const projects = pages.map(page => mapProjectFromNotion(page, propertyMapping, statusMapping));
    
    if (projects.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No projects found in Notion database',
          synced: 0,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Batch upsert
    const { error: upsertError } = await supabase
      .from('projects')
      .upsert(projects, { onConflict: 'notion_id' });

    if (upsertError) {
      throw new Error(`Failed to upsert projects: ${upsertError.message}`);
    }

    // Update last sync time
    await supabase
      .from('app_config')
      .upsert({ 
        key: 'last_notion_sync', 
        value: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${projects.length} projects from Notion`,
        synced: projects.length,
        sample: projects[0],
        mappingsUsed: Object.keys(propertyMapping).length > 0,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return createErrorResponse(error, 'Notion Sync', corsHeaders);
  }
});
