import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const NOTION_API_VERSION = '2022-06-28';

interface NotionProperty {
  id: string;
  name: string;
  type: string;
  options?: { name: string; color?: string }[];
}

interface SchemaRequest {
  action: 'get_schema' | 'create_property';
  database_id: string;
  property_name?: string;
  property_type?: string;
}

// Format database ID with dashes
function formatDatabaseId(databaseId: string): string {
  let formattedId = databaseId.replace(/-/g, '');
  if (formattedId.length === 32) {
    formattedId = `${formattedId.slice(0, 8)}-${formattedId.slice(8, 12)}-${formattedId.slice(12, 16)}-${formattedId.slice(16, 20)}-${formattedId.slice(20)}`;
  }
  return formattedId;
}

// Fetch database schema from Notion
async function fetchDatabaseSchema(
  databaseId: string,
  notionApiKey: string
): Promise<{ properties: NotionProperty[]; error?: string }> {
  const formattedId = formatDatabaseId(databaseId);
  console.log(`Fetching schema for database: ${formattedId}`);

  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${formattedId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          'Notion-Version': NOTION_API_VERSION,
        },
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`Notion API error: ${response.status} - ${responseText}`);
      return {
        properties: [],
        error: `Notion API returned ${response.status}: ${responseText.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(responseText);
    const properties: NotionProperty[] = [];

    for (const [name, prop] of Object.entries(data.properties || {})) {
      const p = prop as any;
      const notionProp: NotionProperty = {
        id: p.id,
        name,
        type: p.type,
      };

      // Extract options for select/multi_select/status types
      if (p.type === 'select' && p.select?.options) {
        notionProp.options = p.select.options.map((o: any) => ({
          name: o.name,
          color: o.color,
        }));
      } else if (p.type === 'multi_select' && p.multi_select?.options) {
        notionProp.options = p.multi_select.options.map((o: any) => ({
          name: o.name,
          color: o.color,
        }));
      } else if (p.type === 'status' && p.status?.options) {
        notionProp.options = p.status.options.map((o: any) => ({
          name: o.name,
          color: o.color,
        }));
      }

      properties.push(notionProp);
    }

    // Sort by name for consistency
    properties.sort((a, b) => a.name.localeCompare(b.name));

    return { properties };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error fetching schema:`, error);
    return { properties: [], error: msg };
  }
}

// Create a new property in a Notion database
async function createDatabaseProperty(
  databaseId: string,
  propertyName: string,
  propertyType: string,
  notionApiKey: string
): Promise<{ success: boolean; property?: NotionProperty; error?: string }> {
  const formattedId = formatDatabaseId(databaseId);
  console.log(`Creating property "${propertyName}" (${propertyType}) in database: ${formattedId}`);

  // Build property configuration based on type
  let propertyConfig: any = {};
  
  switch (propertyType) {
    case 'rich_text':
      propertyConfig = { rich_text: {} };
      break;
    case 'number':
      propertyConfig = { number: { format: 'number' } };
      break;
    case 'select':
      propertyConfig = { select: { options: [] } };
      break;
    case 'multi_select':
      propertyConfig = { multi_select: { options: [] } };
      break;
    case 'date':
      propertyConfig = { date: {} };
      break;
    case 'checkbox':
      propertyConfig = { checkbox: {} };
      break;
    case 'url':
      propertyConfig = { url: {} };
      break;
    case 'email':
      propertyConfig = { email: {} };
      break;
    case 'phone_number':
      propertyConfig = { phone_number: {} };
      break;
    default:
      propertyConfig = { rich_text: {} };
  }

  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${formattedId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          'Notion-Version': NOTION_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            [propertyName]: propertyConfig,
          },
        }),
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`Notion API error: ${response.status} - ${responseText}`);
      return {
        success: false,
        error: `Failed to create property: ${responseText.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(responseText);
    const createdProp = data.properties?.[propertyName];

    if (createdProp) {
      return {
        success: true,
        property: {
          id: createdProp.id,
          name: propertyName,
          type: createdProp.type,
        },
      };
    }

    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error creating property:`, error);
    return { success: false, error: msg };
  }
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
      console.error('Auth validation failed:', authError);
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check role - only admins can access Notion schema
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

    console.log(`Notion schema request from admin: ${user.email}`);

    const notionApiKey = Deno.env.get('NOTION_API_KEY');
    if (!notionApiKey) {
      throw new Error('NOTION_API_KEY is not configured');
    }

    const body: SchemaRequest = await req.json();
    console.log(`Schema request:`, JSON.stringify(body));

    if (!body.database_id) {
      throw new Error('database_id is required');
    }

    if (body.action === 'get_schema') {
      const result = await fetchDatabaseSchema(body.database_id, notionApiKey);

      return new Response(
        JSON.stringify({
          success: !result.error,
          properties: result.properties,
          error: result.error,
        }),
        { status: result.error ? 400 : 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else if (body.action === 'create_property') {
      if (!body.property_name || !body.property_type) {
        throw new Error('property_name and property_type are required for create_property');
      }

      const result = await createDatabaseProperty(
        body.database_id,
        body.property_name,
        body.property_type,
        notionApiKey
      );

      return new Response(
        JSON.stringify(result),
        { status: result.success ? 200 : 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } else {
      throw new Error(`Unknown action: ${body.action}`);
    }

  } catch (error) {
    console.error('Schema error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
