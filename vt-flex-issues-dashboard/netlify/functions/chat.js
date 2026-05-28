// Netlify Function: /.netlify/functions/chat
//
// Receives { messages: [...] } from the frontend, validates the caller's
// Supabase JWT, enforces a 30-msg/hour rate limit per email, calls the
// Anthropic Messages API (Claude Sonnet 4 + web_search tool), and returns
// the concatenated text content.
//
// Required env vars (set in Netlify Site configuration → Environment vars):
//   ANTHROPIC_API_KEY          - sk-ant-...
//   SUPABASE_URL               - https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  - sb_secret_... (service role; bypasses RLS)
//   SUPABASE_JWT_SECRET        - JWT signing secret (Supabase → Settings → API → JWT)
// Optional:
//   SYSTEM_PROMPT              - falls back to a one-liner if absent
//   CHAT_RATE_LIMIT_PER_HOUR   - default 30
//   ANTHROPIC_MODEL            - default claude-sonnet-4-20250514
//   ANTHROPIC_MAX_TOKENS       - default 1000

import { jwtVerify } from 'jose';

const SYSTEM_PROMPT_DEFAULT = 'You are the Flex Troubleshooting Assistant.';
const ANTHROPIC_URL         = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION     = '2023-06-01';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors },
    body:    JSON.stringify(body)
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // ---------- 1. Env sanity ----------
  const {
    ANTHROPIC_API_KEY,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET,
    SYSTEM_PROMPT
  } = process.env;

  const missing = [];
  if (!ANTHROPIC_API_KEY)         missing.push('ANTHROPIC_API_KEY');
  if (!SUPABASE_URL)              missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_JWT_SECRET)       missing.push('SUPABASE_JWT_SECRET');
  if (missing.length) {
    return json(500, { error: `Server misconfigured: missing ${missing.join(', ')}` });
  }

  const RATE_LIMIT = parseInt(process.env.CHAT_RATE_LIMIT_PER_HOUR || '30', 10);
  const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '1000', 10);

  // ---------- 2. Verify Supabase JWT ----------
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return json(401, { error: 'Missing Authorization: Bearer <token>' });
  }

  let userEmail;
  try {
    const secret = new TextEncoder().encode(SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      audience:   'authenticated'
    });
    userEmail = String(payload.email || '').toLowerCase().trim();
    if (!userEmail) {
      return json(401, { error: 'Token has no email claim' });
    }
  } catch (e) {
    return json(401, { error: 'Invalid or expired token' });
  }

  // ---------- 3. Parse body ----------
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return json(400, { error: 'Body must include non-empty `messages` array' });
  }
  // Defensive: clip absurdly long histories to avoid runaway costs.
  if (messages.length > 50) {
    return json(400, { error: 'Conversation history too long (max 50 turns)' });
  }

  // ---------- 4. Rate limit (Supabase) ----------
  const sb = {
    headers: {
      apikey:          SUPABASE_SERVICE_ROLE_KEY,
      Authorization:   `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json'
    }
  };

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/vt_flex_chat_usage?select=id&user_email=eq.${encodeURIComponent(userEmail)}&used_at=gte.${encodeURIComponent(since)}`,
    { headers: { ...sb.headers, Prefer: 'count=exact' } }
  );
  if (!countRes.ok) {
    return json(500, { error: `Rate-limit lookup failed (${countRes.status})` });
  }
  const contentRange = countRes.headers.get('content-range') || '*/0';
  const total = parseInt(contentRange.split('/')[1] || '0', 10);
  if (total >= RATE_LIMIT) {
    return json(429, {
      error: `Rate limit reached (${RATE_LIMIT} messages/hour). Try again in a bit.`,
      limit: RATE_LIMIT,
      used:  total
    });
  }

  // Record the request BEFORE calling Anthropic so a slow Claude response
  // can't be exploited by parallel requests racing the limit check.
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/vt_flex_chat_usage`, {
    method:  'POST',
    headers: sb.headers,
    body:    JSON.stringify([{ user_email: userEmail }])
  });
  if (!insertRes.ok) {
    return json(500, { error: `Rate-limit insert failed (${insertRes.status})` });
  }

  // ---------- 5. Call Anthropic ----------
  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type':      'application/json'
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT || SYSTEM_PROMPT_DEFAULT,
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
  } catch (e) {
    return json(502, { error: `Upstream fetch failed: ${e.message || e}` });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return json(anthropicRes.status, {
      error: `Anthropic API ${anthropicRes.status}`,
      detail: errText.slice(0, 500)
    });
  }

  const data = await anthropicRes.json();

  // Concatenate all text blocks. Web search may emit tool_use / server_tool_use
  // blocks too; we only surface the model's prose to the user.
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();

  return json(200, {
    text,
    stopReason: data.stop_reason || null,
    usage:      data.usage || null
  });
};
