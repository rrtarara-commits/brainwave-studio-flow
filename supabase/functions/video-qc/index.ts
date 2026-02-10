declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { createErrorResponse } from '../_shared/error-utils.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// GCS configuration
const GCS_BUCKET = 'tcvstudioanalyze';
const GCS_API_URL = 'https://storage.googleapis.com/upload/storage/v1/b';

interface QCRequest {
  uploadId: string;
  projectId: string;
  fileName: string;
  storagePath: string;
  clientName?: string;
  frameioFeedback?: string[];
  analysisMode?: 'quick' | 'thorough';
}

interface QCFlag {
  id: string;
  type: 'error' | 'warning' | 'info';
  category: string;
  title: string;
  description: string;
  source: 'metadata' | 'qc_standard' | 'frameio_feedback' | 'ai_analysis';
  ruleId?: string;
}

interface QCResult {
  passed: boolean;
  flags: QCFlag[];
  metadata: Record<string, unknown>;
  analyzedAt: string;
  thoughtTrace: {
    standardsChecked: number;
    feedbackItemsReviewed: number;
    aiModel: string;
    visualFramesAnalyzed: number;
    audioAnalyzed: boolean;
    note?: string;
  };
}

// Get OAuth2 access token from service account JSON
async function getGCSAccessToken(): Promise<string | null> {
  const serviceAccountJson = Deno.env.get('GCP_SERVICE_ACCOUNT_JSON');
  if (!serviceAccountJson) {
    console.error('GCP_SERVICE_ACCOUNT_JSON not configured');
    return null;
  }

  try {
    const sa = JSON.parse(serviceAccountJson);
    
    // Create JWT for token exchange
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    // Base64url encode
    const b64url = (obj: object) => btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;

    // Import private key and sign
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

    // Exchange JWT for access token
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

// Stream file from Supabase Storage to GCS using signed URLs
// This avoids loading the entire file into edge function memory
async function streamToGCS(
  serviceClient: any,
  storagePath: string,
  uploadId: string,
  fileName: string,
  analysisMode: string = 'thorough'
): Promise<boolean> {
  try {
    console.log(`Streaming ${storagePath} to GCS uploads/${uploadId}/${fileName}`);

    // Get a signed URL for the source file (valid for 1 hour)
    const { data: signedUrlData, error: signedUrlError } = await serviceClient.storage
      .from('video-uploads')
      .createSignedUrl(storagePath, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error('Failed to create signed URL:', signedUrlError);
      return false;
    }

    console.log('Got signed URL for source file');

    // Get GCS access token
    const accessToken = await getGCSAccessToken();
    if (!accessToken) {
      console.error('Could not obtain GCS access token');
      return false;
    }

    // Initiate resumable upload to GCS with metadata
    const gcsPath = `uploads/${uploadId}/${fileName}`;
    const initUrl = `${GCS_API_URL}/${GCS_BUCKET}/o?uploadType=resumable&name=${encodeURIComponent(gcsPath)}`;
    
    // Determine content type based on file extension
    const ext = fileName.toLowerCase().split('.').pop();
    const contentTypeMap: Record<string, string> = {
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska',
      'webm': 'video/webm',
      'm4v': 'video/x-m4v',
      'mxf': 'application/mxf',
      'prores': 'video/prores',
    };
    const contentType = contentTypeMap[ext || ''] || 'video/mp4';

    const initResponse = await fetch(initUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': contentType,
      },
      body: JSON.stringify({
        name: gcsPath,
        metadata: {
          analysis_mode: analysisMode,
        },
      }),
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error('GCS resumable init failed:', initResponse.status, errorText);
      return false;
    }

    // Get the upload URL from the response header
    const uploadUrl = initResponse.headers.get('Location');
    if (!uploadUrl) {
      console.error('No upload URL returned from GCS');
      return false;
    }

    console.log('Got GCS resumable upload URL, starting stream...');

    // Stream the file from Supabase to GCS
    // Fetch the file from Supabase signed URL
    const sourceResponse = await fetch(signedUrlData.signedUrl);
    if (!sourceResponse.ok || !sourceResponse.body) {
      console.error('Failed to fetch source file:', sourceResponse.status);
      return false;
    }

    // Get content length for upload
    const contentLength = sourceResponse.headers.get('Content-Length');
    
    // Stream directly to GCS
    // Note: We use the body stream directly to avoid loading into memory
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
      },
      body: sourceResponse.body,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('GCS upload failed:', uploadResponse.status, errorText);
      return false;
    }

    console.log(`Successfully streamed to GCS: ${gcsPath}`);
    return true;
  } catch (error) {
    console.error('Error streaming to GCS:', error);
    return false;
  }
}

