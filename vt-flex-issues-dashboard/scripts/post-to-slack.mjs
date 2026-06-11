#!/usr/bin/env node
// Slack post pipeline.
//
// Runs hourly from GitHub Actions (after sync + after notify). For each new
// technical issue:
//   1. Classify it (issue-filter.mjs).
//   2. If FILTERED (Prof Certs / PC / Client / CS): mark slack_posted_at,
//      log an audit row with status='skipped_filtered', move on. No Claude
//      call, no Slack post — these are not actionable by managers.
//   3. If ACTIONABLE: hydrate supervisors/tasks/history, call Anthropic
//      with the SAME prompt the email pipeline uses, format Slack mrkdwn,
//      post to SLACK_CHANNEL_ID, mark slack_posted_at, log audit row.
//   4. Log a run summary to vt_flex_slack_runs.
//
// Idempotency: slack_posted_at is the watermark. Filtered issues also get
// stamped so we never re-classify the same row.
//
// Kill switch: SLACK_ENABLED=0 short-circuits the whole thing.

import { createClient } from '@supabase/supabase-js';
import { buildTriagePayload, callAnthropic } from './notify.mjs';
import { classifyIssue } from './lib/issue-filter.mjs';
import { postMessage as slackPostMessage } from './lib/slack-client.mjs';

// ---------- Config ----------
function getConfig() {
  return {
    enabled:            process.env.SLACK_ENABLED !== '0',
    slackBotToken:      (process.env.SLACK_BOT_TOKEN || '').trim(),
    slackChannelId:     (process.env.SLACK_CHANNEL_ID || '').trim(),
    supabaseUrl:        process.env.SUPABASE_URL,
    supabaseKey:        process.env.SUPABASE_SERVICE_ROLE_KEY,
    anthropicApiKey:    (process.env.ANTHROPIC_API_KEY || '').trim(),
    anthropicModel:     process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    anthropicMaxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '1200', 10),
    maxPerRun:          parseInt(process.env.MAX_SLACK_POSTS_PER_RUN || '25', 10),
    recencyHours:       parseInt(process.env.SLACK_RECENCY_HOURS || '24', 10),
    dryRun:             process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
  };
}

// ---------- Entry point ----------
async function main() {
  const startedAt = new Date().toISOString();
  const cfg = getConfig();

  if (!cfg.enabled) {
    console.log('[slack] SLACK_ENABLED=0 — skipping Slack pipeline');
    return;
  }

  const missing = [];
  if (!cfg.supabaseUrl)     missing.push('SUPABASE_URL');
  if (!cfg.supabaseKey)     missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!cfg.slackBotToken)   missing.push('SLACK_BOT_TOKEN');
  if (!cfg.slackChannelId)  missing.push('SLACK_CHANNEL_ID');
  if (!cfg.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    console.warn(`[slack] Skipping, missing env: ${missing.join(', ')}`);
    return;
  }

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false }
  });

  console.log(`[slack] Starting${cfg.dryRun ? ' (dry-run)' : ''} → channel ${cfg.slackChannelId}`);

  let issuesFound  = 0;
  let postsSent    = 0;
  let postsSkipped = 0;
  let postsFailed  = 0;
  let runError     = null;

  try {
    const issues = await fetchUnposted(supabase, cfg);
    issuesFound = issues.length;
    console.log(`[slack] Found ${issuesFound} unposted issue(s) in last ${cfg.recencyHours}h`);

    for (const issue of issues) {
      try {
        const result = await processIssue({ issue, supabase, cfg });
        if (result.status === 'posted')                postsSent    += 1;
        else if (result.status === 'skipped_filtered') postsSkipped += 1;
        else                                            postsFailed  += 1;
      } catch (err) {
        postsFailed += 1;
        console.error(`[slack] Unexpected error on ${issue.issue_id}:`, err?.message || err);
      }
    }
  } catch (err) {
    runError = String(err?.message || err).slice(0, 1000);
    console.error('[slack] Run failed:', err);
  }

  const completedAt = new Date().toISOString();
  await recordRun(supabase, cfg, {
    started_at:    startedAt,
    completed_at:  completedAt,
    issues_found:  issuesFound,
    posts_sent:    postsSent,
    posts_skipped: postsSkipped,
    posts_failed:  postsFailed,
    channel_id:    cfg.slackChannelId,
    error_message: runError
  });

  console.log(`[slack] Done. found=${issuesFound} posted=${postsSent} skipped=${postsSkipped} failed=${postsFailed}`);
}

