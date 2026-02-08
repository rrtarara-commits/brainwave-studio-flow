import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gcp-secret',
};

interface VisualIssue {
  type: 'error' | 'warning' | 'info';
  category: string;
  title: string;
  description: string;
  timestamp?: number | null;
}

interface VisualAnalysis {
  framesAnalyzed?: number;
  issues: VisualIssue[];
  summary: string;
  qualityScore?: number;
}

interface AudioAnalysis {
  averageDialogueDb?: number | null;
  peakDb?: number | null;
  silenceGaps?: number;
  issues: VisualIssue[];
  summary: string;
}

interface CallbackRequest {
  uploadId: string;
  success: boolean;
  visualAnalysis: VisualAnalysis;
  audioAnalysis: AudioAnalysis;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate using GCP callback secret (trim to avoid newline/whitespace mismatches)
    const gcpSecret = (req.headers.get('x-gcp-secret') ?? '').trim();
    const expectedSecret = (Deno.env.get('GCP_CALLBACK_SECRET') ?? '').trim();

    if (!gcpSecret || !expectedSecret || gcpSecret !== expectedSecret) {
      console.error('Invalid or missing GCP secret', {
        hasProvidedSecret: Boolean(gcpSecret),
        hasExpectedSecret: Boolean(expectedSecret),
        providedLength: gcpSecret.length,
        expectedLength: expectedSecret.length,
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: CallbackRequest = await req.json();
    const { uploadId, success, visualAnalysis, audioAnalysis } = body;

    if (!uploadId) {
      return new Response(
        JSON.stringify({ error: 'Missing uploadId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Received GCP analysis callback for upload ${uploadId}, success: ${success}`);

    // Initialize service client for database operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Fetch existing upload record
    const { data: upload, error: fetchError } = await serviceClient
      .from('video_uploads')
      .select('id, qc_result')
      .eq('id', uploadId)
      .single();

    if (fetchError || !upload) {
      console.error('Upload not found:', uploadId);
      return new Response(
        JSON.stringify({ error: 'Upload not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get existing QC result to merge with deep analysis
    const existingQcResult = upload.qc_result as Record<string, unknown> || {};
    const existingFlags = (existingQcResult.flags as unknown[]) || [];

    // Convert deep analysis issues to QC flags format
    const deepAnalysisFlags: unknown[] = [];

    // Add visual issues
    for (const issue of visualAnalysis.issues || []) {
      deepAnalysisFlags.push({
        id: `gcp_visual_${crypto.randomUUID().slice(0, 8)}`,
        type: issue.type,
        category: issue.category,
        title: issue.title,
        description: issue.description,
        source: 'gcp_analysis',
        timestamp: issue.timestamp,
      });
    }

    // Add audio issues
    for (const issue of audioAnalysis.issues || []) {
      deepAnalysisFlags.push({
        id: `gcp_audio_${crypto.randomUUID().slice(0, 8)}`,
        type: issue.type,
        category: issue.category,
        title: issue.title,
        description: issue.description,
        source: 'gcp_analysis',
        timestamp: issue.timestamp,
      });
    }

    // Merge flags (existing + deep analysis)
    const mergedFlags = [...existingFlags, ...deepAnalysisFlags];

    // Check if any errors exist after deep analysis
    const hasErrors = mergedFlags.some((f: unknown) => (f as { type: string }).type === 'error');

    // Update the thought trace
    const existingTrace = (existingQcResult.thoughtTrace as Record<string, unknown>) || {};
    const updatedTrace = {
      ...existingTrace,
      visualFramesAnalyzed: visualAnalysis.framesAnalyzed || 0,
      audioAnalyzed: true,
      gcpAnalysisCompleted: true,
      visualQualityScore: visualAnalysis.qualityScore,
      audioSummary: audioAnalysis.summary,
      visualSummary: visualAnalysis.summary,
    };

    // Build updated QC result
    const updatedQcResult = {
      ...existingQcResult,
      passed: !hasErrors,
      flags: mergedFlags,
      thoughtTrace: updatedTrace,
      deepAnalysisCompletedAt: new Date().toISOString(),
    };

    // Update the upload record
    const { error: updateError } = await serviceClient
      .from('video_uploads')
      .update({
        qc_result: updatedQcResult,
        qc_passed: !hasErrors,
        visual_analysis: visualAnalysis,
        audio_analysis: audioAnalysis,
        deep_analysis_status: success ? 'completed' : 'failed',
      })
      .eq('id', uploadId);

    if (updateError) {
      console.error('Failed to update upload:', updateError);
      return new Response(
        JSON.stringify({ error: 'Failed to update upload record' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Upload ${uploadId} updated with GCP analysis: ${mergedFlags.length} total flags, passed: ${!hasErrors}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        uploadId,
        flagCount: mergedFlags.length,
        passed: !hasErrors 
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('GCP analysis callback error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
