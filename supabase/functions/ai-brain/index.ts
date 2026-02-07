import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface AIBrainRequest {
  type: 'chat' | 'crew_recommendation' | 'budget_prediction' | 'sentiment_analysis';
  messages?: { role: string; content: string }[];
  context?: {
    projectId?: string;
    videoFormat?: string;
    clientName?: string;
    budget?: number;
  };
}

// Fetch historical project data for context (uses service role client)
async function getProjectContext(serviceClient: any): Promise<string> {
  const { data: projects } = await serviceClient
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!projects || projects.length === 0) {
    return 'No historical project data available.';
  }

  const summary = projects.map((p: any) => 
    `- "${p.title}": Status=${p.status}, Client=${p.client_name || 'Unknown'}, Budget=$${p.client_budget || 0}, ` +
    `BillableRevisions=${p.billable_revisions || 0}, InternalRevisions=${p.internal_revisions || 0}, ` +
    `Format=${p.video_format || 'Unknown'}, SentimentScore=${p.sentiment_score || 0}`
  ).join('\n');

  return `Historical Project Data (${projects.length} projects):\n${summary}`;
}

// Fetch crew performance data (uses service role client)
async function getCrewContext(serviceClient: any): Promise<string> {
  const { data: profiles } = await serviceClient
    .from('profiles')
    .select('id, full_name, email, hourly_rate, friction_score');

  const { data: feedback } = await serviceClient
    .from('crew_feedback')
    .select('target_user_id, rating, turnaround_days, technical_error_rate');

  if (!profiles || profiles.length === 0) {
    return 'No crew data available.';
  }

  // Aggregate feedback by user
  const feedbackMap = new Map<string, { ratings: number[]; turnarounds: number[]; errors: number[] }>();
  (feedback || []).forEach((f: any) => {
    if (!feedbackMap.has(f.target_user_id)) {
      feedbackMap.set(f.target_user_id, { ratings: [], turnarounds: [], errors: [] });
    }
    const entry = feedbackMap.get(f.target_user_id)!;
    if (f.rating) entry.ratings.push(f.rating);
    if (f.turnaround_days) entry.turnarounds.push(f.turnaround_days);
    if (f.technical_error_rate) entry.errors.push(f.technical_error_rate);
  });

  const crewSummary = profiles.map((p: any) => {
    const fb = feedbackMap.get(p.id);
    const avgRating = fb && fb.ratings.length > 0 
      ? (fb.ratings.reduce((a: number, b: number) => a + b, 0) / fb.ratings.length).toFixed(1) 
      : 'N/A';
    const avgTurnaround = fb && fb.turnarounds.length > 0
      ? (fb.turnarounds.reduce((a: number, b: number) => a + b, 0) / fb.turnarounds.length).toFixed(1)
      : 'N/A';
    const avgErrorRate = fb && fb.errors.length > 0
      ? (fb.errors.reduce((a: number, b: number) => a + b, 0) / fb.errors.length).toFixed(1)
      : 'N/A';
    
    return `- ${p.full_name || p.email}: Rate=$${p.hourly_rate || 0}/hr, FrictionScore=${p.friction_score || 0}, ` +
           `AvgRating=${avgRating}, AvgTurnaround=${avgTurnaround}days, ErrorRate=${avgErrorRate}%`;
  }).join('\n');

  return `Crew Performance Data:\n${crewSummary}`;
}

// Fetch work logs for cost analysis (uses service role client)
async function getWorkLogContext(serviceClient: any): Promise<string> {
  const { data: logs } = await serviceClient
    .from('work_logs')
    .select('project_id, hours, task_type, logged_at')
    .order('logged_at', { ascending: false })
    .limit(200);

  if (!logs || logs.length === 0) {
    return 'No work log data available.';
  }

  // Aggregate by project
  const projectHours = new Map<string, number>();
  logs.forEach((log: any) => {
    const current = projectHours.get(log.project_id) || 0;
    projectHours.set(log.project_id, current + (log.hours || 0));
  });

  const summary = Array.from(projectHours.entries())
    .slice(0, 20)
    .map(([pid, hours]) => `- Project ${pid.slice(0, 8)}...: ${hours.toFixed(1)} hours logged`)
    .join('\n');

  return `Work Log Summary (Top 20 projects):\n${summary}`;
}