// Fetch QC standards for studio and specific client
async function getQCStandards(serviceClient: any, clientName?: string): Promise<any[]> {
  const { data: studioStandards } = await serviceClient
    .from('qc_standards')
    .select('*')
    .eq('category', 'studio')
    .eq('is_active', true);

  let clientStandards: any[] = [];
  if (clientName) {
    const { data } = await serviceClient
      .from('qc_standards')
      .select('*')
      .eq('category', 'client')
      .eq('client_name', clientName)
      .eq('is_active', true);
    clientStandards = data || [];
  }

  return [...(studioStandards || []), ...clientStandards];
}

// Extract metadata from filename
function extractMetadata(fileName: string, fileSize?: number): Record<string, unknown> {
  const extension = fileName.split('.').pop()?.toLowerCase();
  const hasResolutionHint = fileName.match(/(\d{3,4})x(\d{3,4})/i) || 
                            fileName.match(/(4k|1080p|720p|2160p)/i);
  const hasVersionHint = fileName.match(/(v\d+|_v\d+|version\s*\d+|rev\d+|r\d+)/i);
  const hasFinalHint = fileName.toLowerCase().includes('final');
  
  return {
    fileName,
    extension,
    format: extension,
    fileSize,
    hasResolutionHint: !!hasResolutionHint,
    hasVersionIndicator: !!hasVersionHint,
    markedAsFinal: hasFinalHint,
    extractedAt: new Date().toISOString(),
  };
}

// Check metadata against QC standards
function checkMetadataRules(metadata: Record<string, unknown>, standards: any[]): QCFlag[] {
  const flags: QCFlag[] = [];
  
  const metadataStandards = standards.filter(s => s.rule_type === 'metadata');
  
  for (const standard of metadataStandards) {
    const config = standard.rule_config;
    
    // Check file format
    if (config.allowed_formats) {
      const ext = metadata.extension as string;
      if (!config.allowed_formats.includes(ext)) {
        flags.push({
          id: `meta_format_${standard.id}`,
          type: standard.severity,
          category: 'Format',
          title: `Invalid file format: ${ext}`,
          description: `${standard.name}: Allowed formats are ${config.allowed_formats.join(', ')}`,
          source: 'qc_standard',
          ruleId: standard.id,
        });
      }
    }

    // Check naming convention
    if (config.naming_pattern) {
      const regex = new RegExp(config.naming_pattern);
      if (!regex.test(metadata.fileName as string)) {
        flags.push({
          id: `meta_naming_${standard.id}`,
          type: standard.severity,
          category: 'Naming',
          title: 'File naming convention violation',
          description: `${standard.name}: ${standard.description || 'File name does not match required pattern'}`,
          source: 'qc_standard',
          ruleId: standard.id,
        });
      }
    }
  }

  return flags;
}

// Use AI to analyze filename patterns, standards, and feedback
async function analyzeWithAI(
  fileName: string,
  metadata: Record<string, unknown>,
  standards: any[],
  frameioFeedback: string[] = []
): Promise<QCFlag[]> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) {
    console.error('LOVABLE_API_KEY not configured');
    return [];
  }

  const flags: QCFlag[] = [];
  
  const customStandards = standards.filter(s => s.rule_type === 'custom');
  const standardsText = customStandards.map(s => 
    `- ${s.name}: ${s.description || ''} (${s.severity})`
  ).join('\n');

  const feedbackText = frameioFeedback.length > 0 
    ? `\n\nFrame.io Feedback to verify was addressed:\n${frameioFeedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';

  const prompt = `You are a video QC assistant for TCV Studio. Analyze this video submission based on the file name, metadata, and provided standards.

Video File: ${fileName}

File Metadata:
- Format: ${metadata.extension}
- Has version indicator (v1, v2, etc.): ${metadata.hasVersionIndicator}
- Marked as final: ${metadata.markedAsFinal}
- Has resolution hint: ${metadata.hasResolutionHint}

QC Standards to Check:
${standardsText || 'No custom standards defined.'}
${feedbackText}

Based on the file name, metadata, and standards, identify any potential issues or concerns. Consider:
1. Does the file naming follow professional conventions?
2. If there's Frame.io feedback, does the filename suggest revisions were made (v2, revised, final, etc.)?
3. Are there any red flags in the naming that suggest incomplete work?

For each issue found, respond in JSON format:
{
  "flags": [
    {
      "category": "string (e.g., 'Naming', 'Feedback', 'Standard', 'Workflow')",
      "title": "short issue title",
      "description": "detailed explanation",
      "severity": "error | warning | info"
    }
  ],
  "summary": "brief overall assessment"
}

