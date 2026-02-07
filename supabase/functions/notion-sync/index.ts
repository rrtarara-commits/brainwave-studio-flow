import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const NOTION_API_VERSION = '2022-06-28';

interface NotionBlock {
  object: string;
  id: string;
  parent?: { type: string; database_id?: string };
  properties?: Record<string, any>;
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
): Promise<NotionBlock[]> {
  const allPages: NotionBlock[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await fetch(
        `https://api.notion.com/v1/databases/${databaseId}/query`,
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

      if (!response.ok) {
        console.error(`Notion API error: ${response.status} - ${await response.text()}`);
        throw new Error(`Failed to fetch Notion database: ${response.status}`);
      }

      const data = await response.json();
      allPages.push(...(data.results || []));
      cursor = data.next_cursor || undefined;

      // Add delay between requests to respect rate limits
      if (cursor) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } while (cursor);
  } catch (error) {
    console.error(`Error fetching Notion database ${databaseId}:`, error);
    throw error;
  }

  return allPages;
}

// Extract text from Notion rich text array
function extractText(richTextArray: any[]): string {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map((rt) => rt.plain_text || '').join('');
}

// Process Projects database
async function syncProjects(projectsDbId: string, notionApiKey: string) {
  console.log('Syncing Projects...');
  const pages = await fetchNotionDatabase(projectsDbId, notionApiKey);

  const projects = pages.map((page) => {
    const props = page.properties || {};
    return {
      notion_id: page.id,
      title: extractText(props.Title?.title || props.Name?.title || []) || 'Untitled',
      status: props.Status?.select?.name || 'active',
      client_name: extractText(props['Client Name']?.rich_text || props.Client?.rich_text || []) || null,
      client_budget: props['Client Budget']?.number || props.Budget?.number || 0,
      video_format: props['Video Format']?.select?.name || props.Format?.select?.name || null,
      billable_revisions: props['Billable Revisions']?.number || 0,
      internal_revisions: props['Internal Revisions']?.number || 0,
      sentiment_score: props['Sentiment Score']?.number || 0,
    };
  });

  if (projects.length === 0) {
    console.log('No projects to sync');
    return;
  }

  // Batch insert projects (100 at a time)
  const batchSize = 100;
  for (let i = 0; i < projects.length; i += batchSize) {
    const batch = projects.slice(i, i + batchSize);
    const { error } = await supabase
      .from('projects')
      .upsert(batch, { onConflict: 'notion_id' });

    if (error) {
      console.error(`Error upserting projects batch ${i / batchSize}:`, error);
      throw error;
    }
  }

  console.log(`Synced ${projects.length} projects`);
}

// Process Team Roster database
async function syncTeamRoster(teamDbId: string, notionApiKey: string) {
  console.log('Syncing Team Roster...');
  const pages = await fetchNotionDatabase(teamDbId, notionApiKey);

  const profiles = pages.map((page) => {
    const props = page.properties || {};
    const email = extractText(props.Email?.email ? [{ plain_text: props.Email.email }] : props.Email?.rich_text || []);
    const fullName = extractText(props.Name?.title || props['Full Name']?.title || []);
    
    return {
      // Use email as a deterministic user_id placeholder (will be matched during update)
      user_id: undefined, // Will be populated separately if needed
      email: email || undefined,
      full_name: fullName || email || 'Unknown',
      avatar_url: props.Avatar?.files?.[0]?.file?.url || props.Photo?.files?.[0]?.file?.url || null,
      hourly_rate: props['Hourly Rate']?.number || 0,
      friction_score: props['Friction Score']?.number || 0,
      can_manage_resources: props['Can Manage Resources']?.checkbox || false,
      can_upload_footage: props['Can Upload Footage']?.checkbox || false,
    };
  });

  if (profiles.length === 0) {
    console.log('No team members to sync');
    return;
  }

  // For team roster, we store raw profile data without user_id
  // In production, you'd match these against actual user accounts
  console.log(`Processed ${profiles.length} team members (not synced - requires user matching)`);
}

// Process Clients database
async function syncClients(clientsDbId: string, notionApiKey: string) {
  console.log('Syncing Clients...');
  const pages = await fetchNotionDatabase(clientsDbId, notionApiKey);

  const clients = pages.map((page) => {
    const props = page.properties || {};
    return {
      notion_id: page.id,
      name: extractText(props.Name?.title || props['Client Name']?.title || []) || 'Untitled Client',
      email: extractText(props.Email?.email ? [{ plain_text: props.Email.email }] : props.Email?.rich_text || []) || null,
      contact_person: extractText(props['Contact Person']?.rich_text || props.Contact?.rich_text || []) || null,
    };
  });

  if (clients.length === 0) {
    console.log('No clients to sync');
    return;
  }

  // Store clients for reference (optional - implement storage if needed)
  console.log(`Processed ${clients.length} clients`);
}

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Check for required environment variables
    const notionApiKey = Deno.env.get('NOTION_API_KEY');
    if (!notionApiKey) {
      throw new Error('NOTION_API_KEY is not configured');
    }

    // Fetch Notion database IDs from app_config
    const { data: configs, error: configError } = await supabase
      .from('app_config')
      .select('key, value')
      .in('key', ['notion_projects_db', 'notion_team_db', 'notion_clients_db']);

    if (configError) {
      throw new Error(`Failed to fetch config: ${configError.message}`);
    }

    const configMap = new Map((configs || []).map((c: any) => [c.key, c.value]));
    const projectsDbId = configMap.get('notion_projects_db');
    const teamDbId = configMap.get('notion_team_db');
    const clientsDbId = configMap.get('notion_clients_db');

    if (!projectsDbId) {
      throw new Error('notion_projects_db not configured in settings');
    }

    const results = {
      projects: 0,
      team: 0,
      clients: 0,
      errors: [] as string[],
    };

    // Sync Projects
    try {
      await syncProjects(projectsDbId, notionApiKey);
      results.projects = 1; // Flag success
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      results.errors.push(`Projects sync failed: ${msg}`);
      console.error('Projects sync error:', error);
    }

    // Sync Team Roster (if configured)
    if (teamDbId) {
      try {
        await syncTeamRoster(teamDbId, notionApiKey);
        results.team = 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        results.errors.push(`Team sync failed: ${msg}`);
        console.error('Team sync error:', error);
      }
    }

    // Sync Clients (if configured)
    if (clientsDbId) {
      try {
        await syncClients(clientsDbId, notionApiKey);
        results.clients = 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        results.errors.push(`Clients sync failed: ${msg}`);
        console.error('Clients sync error:', error);
      }
    }

    console.log('Sync completed:', results);

    return new Response(
      JSON.stringify({
        success: results.errors.length === 0,
        message: 'Notion sync completed',
        results,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Sync error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