// Build system prompt based on request type
function buildSystemPrompt(type: string): string {
  const basePrompt = `You are the TCV Studio AI Brain - an intelligent assistant with deep knowledge of this video production studio's history, clients, projects, and team performance.

You have access to:
- Historical project data (budgets, timelines, revision patterns)
- Crew performance metrics (ratings, turnaround times, error rates)
- Client relationship history and sentiment patterns
- Work log data for cost estimation

Always provide actionable insights backed by the data. When recommending crew or predicting costs, explain your reasoning using specific historical patterns.`;

  switch (type) {
    case 'crew_recommendation':
      return `${basePrompt}

CURRENT TASK: Recommend optimal crew members for a project.
Consider: historical performance, turnaround times, friction scores, error rates, and past work on similar projects.
Provide 2-3 recommendations with confidence scores and reasoning.`;

    case 'budget_prediction':
      return `${basePrompt}

CURRENT TASK: Predict project costs and budget requirements.
Analyze: similar past projects, typical hours per video format, hourly rates, and revision patterns.
Provide a cost estimate range (low/mid/high) with breakdown and assumptions.`;

    case 'sentiment_analysis':
      return `${basePrompt}

CURRENT TASK: Analyze client sentiment and project risk.
Look for: revision patterns, historical issues, communication indicators.
Flag potential risks and provide early warning recommendations.`;

    default:
      return `${basePrompt}

You can help with:
1. Answering questions about past projects and clients
2. Recommending the best crew for new projects
3. Predicting project costs based on historical data
4. Analyzing client sentiment and flagging risks

Be conversational but data-driven. Include relevant metrics when available.`;
  }
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

    // Create Supabase client with user's JWT for auth validation
    const userSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Validate user
    const { data: { user }, error: authError } = await userSupabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check role - only admins and producers can access AI Brain
    const { data: roleData, error: roleError } = await userSupabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    if (roleError || !roleData) {
      return new Response(
        JSON.stringify({ error: 'Unable to verify user role' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!['admin', 'producer'].includes(roleData.role)) {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions. Admin or Producer role required.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const body: AIBrainRequest = await req.json();
    const { type, messages = [], context = {} } = body;

    console.log(`AI Brain request from ${user.email}: type=${type}`);

    // Use service role client for data fetching
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Gather context data in parallel
    const [projectContext, crewContext, workLogContext] = await Promise.all([
      getProjectContext(serviceClient),
      getCrewContext(serviceClient),
      getWorkLogContext(serviceClient),
    ]);

    // Build context message
    let contextMessage = `STUDIO DATA CONTEXT:\n\n${projectContext}\n\n${crewContext}\n\n${workLogContext}`;

    // Add specific context if provided
    if (context.projectId) {
      const { data: project } = await serviceClient
        .from('projects')
        .select('*')
        .eq('id', context.projectId)
        .single();
      
      if (project) {
        contextMessage += `\n\nCURRENT PROJECT FOCUS:\n${JSON.stringify(project, null, 2)}`;
      }
    }

    if (context.videoFormat) {
      contextMessage += `\n\nTARGET VIDEO FORMAT: ${context.videoFormat}`;
    }

    if (context.clientName) {
      contextMessage += `\n\nCLIENT: ${context.clientName}`;
    }

    if (context.budget) {
      contextMessage += `\n\nPROPOSED BUDGET: $${context.budget}`;
    }

    // Build messages array for AI
    const systemPrompt = buildSystemPrompt(type);
    const aiMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextMessage },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    console.log(`Sending ${aiMessages.length} messages to AI`);

    // Call Lovable AI Gateway
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: aiMessages,
        max_tokens: 2000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'AI credits exhausted. Please add funds to continue.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const errorText = await response.text();
      console.error('AI Gateway error:', response.status, errorText);
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || 'No response generated.';

    console.log('AI Brain response generated successfully');

    return new Response(
      JSON.stringify({
        success: true,
        response: content,
        thoughtTrace: {
          type,
          contextSize: contextMessage.length,
          model: 'google/gemini-3-flash-preview',
          timestamp: new Date().toISOString(),
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('AI Brain error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
