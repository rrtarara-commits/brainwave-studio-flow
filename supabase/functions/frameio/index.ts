import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface FrameIORequest {
  action: 'get_feedback' | 'upload' | 'get_projects' | 'get_assets';
  projectId?: string;
  frameioProjectId?: string;
  assetId?: string;
  uploadId?: string;
  fileName?: string;
  fileSize?: number;
}

const FRAMEIO_API_BASE = 'https://api.frame.io/v2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

// Frame.io API helper
async function frameioRequest(
  endpoint: string,
  method: string = 'GET',
  body?: unknown
): Promise<any> {
  const FRAMEIO_TOKEN = Deno.env.get('FRAMEIO_API_TOKEN');
  if (!FRAMEIO_TOKEN) {
    throw new Error('FRAMEIO_API_TOKEN not configured');
  }

  const response = await fetch(`${FRAMEIO_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${FRAMEIO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Frame.io API error: ${response.status}`, errorText);
    throw new Error(`Frame.io API error: ${response.status}`);
  }

  return response.json();
}

// Get list of Frame.io projects (teams/projects)
async function getProjects(): Promise<any> {
  // Get the authenticated user's account
  const me = await frameioRequest('/me');
  console.log('Frame.io user:', me.email);
  
  // Get teams
  const teams = await frameioRequest('/teams');
  
  // Get projects from each team
  const allProjects: any[] = [];
  for (const team of teams) {
    try {
      const projects = await frameioRequest(`/teams/${team.id}/projects`);
      allProjects.push(...projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        teamId: team.id,
        teamName: team.name,
        rootAssetId: p.root_asset_id,
      })));
    } catch (e) {
      console.error(`Failed to get projects for team ${team.id}:`, e);
    }
  }
  
  return allProjects;
}

// Get assets (files/folders) in a project
async function getAssets(rootAssetId: string): Promise<any[]> {
  const assets = await frameioRequest(`/assets/${rootAssetId}/children`);
  return assets.map((a: any) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status,
    createdAt: a.created_at,
    viewerUrl: a.is_session_watermarked ? null : `https://app.frame.io/player/${a.id}`,
  }));
}

// Get comments/feedback for an asset
async function getFeedback(assetId: string): Promise<string[]> {
  const comments = await frameioRequest(`/assets/${assetId}/comments`);
  
  return comments.map((c: any) => {
    let text = c.text || '';
    if (c.timestamp) {
      const mins = Math.floor(c.timestamp / 60);
      const secs = Math.floor(c.timestamp % 60);
      text = `[${mins}:${secs.toString().padStart(2, '0')}] ${text}`;
    }
    return text;
  }).filter((t: string) => t.trim().length > 0);
}

// Create upload URL for a new asset
async function createUpload(
  parentAssetId: string,
  fileName: string,
  fileSize: number
): Promise<{ assetId: string; uploadUrl: string }> {
  const asset = await frameioRequest(`/assets/${parentAssetId}/children`, 'POST', {
    name: fileName,
    type: 'file',
    filetype: 'video',
    filesize: fileSize,
  });

  return {
    assetId: asset.id,
    uploadUrl: asset.upload_url || asset.upload_urls?.[0],
  };
}

// Get shareable link for an asset
async function getShareLink(assetId: string): Promise<string> {
  // Create a review link
  try {
    const link = await frameioRequest(`/assets/${assetId}/review_links`, 'POST', {
      allow_downloading: false,
      allow_approving: true,
      view_mode: 'single',
    });
    return link.short_url || `https://app.frame.io/player/${assetId}`;
  } catch (e) {
    // Fallback to player URL
    return `https://app.frame.io/player/${assetId}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: FrameIORequest = await req.json();
    const { action } = body;

    console.log(`Frame.io action: ${action}`);

    let result: unknown;

    switch (action) {
      case 'get_projects': {
        result = await getProjects();
        break;
      }

      case 'get_assets': {
        if (!body.frameioProjectId) {
          throw new Error('frameioProjectId required');
        }
        // Get project to find root asset
        const project = await frameioRequest(`/projects/${body.frameioProjectId}`);
        result = await getAssets(project.root_asset_id);
        break;
      }

      case 'get_feedback': {
        if (!body.assetId) {
          throw new Error('assetId required');
        }
        result = await getFeedback(body.assetId);
        break;
      }

      case 'upload': {
        if (!body.frameioProjectId || !body.fileName || !body.uploadId) {
          throw new Error('frameioProjectId, fileName, and uploadId required');
        }

        // Get project root asset
        const project = await frameioRequest(`/projects/${body.frameioProjectId}`);
        
        // Create the asset
        const { assetId, uploadUrl } = await createUpload(
          project.root_asset_id,
          body.fileName,
          body.fileSize || 0
        );

        // Get share link
        const shareLink = await getShareLink(assetId);

        // Update the video upload record
        await supabase
          .from('video_uploads')
          .update({
            frameio_asset_id: assetId,
            frameio_project_id: body.frameioProjectId,
            frameio_link: shareLink,
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', body.uploadId);

        // Also update the project record
        if (body.projectId) {
          await supabase
            .from('projects')
            .update({
              frameio_link: shareLink,
              frameio_project_id: body.frameioProjectId,
            })
            .eq('id', body.projectId);
        }

        result = {
          assetId,
          uploadUrl,
          shareLink,
          message: 'Upload created successfully',
        };
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return new Response(
      JSON.stringify({ success: true, data: result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Frame.io function error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
