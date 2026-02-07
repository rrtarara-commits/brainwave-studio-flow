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
  source: 'metadata' | 'qc_standard' | 'frameio_feedback' | 'ai_analysis' | 'visual_analysis' | 'audio_analysis';
  ruleId?: string;
  timestamp?: string;
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
  };
}

// Fetch QC standards for studio and specific client (uses service role client)
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

// Extract metadata from file
function extractMetadata(fileName: string): Record<string, unknown> {
  const extension = fileName.split('.').pop()?.toLowerCase();
  const hasResolutionHint = fileName.match(/(\d{3,4})x(\d{3,4})/i) || 
                            fileName.match(/(4k|1080p|720p|2160p)/i);
  
  return {
    fileName,
    extension,
    format: extension,
    hasResolutionHint: !!hasResolutionHint,
    extractedAt: new Date().toISOString(),
  };
}

// Check metadata against QC standards
function checkMetadataRules(metadata: Record<string, unknown>, standards: any[]): QCFlag[] {
  const flags: QCFlag[] = [];
  
  const metadataStandards = standards.filter(s => s.rule_type === 'metadata');
  
  for (const standard of metadataStandards) {
    const config = standard.rule_config;
    
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

// Analyze video visually using AI vision model
async function analyzeVideoVisually(
  serviceClient: any,
  storagePath: string,
  fileName: string
): Promise<{ flags: QCFlag[]; framesAnalyzed: number }> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) {
    console.log('LOVABLE_API_KEY not configured, skipping visual analysis');
    return { flags: [], framesAnalyzed: 0 };
  }

  const flags: QCFlag[] = [];
  
  try {
    // Get the video file from storage
    const { data: fileData, error: downloadError } = await serviceClient.storage
      .from('video-uploads')
      .download(storagePath);

    if (downloadError || !fileData) {
      console.error('Failed to download video for visual analysis:', downloadError);
      return { flags: [], framesAnalyzed: 0 };
    }

    // Convert file to base64 for AI analysis
    const arrayBuffer = await fileData.arrayBuffer();
    const base64Video = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );
    
    // Use Gemini vision to analyze the video
    const prompt = `You are a professional video QC specialist for a post-production studio. Analyze this video file and identify any visual quality issues.

Look for:
1. **Visual Glitches**: Artifacts, compression issues, frame drops, stuttering, black frames, flash frames
2. **Color Issues**: Inconsistent color grading, banding, clipping in highlights or shadows, unintended color shifts
3. **Composition Problems**: Jump cuts, misaligned graphics, text cut off at edges, wrong aspect ratio bars
4. **Motion Issues**: Unintended camera shake, jittery motion, speed ramp errors
5. **Overlay/Graphics Issues**: Missing elements, wrong positioning, timing errors with lower thirds
6. **General Quality**: Soft/out of focus footage, noise/grain issues, interlacing artifacts

For each issue found, respond in this exact JSON format:
{
  "issues": [
    {
      "category": "Visual Glitch | Color | Composition | Motion | Graphics | Quality",
      "title": "Brief issue title",
      "description": "Detailed description of what's wrong and where (timestamp if visible)",
      "severity": "error | warning | info",
      "timestamp": "approximate timecode if identifiable"
    }
  ],
  "overallQuality": "good | acceptable | needs_review | poor",
  "summary": "One sentence overall assessment"
}

If the video looks professionally produced with no issues, return: {"issues": [], "overallQuality": "good", "summary": "Video appears professionally produced with no visual issues detected."}

Respond ONLY with valid JSON.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You are a video QC specialist. Respond only with valid JSON.' },
          { 
            role: 'user', 
            content: [
              { type: 'text', text: prompt },
              { 
                type: 'image_url', 
                image_url: { 
                  url: `data:video/${fileName.split('.').pop()};base64,${base64Video}` 
                } 
              }
            ]
          },
        ],
        max_tokens: 2000,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.error('Visual analysis API error:', response.status);
      return { flags: [], framesAnalyzed: 0 };
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';
    
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.issues && Array.isArray(parsed.issues)) {
          for (const issue of parsed.issues) {
            flags.push({
              id: `visual_${crypto.randomUUID().slice(0, 8)}`,
              type: issue.severity || 'warning',
              category: issue.category || 'Visual',
              title: issue.title,
              description: issue.description,
              source: 'visual_analysis',
              timestamp: issue.timestamp,
            });
          }
        }
      }
    } catch (parseError) {
      console.error('Failed to parse visual analysis response:', parseError);
    }

    return { flags, framesAnalyzed: 1 };
  } catch (error) {
    console.error('Visual analysis error:', error);
    return { flags: [], framesAnalyzed: 0 };
  }
}

// Analyze audio levels and voice consistency
async function analyzeAudioLevels(
  serviceClient: any,
  storagePath: string,
  fileName: string
): Promise<{ flags: QCFlag[]; analyzed: boolean }> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) {
    console.log('LOVABLE_API_KEY not configured, skipping audio analysis');
    return { flags: [], analyzed: false };
  }

  const flags: QCFlag[] = [];
  
  try {
    // Get the video file from storage
    const { data: fileData, error: downloadError } = await serviceClient.storage
      .from('video-uploads')
      .download(storagePath);

    if (downloadError || !fileData) {
      console.error('Failed to download video for audio analysis:', downloadError);
      return { flags: [], analyzed: false };
    }

    // Convert file to base64 for AI analysis
    const arrayBuffer = await fileData.arrayBuffer();
    const base64Video = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    const prompt = `You are a professional audio engineer reviewing video content for a post-production studio. Analyze the audio in this video.

Check for:
1. **Voice/Dialogue Levels**: Voice should be clearly audible and consistent, ideally averaging around -12dB to -6dB for broadcast (-3dB peaks are acceptable). Flag if voice is too quiet, too loud, or inconsistent.
2. **Audio Clipping**: Any distortion from levels exceeding 0dB
3. **Level Consistency**: Sudden jumps in volume, inconsistent levels between cuts
4. **Background Audio**: Music or ambience too loud compared to dialogue
5. **Audio Sync**: Any noticeable lip-sync issues
6. **Noise Issues**: Hiss, hum, pops, clicks, or room tone inconsistencies
7. **Mix Balance**: Overall mix should be broadcast-ready with proper headroom

Target specs:
- Dialogue/Voice: averaging -12dB to -6dB (peaks around -3dB)
- Music: -18dB to -12dB (under dialogue)
- Overall loudness: -24 LUFS to -16 LUFS for broadcast

Respond in this exact JSON format:
{
  "issues": [
    {
      "category": "Voice Levels | Clipping | Consistency | Mix Balance | Sync | Noise",
      "title": "Brief issue title",
      "description": "Detailed description of the audio issue",
      "severity": "error | warning | info",
      "timestamp": "approximate timecode if identifiable"
    }
  ],
  "voiceLevelAssessment": "good | too_quiet | too_loud | inconsistent",
  "estimatedPeakLevel": "-XdB approximate",
  "overallAudioQuality": "broadcast_ready | needs_adjustment | needs_remix",
  "summary": "One sentence assessment of audio quality"
}

If audio quality is professional with proper levels, return: {"issues": [], "voiceLevelAssessment": "good", "estimatedPeakLevel": "-3dB to -6dB", "overallAudioQuality": "broadcast_ready", "summary": "Audio levels are well-balanced and broadcast-ready."}

Respond ONLY with valid JSON.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You are an audio engineer. Respond only with valid JSON.' },
          { 
            role: 'user', 
            content: [
              { type: 'text', text: prompt },
              { 
                type: 'image_url', 
                image_url: { 
                  url: `data:video/${fileName.split('.').pop()};base64,${base64Video}` 
                } 
              }
            ]
          },
        ],
        max_tokens: 2000,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.error('Audio analysis API error:', response.status);
      return { flags: [], analyzed: false };
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';
    
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Add voice level assessment as info if not ideal
        if (parsed.voiceLevelAssessment && parsed.voiceLevelAssessment !== 'good') {
          flags.push({
            id: `audio_voice_level`,
            type: parsed.voiceLevelAssessment === 'inconsistent' ? 'warning' : 'info',
            category: 'Voice Levels',
            title: `Voice levels are ${parsed.voiceLevelAssessment}`,
            description: `Expected: -12dB to -6dB average with peaks around -3dB. ${parsed.summary || ''}`,
            source: 'audio_analysis',
          });
        }

        // Add overall quality warning if not broadcast ready
        if (parsed.overallAudioQuality && parsed.overallAudioQuality !== 'broadcast_ready') {
          flags.push({
            id: `audio_quality_overall`,
            type: parsed.overallAudioQuality === 'needs_remix' ? 'error' : 'warning',
            category: 'Audio Quality',
            title: `Audio ${parsed.overallAudioQuality === 'needs_remix' ? 'needs remix' : 'needs adjustment'}`,
            description: parsed.summary || 'Audio levels may need adjustment before delivery.',
            source: 'audio_analysis',
          });
        }

        // Add specific issues
        if (parsed.issues && Array.isArray(parsed.issues)) {
          for (const issue of parsed.issues) {
            flags.push({
              id: `audio_${crypto.randomUUID().slice(0, 8)}`,
              type: issue.severity || 'warning',
              category: issue.category || 'Audio',
              title: issue.title,
              description: issue.description,
              source: 'audio_analysis',
              timestamp: issue.timestamp,
            });
          }
        }
      }
    } catch (parseError) {
      console.error('Failed to parse audio analysis response:', parseError);
    }

    return { flags, analyzed: true };
  } catch (error) {
    console.error('Audio analysis error:', error);
    return { flags: [], analyzed: false };
  }
}