// ---------- Fetchers ----------
async function fetchUnposted(supabase, cfg) {
  const sinceIso = new Date(Date.now() - cfg.recencyHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('vt_flex_issues')
    .select('*')
    .is('slack_posted_at', null)
    .eq('issue_type', 'technical_issue')
    .gte('issue_created_at', sinceIso)
    .order('issue_created_at', { ascending: true })
    .limit(cfg.maxPerRun);
  if (error) throw new Error(`fetchUnposted: ${error.message}`);
  return data || [];
}

async function fetchChildren(supabase, issueId) {
  const [sup, tasks, hist] = await Promise.all([
    supabase.from('vt_flex_issue_supervisors').select('*').eq('issue_id', issueId),
    supabase.from('vt_flex_recent_tasks').select('*').eq('issue_id', issueId).order('task_order', { ascending: true }),
    supabase.from('vt_flex_status_history').select('*').eq('issue_id', issueId).order('status_order', { ascending: true })
  ]);
  if (sup.error)   throw new Error(`fetch supervisors: ${sup.error.message}`);
  if (tasks.error) throw new Error(`fetch tasks: ${tasks.error.message}`);
  if (hist.error)  throw new Error(`fetch status_history: ${hist.error.message}`);
  return {
    supervisors:   sup.data || [],
    tasks:         tasks.data || [],
    statusHistory: hist.data || []
  };
}

// ---------- Per-issue pipeline ----------
async function processIssue({ issue, supabase, cfg }) {
  const auditBase = {
    issue_id:    issue.issue_id,
    channel_id:  cfg.slackChannelId,
    agent_name:  issue.agent_name || null,
    agent_email: issue.worker_email || null,
    team_name:   issue.team_name || null,
    description: issue.agent_description || null
  };

  // 1. Classify. Filtered issues are stamped + audited but never posted.
  const { filtered, hits } = classifyIssue(issue.agent_description);
  if (filtered) {
    console.log(`[slack] SKIP ${issue.issue_id} (${issue.agent_name}) — filtered: ${hits.join(', ')}`);
    await markPosted(supabase, cfg, issue.issue_id);
    await logPost(supabase, cfg, {
      ...auditBase,
      channel_id:  null,
      message_ts:  null,
      status:      'skipped_filtered',
      filter_hits: hits,
      error:       null
    });
    return { status: 'skipped_filtered' };
  }

  // 2. Hydrate + call Anthropic (same prompt as email).
  let children, triageMd;
  try {
    children = await fetchChildren(supabase, issue.issue_id);
    triageMd = await callAnthropic(
      {
        anthropicApiKey:    cfg.anthropicApiKey,
        anthropicModel:     cfg.anthropicModel,
        anthropicMaxTokens: cfg.anthropicMaxTokens
      },
      issue,
      children
    );
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    console.error(`[slack] Anthropic failed ${issue.issue_id}: ${msg}`);
    await logPost(supabase, cfg, {
      ...auditBase,
      message_ts:  null,
      status:      'anthropic_failed',
      filter_hits: null,
      error:       msg
    });
    return { status: 'anthropic_failed' };
  }

  // 3. Format + post to Slack.
  const text = buildSlackMessage(issue, triageMd);

  if (cfg.dryRun) {
    console.log('────────────────────────────────────────────────────────');
    console.log(`[slack:dry-run] would post to ${cfg.slackChannelId}`);
    console.log(text);
    console.log('────────────────────────────────────────────────────────');
    await logPost(supabase, cfg, {
      ...auditBase,
      message_ts:  null,
      status:      'posted',          // count dry-runs as posted for reporting
      filter_hits: null,
      error:       null
    });
    return { status: 'posted' };
  }

  const slackRes = await slackPostMessage({
    token:     cfg.slackBotToken,
    channelId: cfg.slackChannelId,
    text
  });

  if (!slackRes.ok) {
    console.error(`[slack] Slack post failed ${issue.issue_id}: ${slackRes.error}`);
    await logPost(supabase, cfg, {
      ...auditBase,
      message_ts:  null,
      status:      'slack_failed',
      filter_hits: null,
      error:       slackRes.error
    });
    return { status: 'slack_failed' };
  }

  await markPosted(supabase, cfg, issue.issue_id);
  await logPost(supabase, cfg, {
    ...auditBase,
    message_ts:  slackRes.ts,
    status:      'posted',
    filter_hits: null,
    error:       null
  });
  console.log(`[slack] POSTED ${issue.issue_id} → ts=${slackRes.ts}`);
  return { status: 'posted' };
}

// ---------- Slack message formatter ----------
// Slack mrkdwn dialect: *bold* (single asterisks), _italic_, `code`, > quote.
// Lists are rendered as plain text with leading "1. " / "• ". The triage
// markdown from Claude uses **bold** (double asterisks) per the email
// preamble, so we convert it down to *bold* here. Numbered lists are kept
// as-is — Slack renders them as monospace-leading text, which is fine.
function buildSlackMessage(issue, triageMd) {
  const headerLines = [
    `:rotating_light: *[Flex Issue]  ${escapeMrkdwn(issue.agent_name || 'Unknown rep')} — ${escapeMrkdwn(snippet(issue.agent_description, 80))}*`,
    `> *Rep:* ${escapeMrkdwn(issue.agent_name || 'unknown')}${issue.worker_email ? ` ‹${escapeMrkdwn(issue.worker_email)}›` : ''}`,
    `> *Team:* ${escapeMrkdwn(issue.team_name || 'unknown')}    *Submitted:* ${escapeMrkdwn(formatTimestamp(issue.issue_created_at))}    *Plugin:* ${escapeMrkdwn(issue.plugin_version || 'unknown')}`
  ];

  const repDescription = [
    `*Rep's own description:*`,
    `> _"${escapeMrkdwn(issue.agent_description || '(none provided)')}"_`
  ];

  const triage = mdToSlack(triageMd);

  // Slack chat.postMessage hard caps at 40000 chars; the section block at
  // 3000. We're well under both in practice. Belt-and-suspenders truncate.
  const full = [...headerLines, '', ...repDescription, '', triage].join('\n');
  return full.length > 39000 ? full.slice(0, 38990) + '\n…(truncated)' : full;
}

// Convert Claude's **bold** to Slack's *bold*, and -- to em dash (cosmetic).
function mdToSlack(md) {
  if (!md) return '';
  return String(md)
    // Bold: **x** → *x*. Slack uses single asterisks for bold.
    .replace(/\*\*([^*]+)\*\*/g, '*$1*');
}

function snippet(s, n) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

// Slack mrkdwn requires escaping <, >, &. Stars/underscores/backticks are
// formatting characters that users may legitimately want literal — but in
// practice the rep descriptions don't use them, so this is a light-touch
// escape that won't double-process Claude's intentional *bold* markup.
function escapeMrkdwn(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTimestamp(iso) {
  if (!iso) return 'unknown';
  try {
    const d = new Date(iso);
    // Format roughly like "Wed Jun 11 2026, 12:34 PM CDT" but keep it short.
    return d.toLocaleString('en-US', {
      timeZone:    'America/Chicago',
      weekday:     'short',
      month:       'short',
      day:         'numeric',
      hour:        'numeric',
      minute:      '2-digit',
      timeZoneName: 'short'
    });
  } catch {
    return iso;
  }
}

// ---------- DB writes ----------
async function markPosted(supabase, cfg, issueId) {
  if (cfg.dryRun) return;
  const { error } = await supabase
    .from('vt_flex_issues')
    .update({ slack_posted_at: new Date().toISOString() })
    .eq('issue_id', issueId);
  if (error) console.error(`[slack] markPosted ${issueId} failed: ${error.message}`);
}

async function logPost(supabase, cfg, row) {
  if (cfg.dryRun) return;
  const { error } = await supabase.from('vt_flex_slack_posts').insert([row]);
  if (error) console.error(`[slack] logPost failed: ${error.message}`);
}

async function recordRun(supabase, cfg, row) {
  if (cfg.dryRun) return;
  const { error } = await supabase.from('vt_flex_slack_runs').insert([row]);
  if (error) console.error(`[slack] recordRun failed: ${error.message}`);
}

// ---------- Run ----------
main().catch((err) => {
  console.error('[slack] FATAL:', err);
  process.exit(1);
});