If the file appears to meet standards and feedback seems addressed, return empty flags array with a positive summary.
Only return the JSON, no other text.`;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: 'You are a video QC specialist. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.error('AI Gateway error:', response.status);
      return [];
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';
    
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.flags && Array.isArray(parsed.flags)) {
          for (const flag of parsed.flags) {
            flags.push({
              id: `ai_${crypto.randomUUID().slice(0, 8)}`,
              type: flag.severity || 'warning',
              category: flag.category || 'AI Analysis',
              title: flag.title,
              description: flag.description,
              source: 'ai_analysis',
            });
          }
        }
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
    }
  } catch (error) {
    console.error('AI analysis error:', error);
  }

  return flags;
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

    const body: QCRequest = await req.json();
    const { uploadId, projectId, fileName, storagePath, clientName, frameioFeedback, analysisMode } = body;

    // Verify the user is the uploader or has permission (admin/producer)
    const { data: roleData } = await userSupabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    // Initialize service role client for database operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Check if user owns this upload or is admin/producer
    const { data: upload } = await serviceClient
      .from('video_uploads')
      .select('uploader_id, file_size')
      .eq('id', uploadId)
      .single();

    const isOwner = upload?.uploader_id === user.id;
    const hasRole = roleData?.role && ['admin', 'producer'].includes(roleData.role);

    if (!isOwner && !hasRole) {
      return new Response(
        JSON.stringify({ error: 'You do not have permission to QC this upload' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Starting QC analysis for upload ${uploadId}, file: ${fileName}, user: ${user.email}`);

    // Update status to analyzing
    await serviceClient
      .from('video_uploads')
      .update({ status: 'analyzing' })
      .eq('id', uploadId);

    // Get QC standards
    const standards = await getQCStandards(serviceClient, clientName);
    console.log(`Loaded ${standards.length} QC standards`);

    // Extract metadata from filename
    const metadata = extractMetadata(fileName, upload?.file_size);

    // Run metadata checks and AI analysis in parallel
    const [metadataFlags, aiFlags] = await Promise.all([
      Promise.resolve(checkMetadataRules(metadata, standards)),
      analyzeWithAI(fileName, metadata, standards, frameioFeedback),
    ]);

    const allFlags = [...metadataFlags, ...aiFlags];
    const hasErrors = allFlags.some(f => f.type === 'error');
    const passed = !hasErrors;

    const result: QCResult = {
      passed,
      flags: allFlags,
      metadata,
      analyzedAt: new Date().toISOString(),
      thoughtTrace: {
        standardsChecked: standards.length,
        feedbackItemsReviewed: frameioFeedback?.length || 0,
        aiModel: 'google/gemini-3-flash-preview',
        visualFramesAnalyzed: 0,
        audioAnalyzed: false,
        note: 'Full visual/audio analysis requires video processing service integration',
      },
    };

    // Update the upload record — MUST succeed for correct state transition
    const { error: updateError } = await serviceClient
      .from('video_uploads')
      .update({
        status: 'reviewed',
        qc_result: result,
        qc_passed: passed,
        analyzed_at: new Date().toISOString(),
        deep_analysis_status: 'pending', // Will be processed by GCP Cloud Run
      })
      .eq('id', uploadId);

    if (updateError) {
      console.error('CRITICAL: Failed to update upload status to reviewed:', updateError);
      // Retry once
      const { error: retryError } = await serviceClient
        .from('video_uploads')
        .update({
          status: 'reviewed',
          qc_result: result,
          qc_passed: passed,
          analyzed_at: new Date().toISOString(),
          deep_analysis_status: 'pending',
        })
        .eq('id', uploadId);
      
      if (retryError) {
        console.error('CRITICAL: Retry also failed:', retryError);
        return new Response(
          JSON.stringify({ error: 'Failed to save QC results' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log(`QC analysis complete: ${passed ? 'PASSED' : 'NEEDS REVIEW'}, ${allFlags.length} flags`);

    // Stream file to GCS to trigger deep analysis (runs in background)
    // Uses streaming to avoid 150MB edge function memory limit
    const mode = analysisMode || 'thorough';
    EdgeRuntime.waitUntil(
      (async () => {
        console.log(`Starting background GCS streaming upload (mode: ${mode})...`);
        const gcsCopySuccess = await streamToGCS(serviceClient, storagePath, uploadId, fileName, mode);
        if (gcsCopySuccess) {
          console.log(`GCS streaming upload complete for ${uploadId}, deep analysis will be triggered`);
          await serviceClient
            .from('video_uploads')
            .update({ deep_analysis_status: 'processing' })
            .eq('id', uploadId);
        } else {
          console.error(`GCS streaming upload failed for ${uploadId}`);
          await serviceClient
            .from('video_uploads')
            .update({ deep_analysis_status: 'failed' })
            .eq('id', uploadId);
        }
      })()
    );

    return new Response(
      JSON.stringify({ success: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return createErrorResponse(error, 'Video QC', corsHeaders);
  }
});
