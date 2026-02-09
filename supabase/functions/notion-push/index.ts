import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { createErrorResponse } from '../_shared/error-utils.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const NOTION_API_VERSION = '2022-06-28';

interface PushRequest {
  type: 'project' | 'work_log';
  data: Record<string, any>;
  notion_id?: string;
}

// Map app status back to Notion status
// Note: These must match EXACTLY what exists in your Notion "Status 1" property
function mapStatusToNotion(status: string): string {
  const statusMap: Record<string, string> = {
    'active': 'Active',
    'in_progress': 'In Progress',
    'ready_for_edit': 'Ready for Edit', 
    'in_revision': 'In Revision',
    'completed': 'Done',
    'on_hold': 'Inactive',
  };
  const mapped = statusMap[status] || status;
  console.log(`Mapping status: ${status} -> ${mapped}`);
  return mapped;
}

// Update a Notion page
async function updateNotionPage(
  pageId: string,
  properties: Record<string, any>,
  notionApiKey: string
): Promise<{ success: boolean; error?: string }> {
  // Format page ID with dashes if needed
  let formattedId = pageId.replace(/-/g, '');
  if (formattedId.length === 32) {
    formattedId = `${formattedId.slice(0, 8)}-${formattedId.slice(8, 12)}-${formattedId.slice(12, 16)}-${formattedId.slice(16, 20)}-${formattedId.slice(20)}`;
  }

  console.log(`Updating Notion page: ${formattedId}`);
  console.log(`Properties to update:`, JSON.stringify(properties));

  try {
    const response = await fetch(
      `https://api.notion.com/v1/pages/${formattedId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          'Notion-Version': NOTION_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties }),
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`Notion API error: ${response.status} - ${responseText}`);
      return {
        success: false,
        error: `Notion API returned ${response.status}: ${responseText.slice(0, 200)}`,
      };
    }

    console.log(`Successfully updated Notion page: ${formattedId}`);
    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error updating Notion page:`, error);
    return { success: false, error: msg };
  }
}

// Create a new Notion page (for work logs)
async function createNotionPage(
  databaseId: string,
  properties: Record<string, any>,
  notionApiKey: string
): Promise<{ success: boolean; pageId?: string; error?: string }> {
  // Format database ID with dashes if needed
  let formattedId = databaseId.replace(/-/g, '');
  if (formattedId.length === 32) {
    formattedId = `${formattedId.slice(0, 8)}-${formattedId.slice(8, 12)}-${formattedId.slice(12, 16)}-${formattedId.slice(16, 20)}-${formattedId.slice(20)}`;
  }

  console.log(`Creating Notion page in database: ${formattedId}`);

  try {
    const response = await fetch(
      'https://api.notion.com/v1/pages',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          'Notion-Version': NOTION_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parent: { database_id: formattedId },
          properties,
        }),
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`Notion API error: ${response.status} - ${responseText}`);
      return {
        success: false,
        error: `Notion API returned ${response.status}: ${responseText.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(responseText);
    console.log(`Successfully created Notion page: ${data.id}`);
    return { success: true, pageId: data.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error creating Notion page:`, error);
    return { success: false, error: msg };
  }
}

// Build Notion properties for a project update
function buildProjectProperties(data: Record<string, any>): Record<string, any> {
  const properties: Record<string, any> = {};

  // Status - using "Status 1" which is a status type in your Notion
  if (data.status !== undefined) {
    properties['Status 1'] = {
      status: {
        name: mapStatusToNotion(data.status),
      },
    };
  }

  // Client Budget - number type
  if (data.client_budget !== undefined) {
    properties['Client Budget'] = {
      number: data.client_budget,
    };
  }

  // Video Format - select type
  if (data.video_format !== undefined && data.video_format !== null) {
    properties['Video Format'] = {
      select: {
        name: data.video_format,
      },
    };
  }

  // Note: Relations like "Billable Client *" require the related page ID, 
  // not the name, so we can't easily update those without a lookup

  return properties;
}

// Build Notion properties for a work log entry
function buildWorkLogProperties(data: Record<string, any>, projectTitle: string): Record<string, any> {
  return {
    // Title - assuming your logs database has a title property
    'Name': {
      title: [
        {
          text: {
            content: `${projectTitle} - ${data.task_type?.join(', ') || 'Work'}`,
          },
        },
      ],
    },
    // Hours - number type
    'Hours': {
      number: data.hours || 0,
    },
    // Date - date type
    'Date': {
      date: {
        start: data.logged_at || new Date().toISOString().split('T')[0],
      },
    },
    // Notes - rich text
    'Notes': {
      rich_text: [
        {
          text: {
            content: data.notes || '',
          },
        },
      ],
    },
  };
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

    // Create Supabase client with user's JWT for auth validation
    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Validate user
    const { data: { user }, error: authError } = await userSupabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check role - only admins and producers can push to Notion
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

    if (!['admin', 'producer'].includes(roleData.role)) {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions. Admin or Producer role required.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Notion push from ${user.email} (${roleData.role})`);

    const notionApiKey = Deno.env.get('NOTION_API_KEY');
    if (!notionApiKey) {
      throw new Error('NOTION_API_KEY is not configured');
    }

    // Initialize service role client for database operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    const body: PushRequest = await req.json();
    console.log(`Received push request:`, JSON.stringify(body));

    if (!body.type || !body.data) {
      throw new Error('Missing required fields: type and data');
    }

    if (body.type === 'project') {
      // Update existing project in Notion
      if (!body.notion_id) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Cannot update project without notion_id - this project was not synced from Notion',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const properties = buildProjectProperties(body.data);
      
      if (Object.keys(properties).length === 0) {
        return new Response(
          JSON.stringify({
            success: true,
            message: 'No updateable properties provided',
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const result = await updateNotionPage(body.notion_id, properties, notionApiKey);

      return new Response(
        JSON.stringify(result),
        { 
          status: result.success ? 200 : 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );

    } else if (body.type === 'work_log') {
      // Create new work log entry in Notion
      const { data: configs } = await serviceClient
        .from('app_config')
        .select('key, value')
        .eq('key', 'notion_logs_db')
        .single();

      if (!configs?.value) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'notion_logs_db not configured in settings',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get project title for the work log entry
      const projectTitle = body.data.project_title || 'Unknown Project';
      const properties = buildWorkLogProperties(body.data, projectTitle);

      const result = await createNotionPage(configs.value, properties, notionApiKey);

      return new Response(
        JSON.stringify(result),
        { 
          status: result.success ? 200 : 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );

    } else {
      throw new Error(`Unknown push type: ${body.type}`);
    }

  } catch (error) {
    return createErrorResponse(error, 'Notion Push', corsHeaders);
  }
});
