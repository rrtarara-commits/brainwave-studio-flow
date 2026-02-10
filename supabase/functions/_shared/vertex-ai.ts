interface ServiceAccountCredentials {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export interface VertexMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface VertexGenerateOptions {
  systemPrompt?: string;
  messages: VertexMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: 'text/plain' | 'application/json';
  responseSchema?: Record<string, unknown>;
  model?: string;
  location?: string;
}

export function getVertexModel(): string {
  return Deno.env.get('VERTEX_MODEL')?.trim() || 'gemini-2.0-flash-001';
}

function getVertexLocation(override?: string): string {
  return override || Deno.env.get('VERTEX_LOCATION')?.trim() || 'us-central1';
}

function getServiceAccountCredentials(): ServiceAccountCredentials {
  const raw = Deno.env.get('GCP_SERVICE_ACCOUNT_JSON');
  if (!raw) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not configured');
  }

  let parsed: ServiceAccountCredentials;
  try {
    parsed = JSON.parse(raw) as ServiceAccountCredentials;
  } catch (error) {
    throw new Error(`GCP_SERVICE_ACCOUNT_JSON is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }

  return parsed;
}

function getVertexProjectId(serviceAccount: ServiceAccountCredentials): string {
  const explicit = Deno.env.get('VERTEX_PROJECT_ID')?.trim();
  if (explicit) {
    return explicit;
  }

  if (serviceAccount.project_id) {
    return serviceAccount.project_id;
  }

  throw new Error('Missing project id. Set VERTEX_PROJECT_ID or include project_id in GCP_SERVICE_ACCOUNT_JSON');
}

function b64Url(value: string): string {
  return btoa(value)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64UrlJson(value: unknown): string {
  return b64Url(JSON.stringify(value));
}

function pemToBinary(pem: string): Uint8Array {
  const pemContents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  return Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
}

export async function getGoogleAccessToken(scopes: string[] = ['https://www.googleapis.com/auth/cloud-platform']): Promise<string> {
  const serviceAccount = getServiceAccountCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsignedToken = `${b64UrlJson(header)}.${b64UrlJson(payload)}`;
  const keyData = pemToBinary(serviceAccount.private_key!);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken),
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${unsignedToken}.${signatureB64}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google OAuth token exchange failed (${tokenResponse.status}): ${await tokenResponse.text()}`);
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData?.access_token) {
    throw new Error('Google OAuth token exchange returned no access_token');
  }

  return String(tokenData.access_token);
}

function toVertexRole(role: VertexMessage['role']): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

export async function generateWithVertex(options: VertexGenerateOptions): Promise<string> {
  if (!options.messages || options.messages.length === 0) {
    throw new Error('Vertex request requires at least one message');
  }

  const serviceAccount = getServiceAccountCredentials();
  const projectId = getVertexProjectId(serviceAccount);
  const location = getVertexLocation(options.location);
  const model = options.model || getVertexModel();
  const accessToken = await getGoogleAccessToken();

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.3,
    maxOutputTokens: options.maxOutputTokens ?? 2048,
  };

  if (options.responseMimeType) {
    generationConfig.responseMimeType = options.responseMimeType;
  }
  if (options.responseSchema) {
    generationConfig.responseSchema = options.responseSchema;
  }

  const payload: Record<string, unknown> = {
    contents: options.messages
      .map((message) => ({
        role: toVertexRole(message.role),
        parts: [{ text: message.content }],
      })),
    generationConfig,
  };

  const systemPrompt = options.systemPrompt?.trim();
  if (systemPrompt) {
    payload.systemInstruction = {
      role: 'system',
      parts: [{ text: systemPrompt }],
    };
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Vertex AI request failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error('Vertex AI returned no candidates');
  }

  const text = parts
    .map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Vertex AI returned empty content');
  }

  return text;
}

export function parseJsonFromModel<T>(rawText: string): T {
  try {
    return JSON.parse(rawText) as T;
  } catch {
    const jsonMatch = rawText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Model response did not contain valid JSON');
    }
    return JSON.parse(jsonMatch[0]) as T;
  }
}
