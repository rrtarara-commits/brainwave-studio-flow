import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { generateWithVertex, parseJsonFromModel } from '../_shared/vertex-ai.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AnalysisRequest {
  projectId: string;
  projectTitle: string;
  clientName?: string;
  recentFeedback?: string[];
  revisionHistory?: {
    billable: number;
    internal: number;
  };
  currentStatus: string;
}

interface RevisionPrediction {
  recommendation: 'our_fault' | 'client_scope';
  confidence: number;
  reasoning: string;
  dataPoints: string[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with user's JWT
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Validate user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check role - only admins and producers can use this function
    const { data: roleData, error: roleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    if (roleError || !roleData) {
      return new Response(
        JSON.stringify({ error: 'Unable to verify user role' }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!['admin', 'producer'].includes(roleData.role)) {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions. Admin or Producer role required.' }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: AnalysisRequest = await req.json();
    const { projectTitle, clientName, recentFeedback, revisionHistory, currentStatus } = body;

    console.log(`Authenticated user ${user.email} analyzing revision for project: ${projectTitle}`);

    const systemPrompt = `You are an AI assistant for a video production company called TCV Studio. Your role is to analyze project context and predict whether a revision request is likely due to an internal mistake (our fault) or a client scope change.

You have access to:
- Project history and revision patterns
- Client communication sentiment
- Historical data on similar projects

Always provide:
1. A clear recommendation: "our_fault" or "client_scope"
2. A confidence score between 0 and 1
3. A brief reasoning explanation (1-2 sentences)
4. Data points that influenced your decision

Be conservative - if unsure, lean toward "client_scope" to avoid unnecessary internal blame.`;

    const userPrompt = `Analyze this revision request:

Project: ${projectTitle}
Client: ${clientName || 'Unknown'}
Current Status: ${currentStatus}
Previous Revisions: ${revisionHistory?.billable || 0} billable, ${revisionHistory?.internal || 0} internal
Recent Feedback: ${recentFeedback?.length ? recentFeedback.join('; ') : 'None available'}

Based on this context, predict whether the current revision is likely our fault or a client scope change.`;

    const predictionSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        recommendation: {
          type: 'string',
          enum: ['our_fault', 'client_scope'],
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        reasoning: {
          type: 'string',
        },
        dataPoints: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['recommendation', 'confidence', 'reasoning', 'dataPoints'],
    };

    const rawPrediction = await generateWithVertex({
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      responseMimeType: 'application/json',
      responseSchema: predictionSchema,
      maxOutputTokens: 600,
      temperature: 0.1,
    });

    const prediction = parseJsonFromModel<RevisionPrediction>(rawPrediction);

    return new Response(JSON.stringify(prediction), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    return createErrorResponse(error, 'Analyze Revision', corsHeaders);
  }
});
