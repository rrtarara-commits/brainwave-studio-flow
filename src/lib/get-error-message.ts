export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const msg = (err.message || '').trim();
    return msg.length > 0 ? msg : fallback;
  }

  if (typeof err === 'string') {
    const msg = err.trim();
    return msg.length > 0 ? msg : fallback;
  }

  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;

    // Common Supabase / PostgREST / Storage error shapes
    const message =
      rec.message ??
      rec.error_description ??
      rec.error ??
      rec.msg ??
      rec.hint ??
      rec.details;

    if (typeof message === 'string') {
      const msg = message.trim();
      return msg.length > 0 ? msg : fallback;
    }
  }

  return fallback;
}