// Use AI to analyze feedback and check custom standards
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

    // Validate user
    const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: QCRequest = await req.json();
    const { uploadId, projectId, fileName, storagePath, clientName, frameioFeedback } = body;

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
      .select('uploader_id')
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

    // Extract metadata
    const metadata = extractMetadata(fileName);

    // Run all checks in parallel
    const [metadataFlags, aiFlags, visualResult, audioResult] = await Promise.all([
      Promise.resolve(checkMetadataRules(metadata, standards)),
      analyzeWithAI(fileName, standards, frameioFeedback),
      analyzeVideoVisually(serviceClient, storagePath, fileName),
      analyzeAudioLevels(serviceClient, storagePath, fileName),
    ]);

    const allFlags = [...metadataFlags, ...aiFlags, ...visualResult.flags, ...audioResult.flags];
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
        aiModel: 'google/gemini-2.5-flash',
        visualFramesAnalyzed: visualResult.framesAnalyzed,
        audioAnalyzed: audioResult.analyzed,
      },
    };

    // Update the upload record
    await serviceClient
      .from('video_uploads')
      .update({
        status: 'reviewed',
        qc_result: result,
        qc_passed: passed,
        analyzed_at: new Date().toISOString(),
      })
      .eq('id', uploadId);

    console.log(`QC analysis complete: ${passed ? 'PASSED' : 'NEEDS REVIEW'}, ${allFlags.length} flags (visual: ${visualResult.framesAnalyzed}, audio: ${audioResult.analyzed})`);

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
