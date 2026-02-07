import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface QCRequest {
  uploadId: string;
  projectId: string;
  fileName: string;
  storagePath: string;
  clientName?: string;
  frameioFeedback?: string[];
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
  };
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

// Fetch QC standards for studio and specific client
async function getQCStandards(clientName?: string): Promise<any[]> {
  const { data: studioStandards } = await supabase
    .from('qc_standards')
    .select('*')
    .eq('category', 'studio')
    .eq('is_active', true);

  let clientStandards: any[] = [];
  if (clientName) {
    const { data } = await supabase
      .from('qc_standards')
      .select('*')
      .eq('category', 'client')
      .eq('client_name', clientName)
      .eq('is_active', true);
    clientStandards = data || [];
  }

  return [...(studioStandards || []), ...clientStandards];
}

// Simulate metadata extraction (in production, use ffprobe or similar)
function extractMetadata(fileName: string): Record<string, unknown> {
  // Extract what we can from filename
  const extension = fileName.split('.').pop()?.toLowerCase();
  const hasResolutionHint = fileName.match(/(\d{3,4})x(\d{3,4})/i) || 
                            fileName.match(/(4k|1080p|720p|2160p)/i);
  
  return {
    fileName,
    extension,
    format: extension,
    hasResolutionHint: !!hasResolutionHint,
    extractedAt: new Date().toISOString(),
    note: 'Full metadata extraction requires video processing service',
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

// Use AI to analyze feedback and check if addressed
async function analyzeWithAI(
  fileName: string,
  standards: any[],
  frameioFeedback: string[] = []
): Promise<QCFlag[]> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) {
    console.error('LOVABLE_API_KEY not configured');
    return [];
  }

  const flags: QCFlag[] = [];
  
  // Build prompt for AI analysis
  const customStandards = standards.filter(s => s.rule_type === 'custom');
  const standardsText = customStandards.map(s => 
    `- ${s.name}: ${s.description || ''} (${s.severity})`
  ).join('\n');

  const feedbackText = frameioFeedback.length > 0 
    ? `\n\nFrame.io Feedback to verify:\n${frameioFeedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';

  const prompt = `You are a video QC assistant for TCV Studio. Analyze this video submission.

Video File: ${fileName}

QC Standards to Check:
${standardsText || 'No custom standards defined.'}
${feedbackText}

Based on the file name and standards, identify any potential issues. For each issue found, respond in JSON format:
{
  "flags": [
    {
      "category": "string (e.g., 'Naming', 'Feedback', 'Standard')",
      "title": "short issue title",
      "description": "detailed explanation",
      "severity": "error | warning | info"
    }
  ],
  "summary": "brief overall assessment"
}

If the file appears to meet standards and feedback seems addressed (based on file naming conventions like 'v2', 'revised', etc.), return empty flags array.
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
    
    // Parse AI response
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
    // Auth check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: QCRequest = await req.json();
    const { uploadId, projectId, fileName, storagePath, clientName, frameioFeedback } = body;

    console.log(`Starting QC analysis for upload ${uploadId}, file: ${fileName}`);

    // Update status to analyzing
    await supabase
      .from('video_uploads')
      .update({ status: 'analyzing' })
      .eq('id', uploadId);

    // Get QC standards
    const standards = await getQCStandards(clientName);
    console.log(`Loaded ${standards.length} QC standards`);

    // Extract metadata
    const metadata = extractMetadata(fileName);

    // Run checks in parallel
    const [metadataFlags, aiFlags] = await Promise.all([
      Promise.resolve(checkMetadataRules(metadata, standards)),
      analyzeWithAI(fileName, standards, frameioFeedback),
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
      },
    };

    // Update the upload record
    await supabase
      .from('video_uploads')
      .update({
        status: 'reviewed',
        qc_result: result,
        qc_passed: passed,
        analyzed_at: new Date().toISOString(),
      })
      .eq('id', uploadId);

    console.log(`QC analysis complete: ${passed ? 'PASSED' : 'NEEDS REVIEW'}, ${allFlags.length} flags`);

    return new Response(
      JSON.stringify({ success: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Video QC error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
