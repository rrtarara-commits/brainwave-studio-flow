import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface FrameIORequest {
  action: 'get_feedback' | 'upload' | 'get_projects' | 'get_assets' | 'get_auth_url' | 'exchange_code' | 'disconnect';
  projectId?: string;
  frameioProjectId?: string;
  assetId?: string;
  uploadId?: string;
  fileName?: string;
  fileSize?: number;
  code?: string;
  redirectUri?: string;
}

const FRAMEIO_V4_API_BASE = 'https://api.frame.io/v4';
const ADOBE_IMS_AUTH_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const ADOBE_IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

// Frame.io V4 API helper using user's OAuth token
async function frameioV4Request(
  accessToken: string,
  endpoint: string,
  method: string = 'GET',
  body?: unknown
): Promise<any> {
  const response = await fetch(`${FRAMEIO_V4_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Frame.io V4 API error: ${response.status}`, errorText);
    throw new Error(`Frame.io API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// Get or refresh user's V4 access token
async function getV4AccessToken(
  serviceClient: any,
  userId: string
): Promise<{ accessToken: string; accountId: string } | null> {
  // Fetch stored token
  const { data: tokenData, error } = await serviceClient
    .from('frameio_oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error || !tokenData) {
    console.log('No stored Frame.io token found for user');
    return null;
  }

  // Check if token is expired (with 5 min buffer)
  const expiresAt = new Date(tokenData.expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;

  if (expiresAt.getTime() - bufferMs <= now.getTime()) {
    console.log('Token expired, refreshing...');
    
    const clientId = Deno.env.get('FRAMEIO_CLIENT_ID');
    const clientSecret = Deno.env.get('FRAMEIO_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error('OAuth credentials not configured');
    }

    // Refresh the token
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenData.refresh_token,
    });

    const response = await fetch(ADOBE_IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token refresh failed:', response.status, errorText);
      // Delete invalid token
      await serviceClient.from('frameio_oauth_tokens').delete().eq('user_id', userId);
      return null;
    }

    const newTokenData = await response.json();
    const newExpiresAt = new Date(Date.now() + newTokenData.expires_in * 1000);

    // Update stored token
    await serviceClient
      .from('frameio_oauth_tokens')
      .update({
        access_token: newTokenData.access_token,
        refresh_token: newTokenData.refresh_token || tokenData.refresh_token,
        expires_at: newExpiresAt.toISOString(),
      })
      .eq('user_id', userId);

    return {
      accessToken: newTokenData.access_token,
      accountId: tokenData.account_id,
    };
  }

  return {
    accessToken: tokenData.access_token,
    accountId: tokenData.account_id,
  };
}

// Get projects from V4 API
async function getV4Projects(accessToken: string): Promise<any[]> {
  const allProjects: any[] = [];

  try {
    // Get user's accounts
    const accountsResponse = await frameioV4Request(accessToken, '/accounts');
    const accounts = accountsResponse.data || accountsResponse || [];
    console.log('V4 accounts found:', accounts.length);

    for (const account of accounts) {
      try {
        // Get workspaces for this account
        const workspacesResponse = await frameioV4Request(
          accessToken,
          `/accounts/${account.id}/workspaces`
        );
        const workspaces = workspacesResponse.data || workspacesResponse || [];
        console.log(`Account ${account.id} has ${workspaces.length} workspaces`);

        for (const workspace of workspaces) {
          try {
            // Get projects in this workspace
            const projectsResponse = await frameioV4Request(
              accessToken,
              `/accounts/${account.id}/workspaces/${workspace.id}/projects`
            );
            const projects = projectsResponse.data || projectsResponse || [];
            console.log(`Workspace ${workspace.name} has ${projects.length} projects`);

            allProjects.push(...projects.map((p: any) => ({
              id: p.id,
              name: p.name,
              teamId: workspace.id,
              teamName: workspace.name || 'Workspace',
              rootAssetId: p.root_folder_id || p.root_asset_id,
              accountId: account.id,
            })));
          } catch (projectError) {
            console.error(`Failed to get projects for workspace ${workspace.id}:`, projectError);
          }
        }
      } catch (wsError) {
        console.error(`Failed to get workspaces for account ${account.id}:`, wsError);
      }
    }
  } catch (accountError) {
    console.error('Failed to get accounts:', accountError);
  }

  return allProjects;
}

// Upload file to V4 (remote upload)
async function uploadToV4(
  accessToken: string,
  accountId: string,
  projectId: string,
  fileName: string,
  sourceUrl: string
): Promise<{ assetId: string; shareLink: string }> {
  // Get project to find root folder
  const project = await frameioV4Request(accessToken, `/accounts/${accountId}/projects/${projectId}`);
  const rootFolderId = project.root_folder_id || project.data?.root_folder_id;

  if (!rootFolderId) {
    throw new Error('Could not find project root folder');
  }

  console.log('Initiating remote upload to folder:', rootFolderId);

  // Create remote upload
  const uploadResponse = await frameioV4Request(
    accessToken,
    `/accounts/${accountId}/folders/${rootFolderId}/files/remote_upload`,
    'POST',
    {
      data: {
        name: fileName,
        source_url: sourceUrl,
      },
    }
  );

  const assetId = uploadResponse.data?.id || uploadResponse.id;
  console.log('Remote upload initiated, asset ID:', assetId);

  // Create share link
  let shareLink = `https://next.frame.io/project/${projectId}`;
  try {
    const shareResponse = await frameioV4Request(
      accessToken,
      `/accounts/${accountId}/projects/${projectId}/shares`,
      'POST',
      {
        data: {
          name: `Share: ${fileName}`,
          expires_at: null,
        },
      }
    );

    if (shareResponse.data?.short_url) {
      shareLink = shareResponse.data.short_url;
    } else if (shareResponse.data?.id) {
      // Attach asset to share
      await frameioV4Request(
        accessToken,
        `/accounts/${accountId}/shares/${shareResponse.data.id}/assets`,
        'POST',
        { data: { asset_id: assetId } }
      );
      shareLink = shareResponse.data.short_url || `https://next.frame.io/share/${shareResponse.data.id}`;
    }
  } catch (shareError) {
    console.error('Failed to create share link:', shareError);
    // Use project link as fallback
  }

  return { assetId, shareLink };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
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

    // Create Supabase client with user's JWT
    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Validate user
    const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Frame.io request from: ${user.email}`);

    const body: FrameIORequest = await req.json();
    const { action } = body;

    // Service role client for token operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    console.log(`Frame.io action: ${action}`);

    let result: unknown;

    switch (action) {
      case 'get_auth_url': {
        const clientId = Deno.env.get('FRAMEIO_CLIENT_ID');
        if (!clientId) {
          throw new Error('Frame.io OAuth not configured');
        }

        const redirectUri = body.redirectUri || `${Deno.env.get('SUPABASE_URL')}/functions/v1/frameio/callback`;
        const state = crypto.randomUUID();
        
        const authUrl = new URL(ADOBE_IMS_AUTH_URL);
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        // Adobe IMS requires space-separated scopes matching Adobe Developer Console settings
        authUrl.searchParams.set('scope', 'openid email profile offline_access additional_info.roles');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('state', state);

        result = { authUrl: authUrl.toString(), state };
        break;
      }

      case 'exchange_code': {
        if (!body.code || !body.redirectUri) {
          throw new Error('code and redirectUri required');
        }

        const clientId = Deno.env.get('FRAMEIO_CLIENT_ID');
        const clientSecret = Deno.env.get('FRAMEIO_CLIENT_SECRET');
        
        if (!clientId || !clientSecret) {
          throw new Error('Frame.io OAuth not configured');
        }

        // Exchange code for tokens
        const params = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: body.code,
          redirect_uri: body.redirectUri,
        });

        const tokenResponse = await fetch(ADOBE_IMS_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text();
          console.error('Token exchange failed:', tokenResponse.status, errorText);
          throw new Error(`Token exchange failed: ${errorText}`);
        }

        const tokenData = await tokenResponse.json();
        console.log('Token exchange successful');

        // Get user's Frame.io account info
        const meResponse = await frameioV4Request(tokenData.access_token, '/me');
        const accountId = meResponse.account_id || meResponse.data?.account_id;
        
        if (!accountId) {
          // Try to get from accounts list
          const accountsResponse = await frameioV4Request(tokenData.access_token, '/accounts');
          const accounts = accountsResponse.data || accountsResponse || [];
          if (accounts.length === 0) {
            throw new Error('No Frame.io accounts found');
          }
          // Use first account
          const firstAccountId = accounts[0].id;
          
          // Store tokens
          const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
          await serviceClient
            .from('frameio_oauth_tokens')
            .upsert({
              user_id: user.id,
              access_token: tokenData.access_token,
              refresh_token: tokenData.refresh_token,
              expires_at: expiresAt.toISOString(),
              account_id: firstAccountId,
            });

          result = { connected: true, accountId: firstAccountId };
        } else {
          // Store tokens
          const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
          await serviceClient
            .from('frameio_oauth_tokens')
            .upsert({
              user_id: user.id,
              access_token: tokenData.access_token,
              refresh_token: tokenData.refresh_token,
              expires_at: expiresAt.toISOString(),
              account_id: accountId,
            });

          result = { connected: true, accountId };
        }
        break;
      }

      case 'disconnect': {
        await serviceClient
          .from('frameio_oauth_tokens')
          .delete()
          .eq('user_id', user.id);
        result = { disconnected: true };
        break;
      }

      case 'get_projects': {
        // Try V4 with user token first
        const v4Token = await getV4AccessToken(serviceClient, user.id);
        
        if (v4Token) {
          console.log('Using V4 OAuth token for projects');
          result = await getV4Projects(v4Token.accessToken);
        } else {
          console.log('No V4 token available, returning empty (user needs to connect)');
          result = [];
        }
        break;
      }

      case 'get_assets': {
        if (!body.frameioProjectId) {
          throw new Error('frameioProjectId required');
        }

        const v4Token = await getV4AccessToken(serviceClient, user.id);
        if (!v4Token) {
          throw new Error('Frame.io not connected. Please connect your account.');
        }

        const project = await frameioV4Request(
          v4Token.accessToken,
          `/accounts/${v4Token.accountId}/projects/${body.frameioProjectId}`
        );
        const rootFolderId = project.root_folder_id || project.data?.root_folder_id;

        const assetsResponse = await frameioV4Request(
          v4Token.accessToken,
          `/accounts/${v4Token.accountId}/folders/${rootFolderId}/assets`
        );

        result = (assetsResponse.data || assetsResponse || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          createdAt: a.created_at,
        }));
        break;
      }

      case 'get_feedback': {
        if (!body.assetId) {
          throw new Error('assetId required');
        }

        const v4Token = await getV4AccessToken(serviceClient, user.id);
        if (!v4Token) {
          throw new Error('Frame.io not connected');
        }

        const commentsResponse = await frameioV4Request(
          v4Token.accessToken,
          `/accounts/${v4Token.accountId}/assets/${body.assetId}/comments`
        );

        result = (commentsResponse.data || commentsResponse || []).map((c: any) => {
          let text = c.text || '';
          if (c.timestamp) {
            const mins = Math.floor(c.timestamp / 60);
            const secs = Math.floor(c.timestamp % 60);
            text = `[${mins}:${secs.toString().padStart(2, '0')}] ${text}`;
          }
          return text;
        }).filter((t: string) => t.trim().length > 0);
        break;
      }

      case 'upload': {
        if (!body.frameioProjectId || !body.fileName || !body.uploadId) {
          throw new Error('frameioProjectId, fileName, and uploadId required');
        }

        const v4Token = await getV4AccessToken(serviceClient, user.id);
        if (!v4Token) {
          throw new Error('Frame.io not connected. Please connect your account first.');
        }

        // Get upload record with storage path
        const { data: uploadRecord, error: uploadError } = await serviceClient
          .from('video_uploads')
          .select('*')
          .eq('id', body.uploadId)
          .single();

        if (uploadError || !uploadRecord) {
          throw new Error('Upload record not found');
        }

        // Verify permission
        if (uploadRecord.uploader_id !== user.id) {
          const { data: roleData } = await userSupabase
            .from('user_roles')
            .select('role')
            .eq('user_id', user.id)
            .single();

          if (!roleData?.role || !['admin', 'producer'].includes(roleData.role)) {
            throw new Error('You do not have permission to upload this record');
          }
        }

        // Create signed URL for the file
        const { data: signedUrlData, error: signedUrlError } = await serviceClient.storage
          .from('video-uploads')
          .createSignedUrl(uploadRecord.storage_path, 3600); // 1 hour

        if (signedUrlError || !signedUrlData?.signedUrl) {
          throw new Error('Failed to create signed URL for video file');
        }

        console.log('Created signed URL for remote upload');

        // Upload to Frame.io V4
        const { assetId, shareLink } = await uploadToV4(
          v4Token.accessToken,
          v4Token.accountId,
          body.frameioProjectId,
          body.fileName,
          signedUrlData.signedUrl
        );

        // Update records
        await serviceClient
          .from('video_uploads')
          .update({
            frameio_asset_id: assetId,
            frameio_project_id: body.frameioProjectId,
            frameio_link: shareLink,
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', body.uploadId);

        if (body.projectId) {
          await serviceClient
            .from('projects')
            .update({
              frameio_link: shareLink,
              frameio_project_id: body.frameioProjectId,
            })
            .eq('id', body.projectId);
        }

        result = {
          assetId,
          shareLink,
          message: 'Upload initiated successfully (remote upload)',
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
