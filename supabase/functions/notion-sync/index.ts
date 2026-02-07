import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const NOTION_API_VERSION = '2022-06-28';

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

interface SyncResult {
  success: boolean;
  projectsCount: number;
  propertiesFound: string[];
  sampleData: any;
  error?: string;
}

// Initialize Supabase client
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

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

// Find property by possible names (case-insensitive, flexible matching)
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

// Process Projects database with flexible property mapping
function mapProjectFromNotion(page: NotionPage): any {
  const props = page.properties;
  const allProps = Object.keys(props);
  
  // Get title (always exists in some form)
  const title = getTitleProperty(props);
  
  // Flexibly find other properties
  const status = findProperty(props, 'Status', 'State', 'Phase') || 'active';
  const clientName = findProperty(props, 'Client', 'ClientName', 'Client Name', 'Customer');
  const clientBudget = findProperty(props, 'Budget', 'ClientBudget', 'Client Budget', 'Amount', 'Value');
  const videoFormat = findProperty(props, 'Format', 'VideoFormat', 'Video Format', 'Type');
  const billableRevisions = findProperty(props, 'BillableRevisions', 'Billable Revisions', 'Billable');
  const internalRevisions = findProperty(props, 'InternalRevisions', 'Internal Revisions', 'Internal');
  
  return {
    notion_id: page.id,
    title: title || 'Untitled',
    status: normalizeStatus(status),
    client_name: clientName,
    client_budget: typeof clientBudget === 'number' ? clientBudget : 0,
    video_format: videoFormat,
    billable_revisions: typeof billableRevisions === 'number' ? billableRevisions : 0,
    internal_revisions: typeof internalRevisions === 'number' ? internalRevisions : 0,
    sentiment_score: 0,
  };
}

// Normalize status to match our enum
function normalizeStatus(status: any): string {
  if (!status) return 'active';
  const s = String(status).toLowerCase().replace(/[_\s-]/g, '');
  
  const statusMap: Record<string, string> = {
    'active': 'active',
    'inprogress': 'in_progress',
    'readyforedit': 'ready_for_edit',
    'inrevision': 'in_revision',
    'completed': 'completed',
    'done': 'completed',
    'onhold': 'on_hold',
    'paused': 'on_hold',
  };
  
  return statusMap[s] || 'active';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const notionApiKey = Deno.env.get('NOTION_API_KEY');
    if (!notionApiKey) {
      throw new Error('NOTION_API_KEY is not configured');
    }

    // Check if this is a debug/test request
    const url = new URL(req.url);
    const debugMode = url.searchParams.get('debug') === 'true';

    // Fetch config
    const { data: configs, error: configError } = await supabase
      .from('app_config')
      .select('key, value')
      .in('key', ['notion_projects_db', 'notion_team_db', 'notion_clients_db']);

    if (configError) {
      throw new Error(`Failed to fetch config: ${configError.message}`);
    }

    const configMap = new Map((configs || []).map((c: any) => [c.key, c.value]));
    const projectsDbId = configMap.get('notion_projects_db');

    if (!projectsDbId) {
      throw new Error('notion_projects_db not configured in settings');
    }

    // Fetch Projects
    const { pages, error: fetchError } = await fetchNotionDatabase(projectsDbId, notionApiKey);
    
    if (fetchError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: fetchError,
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
          hint: 'These are the properties found in your Notion database. Use these names in your database.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Map and sync projects
    const projects = pages.map(mapProjectFromNotion);
    
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

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${projects.length} projects from Notion`,
        synced: projects.length,
        sample: projects[0],
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Sync error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});