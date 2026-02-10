import { supabase } from '@/integrations/supabase/client';

interface InvokeOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
}

interface InvokeResponse<T> {
  data: T | null;
  error: Error | null;
}

const FUNCTIONS_BASE_URL = (import.meta.env.VITE_FUNCTIONS_BASE_URL || '').trim().replace(/\/+$/, '');

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const maybeRecord = payload as Record<string, unknown>;
  const message = maybeRecord.message || maybeRecord.error;
  return typeof message === 'string' && message.trim().length > 0 ? message : fallback;
}

export async function invokeBackendFunction<T = unknown>(
  functionName: string,
  options: InvokeOptions = {}
): Promise<InvokeResponse<T>> {
  if (!FUNCTIONS_BASE_URL) {
    const { data, error } = await supabase.functions.invoke<T>(functionName, options);
    return {
      data: data ?? null,
      error: error ? new Error(error.message) : null,
    };
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const endpoint = `${FUNCTIONS_BASE_URL}/${functionName}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (session?.access_token && !headers.Authorization) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }

    const response = await fetch(endpoint, {
      method: options.method || 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const fallback = `Function request failed (${response.status})`;
      return {
        data: payload as T | null,
        error: new Error(extractErrorMessage(payload, fallback)),
      };
    }

    return {
      data: payload as T,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error('Function request failed'),
    };
  }
}
