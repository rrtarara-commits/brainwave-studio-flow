import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * Sync Dismissed Flags to GCS
 * 
 * This function aggregates dismissed QC flags across all video uploads
 * and syncs them to a GCS config file. The Cloud Run worker reads this
 * file to avoid reporting known false positives (the "Memory Layer").
 * 
 * The feedback.json structure:
 * {
 *   "known_exceptions": [
 *     { "category": "...", "pattern": "...", "count": N, "last_dismissed": "..." }
 *   ],
 *   "updated_at": "..."
 * }
 */

interface DismissedPattern {
  category: string;
  pattern: string;
  count: number;
  last_dismissed: string;
  example_titles: string[];
}

interface FeedbackConfig {
  known_exceptions: DismissedPattern[];
  updated_at: string;
  total_dismissals: number;
}

// GCS configuration
const GCS_BUCKET = 'tcvstudioanalyze';
const FEEDBACK_FILE = 'config/feedback.json';

// Get OAuth2 access token from service account JSON
async function getGCSAccessToken(): Promise<string | null> {
  const serviceAccountJson = Deno.env.get('GCP_SERVICE_ACCOUNT_JSON');
  if (!serviceAccountJson) {
    console.error('GCP_SERVICE_ACCOUNT_JSON not configured');
    return null;
  }

  try {
    const sa = JSON.parse(serviceAccountJson);
    
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const b64url = (obj: object) => btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;

    const pemContents = sa.private_key
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');
    
    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    );

    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const jwt = `${unsignedToken}.${signatureB64}`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return null;
    }

    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
  } catch (error) {
    console.error('Failed to get GCS access token:', error);
    return null;
  }
}

// Upload feedback config to GCS
async function uploadFeedbackToGCS(config: FeedbackConfig): Promise<boolean> {
  const accessToken = await getGCSAccessToken();
  if (!accessToken) {
    return false;
  }

  try {
    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(FEEDBACK_FILE)}`;
    
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config, null, 2),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('GCS upload failed:', response.status, errorText);
      return false;
    }

    console.log('Successfully uploaded feedback.json to GCS');
    return true;
  } catch (error) {
    console.error('Error uploading to GCS:', error);
    return false;
  }
}

// Aggregate dismissed flags into patterns
function aggregateDismissedFlags(uploads: any[]): DismissedPattern[] {
  const patternMap = new Map<string, DismissedPattern>();

  for (const upload of uploads) {
    const qcResult = upload.qc_result as any;
    const dismissedIds = upload.dismissed_flags || [];
    
    if (!qcResult?.flags || !Array.isArray(qcResult.flags)) continue;

    for (const flag of qcResult.flags) {
      if (!dismissedIds.includes(flag.id)) continue;

      // Create a pattern key from category + first few words of title
      const titleWords = (flag.title || '').toLowerCase().split(' ').slice(0, 3).join(' ');
      const category = (flag.category || 'Unknown').toLowerCase();
      const patternKey = `${category}:${titleWords}`;

      const existing = patternMap.get(patternKey);
      if (existing) {
        existing.count++;
        existing.last_dismissed = new Date().toISOString();
        if (!existing.example_titles.includes(flag.title) && existing.example_titles.length < 3) {
          existing.example_titles.push(flag.title);
        }
      } else {
        patternMap.set(patternKey, {
          category: flag.category || 'Unknown',
          pattern: titleWords,
          count: 1,
          last_dismissed: new Date().toISOString(),
          example_titles: [flag.title || 'Unknown issue'],
        });
      }
    }
  }

  // Sort by count (most dismissed first) and return top patterns
  return Array.from(patternMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 50); // Keep top 50 patterns
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // This can be called by admins or via a scheduled job
    const authHeader = req.headers.get('Authorization');
    
    // Initialize service role client for aggregating all dismissals
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // If auth header provided, validate user is admin
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      const userSupabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      );

      const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Check admin role
      const { data: roleData } = await serviceClient
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .single();

      if (roleData?.role !== 'admin') {
        return new Response(
          JSON.stringify({ error: 'Admin access required' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } else {
      // Allow internal/cron calls without auth (check for secret header)
      const cronSecret = req.headers.get('x-cron-secret');
      const expectedSecret = Deno.env.get('CRON_SECRET');
      
      if (!expectedSecret || cronSecret !== expectedSecret) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log('Syncing dismissed flags to GCS...');

    // Fetch all uploads with dismissed flags (last 90 days for relevance)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const { data: uploads, error: fetchError } = await serviceClient
      .from('video_uploads')
      .select('id, qc_result, dismissed_flags, updated_at')
      .not('dismissed_flags', 'is', null)
      .gte('updated_at', ninetyDaysAgo.toISOString());

    if (fetchError) {
      console.error('Failed to fetch uploads:', fetchError);
      throw new Error('Failed to fetch dismissed flags');
    }

    console.log(`Found ${uploads?.length || 0} uploads with dismissed flags`);

    // Aggregate patterns
    const patterns = aggregateDismissedFlags(uploads || []);
    const totalDismissals = patterns.reduce((sum, p) => sum + p.count, 0);

    const feedbackConfig: FeedbackConfig = {
      known_exceptions: patterns,
      updated_at: new Date().toISOString(),
      total_dismissals: totalDismissals,
    };

    // Upload to GCS
    const uploadSuccess = await uploadFeedbackToGCS(feedbackConfig);

    if (!uploadSuccess) {
      throw new Error('Failed to upload feedback.json to GCS');
    }

    return new Response(
      JSON.stringify({
        success: true,
        patterns_synced: patterns.length,
        total_dismissals: totalDismissals,
        updated_at: feedbackConfig.updated_at,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Sync dismissed flags error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
