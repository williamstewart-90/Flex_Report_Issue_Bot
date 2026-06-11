// Slack chat.postMessage wrapper.
//
// Intentionally thin: just enough to post a markdown message to a channel,
// surface Slack's response shape, and retry once on rate limit.
//
// Why not the @slack/web-api SDK? Adds 4MB+ of deps for one HTTP endpoint.
// fetch() is fine.

const POST_URL = 'https://slack.com/api/chat.postMessage';

/**
 * Post a single markdown message to a Slack channel.
 *
 * @param {object} args
 * @param {string} args.token       Bot token (xoxb-...)
 * @param {string} args.channelId   Slack channel ID (e.g. "C0B7UGBJNQ3")
 * @param {string} args.text        Message text (Slack mrkdwn)
 * @param {string} [args.threadTs]  Optional parent message ts for threading
 * @returns {Promise<{ ok: true, ts: string, channel: string } | { ok: false, error: string, retryable: boolean }>}
 */
export async function postMessage({ token, channelId, text, threadTs }) {
  if (!token)     return { ok: false, error: 'missing_token',      retryable: false };
  if (!channelId) return { ok: false, error: 'missing_channel_id', retryable: false };
  if (!text)      return { ok: false, error: 'missing_text',       retryable: false };

  const body = {
    channel: channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
    ...(threadTs ? { thread_ts: threadTs } : {})
  };

  try {
    const res = await fetch(POST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });

    // Honour Slack's rate-limit response (HTTP 429 + Retry-After seconds).
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
      await sleep((retryAfter + 1) * 1000);
      return postMessage({ token, channelId, text, threadTs });
    }

    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      return { ok: true, ts: data.ts, channel: data.channel };
    }

    // Common Slack error codes we want to surface verbatim:
    //   not_in_channel       → bot wasn't invited to the channel
    //   channel_not_found    → channel id is wrong / private and bot missing
    //   invalid_auth         → bot token wrong / revoked
    //   token_revoked        → app uninstalled
    //   missing_scope        → bot needs chat:write or chat:write.public
    //   msg_too_long         → text > 40k chars (we should never hit this)
    const error = data.error || `http_${res.status}`;
    const retryable = error === 'service_unavailable' || error === 'fatal_error';
    return { ok: false, error, retryable };
  } catch (err) {
    return { ok: false, error: `fetch_failed: ${err.message || err}`, retryable: true };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
