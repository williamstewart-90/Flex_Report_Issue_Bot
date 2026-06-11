// Slack message-posting wrapper.
//
// Supports two transports:
//   1. Incoming webhook (POST https://hooks.slack.com/services/T.../B.../...)
//      Auth = the URL itself. One channel per URL. Returns "ok" with no ts.
//      Works in workspaces where bot-token apps require admin install
//      approval, because the webhook is approved at the time of creation.
//   2. chat.postMessage (POST https://slack.com/api/chat.postMessage)
//      Auth = bot token. Many channels per token. Returns ts (needed for
//      threaded replies later).
//
// Webhook wins when both are present. The pipeline can then transition
// from one to the other simply by adding/removing the SLACK_WEBHOOK_URL
// secret in GitHub Actions — no code change required.

const CHAT_POST_URL = 'https://slack.com/api/chat.postMessage';

/**
 * Post a single markdown message to a Slack channel.
 *
 * @param {object} args
 * @param {string} [args.webhookUrl]  Incoming webhook URL. Wins if set.
 * @param {string} [args.token]       Bot token (xoxb-...). Used iff no webhook.
 * @param {string} [args.channelId]   Channel ID (e.g. "C0B7UGBJNQ3"). Required for bot token.
 * @param {string} args.text          Message text (Slack mrkdwn).
 * @param {string} [args.threadTs]    Parent message ts for threading. Bot token only.
 * @returns {Promise<{ ok: true, ts: string|null, channel: string|null } | { ok: false, error: string, retryable: boolean }>}
 */
export async function postMessage({ webhookUrl, token, channelId, text, threadTs }) {
  if (!text) return { ok: false, error: 'missing_text', retryable: false };

  if (webhookUrl) {
    return postViaWebhook(webhookUrl, text);
  }

  if (!token)     return { ok: false, error: 'missing_token_or_webhook', retryable: false };
  if (!channelId) return { ok: false, error: 'missing_channel_id',       retryable: false };

  return postViaChatPostMessage({ token, channelId, text, threadTs });
}

async function postViaWebhook(url, text) {
  const body = { text, unfurl_links: false, unfurl_media: false };
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify(body)
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
      await sleep((retryAfter + 1) * 1000);
      return postViaWebhook(url, text);
    }

    // Webhooks return plain text: "ok" on success, a short error string otherwise
    // (e.g. "invalid_payload", "channel_not_found", "no_service", "no_team").
    const respBody = (await res.text()).trim();
    if (res.ok && respBody === 'ok') {
      // Webhooks don't surface ts or channel id. NULL is fine — message_ts
      // and channel_id are both nullable in vt_flex_slack_posts.
      return { ok: true, ts: null, channel: null };
    }

    const error     = respBody || `http_${res.status}`;
    const retryable = res.status >= 500;
    return { ok: false, error, retryable };
  } catch (err) {
    return { ok: false, error: `webhook_fetch_failed: ${err.message || err}`, retryable: true };
  }
}

async function postViaChatPostMessage({ token, channelId, text, threadTs }) {
  const body = {
    channel:      channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
    ...(threadTs ? { thread_ts: threadTs } : {})
  };

  try {
    const res = await fetch(CHAT_POST_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
      await sleep((retryAfter + 1) * 1000);
      return postViaChatPostMessage({ token, channelId, text, threadTs });
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
    const error     = data.error || `http_${res.status}`;
    const retryable = error === 'service_unavailable' || error === 'fatal_error';
    return { ok: false, error, retryable };
  } catch (err) {
    return { ok: false, error: `fetch_failed: ${err.message || err}`, retryable: true };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
