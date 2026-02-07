import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-truenas-secret',
};

interface VisualAnalysis {
  framesAnalyzed: number;
  issues: Array<{
    type: string;
    timestamp?: string;
    description: string;
    severity: 'error' | 'warning' | 'info';
  }>;
  summary: string;
}

interface AudioAnalysis {
  analyzed: boolean;
  averageDialogueDb: number;
  peakDb: number;
  issues: Array<{
    type: string;
    timestamp?: string;
    description: string;
    severity: 'error' | 'warning' | 'info';
  }>;
  summary: string;
}

interface AnalysisResult {
  uploadId: string;
  success: boolean;
  error?: string;
  visualAnalysis?: VisualAnalysis;
  audioAnalysis?: AudioAnalysis;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate using TrueNAS callback secret
    const truenasSecret = req.headers.get('x-truenas-secret');
    const expectedSecret = Deno.env.get('TRUENAS_CALLBACK_SECRET');

    if (!truenasSecret || truenasSecret !== expectedSecret) {
      console.error('Invalid or missing TrueNAS secret');
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: AnalysisResult = await req.json();
    const { uploadId, success, error, visualAnalysis, audioAnalysis } = body;

    if (!uploadId) {
      return new Response(
        JSON.stringify({ error: 'Missing uploadId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize service client for database operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Get current upload to merge results
    const { data: upload, error: fetchError } = await serviceClient
      .from('video_uploads')
      .select('qc_result, qc_passed')
      .eq('id', uploadId)
      .single();

    if (fetchError) {
      console.error('Error fetching upload:', fetchError);
      throw fetchError;
    }

    if (!success) {
      // Mark as failed
      await serviceClient
        .from('video_uploads')
        .update({
          deep_analysis_status: 'failed',
          visual_analysis: { error: error || 'Unknown error' },
          audio_analysis: { error: error || 'Unknown error' },
        })
        .eq('id', uploadId);

      console.log(`Deep analysis failed for upload ${uploadId}: ${error}`);

      return new Response(
        JSON.stringify({ success: true, status: 'failed' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Merge deep analysis flags into existing QC result
    const existingResult = upload?.qc_result as Record<string, unknown> || {};
    const existingFlags = (existingResult.flags as Array<Record<string, unknown>>) || [];

    // Convert visual analysis issues to QC flags
    const visualFlags = (visualAnalysis?.issues || []).map((issue, idx) => ({
      id: `deep_visual_${idx}`,
      type: issue.severity,
      category: 'Visual',
      title: issue.type,
      description: issue.description + (issue.timestamp ? ` (at ${issue.timestamp})` : ''),
      source: 'deep_analysis',
    }));

    // Convert audio analysis issues to QC flags
    const audioFlags = (audioAnalysis?.issues || []).map((issue, idx) => ({
      id: `deep_audio_${idx}`,
      type: issue.severity,
      category: 'Audio',
      title: issue.type,
      description: issue.description + (issue.timestamp ? ` (at ${issue.timestamp})` : ''),
      source: 'deep_analysis',
    }));

    // Merge all flags
    const allFlags = [...existingFlags, ...visualFlags, ...audioFlags];
    const hasErrors = allFlags.some((f: Record<string, unknown>) => f.type === 'error');

    // Update the QC result with deep analysis data
    const updatedResult = {
      ...existingResult,
      flags: allFlags,
      passed: !hasErrors,
      thoughtTrace: {
        ...(existingResult.thoughtTrace as Record<string, unknown> || {}),
        visualFramesAnalyzed: visualAnalysis?.framesAnalyzed || 0,
        audioAnalyzed: audioAnalysis?.analyzed || false,
        note: 'Deep analysis completed by TrueNAS server',
      },
    };

    // Update the upload record
    await serviceClient
      .from('video_uploads')
      .update({
        deep_analysis_status: 'completed',
        visual_analysis: visualAnalysis,
        audio_analysis: audioAnalysis,
        qc_result: updatedResult,
        qc_passed: !hasErrors,
        signed_url: null, // Clear signed URL after processing
        signed_url_expires_at: null,
      })
      .eq('id', uploadId);

    console.log(`Deep analysis completed for upload ${uploadId}: ${allFlags.length} total flags, passed: ${!hasErrors}`);

    return new Response(
      JSON.stringify({ success: true, status: 'completed', flagsAdded: visualFlags.length + audioFlags.length }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Deep analysis callback error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
