

## Fix Frame.io OAuth 400 Error

### Problem
The Frame.io integration is failing with `Failed to get OAuth token: 400` because:
1. Your Adobe Developer Console only offers interactive OAuth types (Web App, SPA, Native App)
2. These don't support the `client_credentials` grant required for server-to-server automation
3. The current code only falls back to the developer token when OAuth credentials are **missing**, not when they **fail**

### Solution
Modify the edge function to gracefully fall back to the developer token when OAuth fails (not just when credentials are missing).

### Technical Changes

**1. Update `supabase/functions/frameio/index.ts`**

Modify the `getOAuthToken()` function to catch OAuth failures and fall back to the developer token:

```text
Current logic:
  IF no client_id/secret → use dev token
  ELSE → try OAuth (fails with 400)

New logic:
  IF no client_id/secret → use dev token
  ELSE → try OAuth
    IF OAuth fails → try dev token as fallback
    IF no fallback → throw error
```

The key change wraps the OAuth attempt in try/catch and falls back to `FRAMEIO_API_TOKEN` if OAuth fails for any reason.

### Files to Modify
- `supabase/functions/frameio/index.ts` - Update authentication fallback logic

### Alternative Consideration
If you want to stop using OAuth entirely and just use the developer token, you could also remove the `FRAMEIO_CLIENT_ID` and `FRAMEIO_CLIENT_SECRET` secrets. But implementing the fallback is safer because:
- It preserves the option to use OAuth later if you get Server-to-Server credentials
- It handles transient OAuth failures gracefully

