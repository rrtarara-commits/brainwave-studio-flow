import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const body: AnalysisRequest = await req.json();
    const { projectTitle, clientName, recentFeedback, revisionHistory, currentStatus } = body;

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

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "revision_prediction",
              description: "Predict whether a revision is due to internal mistake or client scope change",
              parameters: {
                type: "object",
                properties: {
                  recommendation: {
                    type: "string",
                    enum: ["our_fault", "client_scope"],
                    description: "The prediction result"
                  },
                  confidence: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                    description: "Confidence score between 0 and 1"
                  },
                  reasoning: {
                    type: "string",
                    description: "Brief explanation of the reasoning"
                  },
                  dataPoints: {
                    type: "array",
                    items: { type: "string" },
                    description: "Data points that influenced the decision"
                  }
                },
                required: ["recommendation", "confidence", "reasoning", "dataPoints"],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: "function", function: { name: "revision_prediction" } }
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add more credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    
    if (!toolCall) {
      throw new Error("No tool call in response");
    }

    const prediction = JSON.parse(toolCall.function.arguments);

    return new Response(JSON.stringify(prediction), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error in analyze-revision:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
