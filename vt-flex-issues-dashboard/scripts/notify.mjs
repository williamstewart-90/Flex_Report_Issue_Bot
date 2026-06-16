// Manager-notification pipeline for new Flex issues.
//
// Exported as runNotifications({ supabase, dryRun, mockIssues }) and called
// from sync-issues.mjs at the end of a successful sync run.
//
// What it does, per run:
//   1. Find issues where notified_at IS NULL AND issue_created_at > now-24h
//      (the 24h window prevents a historical re-sync from blasting managers).
//   2. For each (capped at MAX_NOTIFICATIONS_PER_RUN):
//        - hydrate supervisors + recent_tasks + status_history
//        - build a slim triage payload (drop noise)
//        - call Anthropic with the existing knowledge base + auto-triage preamble
//        - send HTML + plaintext email via Gmail SMTP
//        - mark notified_at, log to vt_flex_notifications
//   3. Log the run summary to vt_flex_notification_runs.
//
// Shadow mode: if NOTIFICATIONS_FORCE_TO is set, every email routes to that
// address (regardless of supervisors on the issue). Flip live by unsetting it.
//
// Kill switch: NOTIFICATIONS_ENABLED=0 disables the entire pipeline.

import nodemailer from 'nodemailer';
import { SYSTEM_PROMPT as KNOWLEDGE_BASE } from '../netlify/functions/lib/system-prompt.js';
import { AUTO_TRIAGE_PREAMBLE } from './lib/auto-triage-preamble.js';

// ---------- Config ----------
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function getConfig() {
  return {
    enabled:             process.env.NOTIFICATIONS_ENABLED !== '0',
    forceTo:             (process.env.NOTIFICATIONS_FORCE_TO || '').trim(),
    fromEmail:           (process.env.NOTIFICATIONS_FROM_EMAIL || process.env.GMAIL_USER || '').trim(),
    gmailUser:           (process.env.GMAIL_USER || '').trim(),
    gmailAppPassword:    (process.env.GMAIL_APP_PASSWORD || '').trim(),
    anthropicApiKey:     (process.env.ANTHROPIC_API_KEY || '').trim(),
    // See post-to-slack.mjs for the rationale on the version pin.
    anthropicModel:      process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
    anthropicMaxTokens:  parseInt(process.env.ANTHROPIC_MAX_TOKENS || '1200', 10),
    maxPerRun:           parseInt(process.env.MAX_NOTIFICATIONS_PER_RUN || '25', 10),
    recencyHours:        parseInt(process.env.NOTIFICATIONS_RECENCY_HOURS || '24', 10)
  };
}

// ---------- Entry point ----------
export async function runNotifications({ supabase, dryRun = false, mockIssues = null }) {
  const startedAt = new Date().toISOString();
  const cfg       = getConfig();
  const shadow    = Boolean(cfg.forceTo);
  let issuesFound = 0;
  let emailsSent  = 0;
  let emailsFailed = 0;
  let runError    = null;

  if (!cfg.enabled) {
    console.log('[notify] NOTIFICATIONS_ENABLED=0 — skipping notification pipeline');
    return { issuesFound: 0, emailsSent: 0, emailsFailed: 0, shadow };
  }

  // Config sanity (only enforced when we'd actually call the APIs).
  const callingAnthropic = !process.env.STUB_TRIAGE_MD;  // STUB_TRIAGE_MD bypasses Anthropic for offline tests
  const callingSmtp      = !dryRun;                       // dry-run skips SMTP
  const missing = [];
  if (callingAnthropic && !cfg.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (callingSmtp && !cfg.gmailUser)            missing.push('GMAIL_USER');
  if (callingSmtp && !cfg.gmailAppPassword)     missing.push('GMAIL_APP_PASSWORD');
  if (callingSmtp && !cfg.fromEmail)            missing.push('NOTIFICATIONS_FROM_EMAIL');
  if (missing.length) {
    console.warn(`[notify] Skipping notifications, missing env: ${missing.join(', ')}`);
    return { issuesFound: 0, emailsSent: 0, emailsFailed: 0, shadow, skippedReason: 'missing_env' };
  }

  console.log(`[notify] Starting${dryRun ? ' (dry-run)' : ''}${shadow ? ' (shadow mode → ' + cfg.forceTo + ')' : ''}`);

  let transporter = null;
  if (callingSmtp) {
    transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   465,
      secure: true,
      auth:   { user: cfg.gmailUser, pass: cfg.gmailAppPassword }
    });
  }

  try {
    const issues = mockIssues
      ? mockIssues.slice(0, cfg.maxPerRun)
      : await fetchUnnotified(supabase, cfg);
    issuesFound = issues.length;
    console.log(`[notify] Found ${issuesFound} unnotified issue(s) in last ${cfg.recencyHours}h`);

    for (const issue of issues) {
      try {
        const result = await processIssue({
          issue, supabase, transporter, cfg, dryRun, shadow, mockMode: Boolean(mockIssues)
        });
        if (result.status === 'sent') emailsSent += 1;
        else if (result.status !== 'skipped') emailsFailed += 1;
      } catch (err) {
        emailsFailed += 1;
        console.error(`[notify] Unexpected error on issue ${issue.issue_id}:`, err?.message || err);
      }
    }
  } catch (err) {
    runError = String(err?.message || err).slice(0, 1000);
    console.error('[notify] Run failed:', err);
  }

  const completedAt = new Date().toISOString();
  await recordRun(supabase, dryRun, {
    started_at:    startedAt,
    completed_at:  completedAt,
    issues_found:  issuesFound,
    emails_sent:   emailsSent,
    emails_failed: emailsFailed,
    shadow_mode:   shadow,
    error_message: runError
  });

  console.log(`[notify] Done. found=${issuesFound} sent=${emailsSent} failed=${emailsFailed}`);
  return { issuesFound, emailsSent, emailsFailed, shadow };
}

// ---------- Fetchers ----------
async function fetchUnnotified(supabase, cfg) {
  if (!supabase) return [];
  const sinceIso = new Date(Date.now() - cfg.recencyHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('vt_flex_issues')
    .select('*')
    .is('notified_at', null)
    .eq('issue_type', 'technical_issue')
    .gte('issue_created_at', sinceIso)
    .order('issue_created_at', { ascending: true })
    .limit(cfg.maxPerRun);
  if (error) throw new Error(`fetchUnnotified: ${error.message}`);
  return data || [];
}

async function fetchChildren(supabase, issueId) {
  if (!supabase) return { supervisors: [], tasks: [], statusHistory: [] };
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
async function processIssue({ issue, supabase, transporter, cfg, dryRun, shadow, mockMode }) {
  const children = mockMode
    ? extractMockChildren(issue)
    : await fetchChildren(supabase, issue.issue_id);

  // Recipients
  const supervisorEmails = (children.supervisors || [])
    .map((s) => (s.supervisor_email || '').trim())
    .filter(Boolean);
  const recipients = shadow
    ? [cfg.forceTo]
    : (supervisorEmails.length ? supervisorEmails : (cfg.forceTo ? [cfg.forceTo] : []));

  if (!recipients.length) {
    console.warn(`[notify] No recipient for issue ${issue.issue_id} (no supervisors, no NOTIFICATIONS_FORCE_TO) — marking notified to avoid loop`);
    await markNotified(supabase, dryRun, issue.issue_id);
    await logNotification(supabase, dryRun, {
      issue_id:    issue.issue_id,
      recipients:  [],
      shadow_mode: shadow,
      subject:     subjectFor(issue),
      status:      'no_recipient',
      error:       null
    });
    return { status: 'no_recipient' };
  }

  // Build prompt + call Anthropic (or use a stub for offline rendering tests)
  let triageMd;
  try {
    triageMd = process.env.STUB_TRIAGE_MD
      ? process.env.STUB_TRIAGE_MD
      : await callAnthropic(cfg, issue, children);
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    console.error(`[notify] Anthropic failed for ${issue.issue_id}:`, msg);
    await logNotification(supabase, dryRun, {
      issue_id:    issue.issue_id,
      recipients,
      shadow_mode: shadow,
      subject:     subjectFor(issue),
      status:      'anthropic_failed',
      error:       msg
    });
    return { status: 'anthropic_failed' };
  }

  const subject = subjectFor(issue);
  const text    = buildPlaintext({ issue, triageMd, cfg });
  const html    = buildHtml({ issue, triageMd, cfg });

  if (dryRun) {
    console.log('────────────────────────────────────────────────────────');
    console.log(`[notify:dry-run] would send to: ${recipients.join(', ')}`);
    console.log(`[notify:dry-run] from: ${cfg.fromEmail}`);
    console.log(`[notify:dry-run] subject: ${subject}`);
    console.log('--- plaintext body ---');
    console.log(text);
    console.log('────────────────────────────────────────────────────────');
    return { status: 'sent' };  // count as success for dry-run reporting
  }

  try {
    await transporter.sendMail({
      from: cfg.fromEmail,
      to:   recipients.join(', '),
      subject,
      text,
      html
    });
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    console.error(`[notify] SMTP failed for ${issue.issue_id}:`, msg);
    await logNotification(supabase, dryRun, {
      issue_id:    issue.issue_id,
      recipients,
      shadow_mode: shadow,
      subject,
      status:      'smtp_failed',
      error:       msg
    });
    return { status: 'smtp_failed' };
  }

  await markNotified(supabase, dryRun, issue.issue_id);
  await logNotification(supabase, dryRun, {
    issue_id:    issue.issue_id,
    recipients,
    shadow_mode: shadow,
    subject,
    status:      'sent',
    error:       null
  });
  console.log(`[notify] Sent ${issue.issue_id} → ${recipients.join(', ')}`);
  return { status: 'sent' };
}

// ---------- Triage payload (slim, focused) ----------
// Exported so scripts/post-to-slack.mjs can reuse the exact same payload
// shape that the email pipeline sends to Claude. Single source of truth.
export function buildTriagePayload(issue, children) {
  return {
    issue_id: issue.issue_id,
    agent_description: issue.agent_description ?? null,
    network_diagnostics: {
      effective_type: issue.net_effective_type ?? null,
      downlink:       issue.net_downlink ?? null,
      rtt:            issue.net_rtt ?? null
    },
    hardware_config: {
      browser:                  issue.hw_browser ?? null,
      flex_version:             issue.hw_flex_version ?? null,
      os:                       issue.hw_os ?? null,
      timezone:                 issue.hw_timezone ?? null,
      audio_input:              issue.hw_audio_input ?? null,
      audio_output:             issue.hw_audio_output ?? null,
      permission_microphone:    issue.hw_permission_microphone ?? null,
      permission_notifications: issue.hw_permission_notifications ?? null,
      memory_limit_gb:          issue.hw_memory_limit_gb ?? null,
      memory_used_gb:           issue.hw_memory_used_gb ?? null
    },
    recent_tasks: (children.tasks || []).map((t) => ({
      task_sid:       t.task_sid,
      channel:        t.channel,
      skill:          t.skill,
      call_metrics: {
        call_state:           t.cm_call_state,
        processing_state:     t.cm_processing_state,
        who_hung_up:          t.cm_who_hung_up,
        from_carrier:         t.cm_from_carrier,
        to_carrier:           t.cm_to_carrier,
        edge_type:            t.cm_edge_type,
        inbound: {
          codec:           t.cm_inbound_codec,
          jitter_avg_ms:   t.cm_inbound_jitter_avg_ms,
          packet_loss_pct: t.cm_inbound_packet_loss_pct,
          latency_avg_ms:  t.cm_inbound_latency_avg_ms,
          rtt_avg_ms:      t.cm_inbound_rtt_avg_ms,
          mos_avg:         t.cm_inbound_mos_avg
        },
        outbound: {
          codec:           t.cm_outbound_codec,
          jitter_avg_ms:   t.cm_outbound_jitter_avg_ms,
          packet_loss_pct: t.cm_outbound_packet_loss_pct,
          latency_avg_ms:  t.cm_outbound_latency_avg_ms
        },
        tags: t.cm_tags
      },
      worker_call_metrics: {
        call_state:       t.wcm_call_state,
        processing_state: t.wcm_processing_state,
        who_hung_up:      t.wcm_who_hung_up,
        inbound: {
          jitter_avg_ms:   t.wcm_inbound_jitter_avg_ms,
          packet_loss_pct: t.wcm_inbound_packet_loss_pct,
          rtt_avg_ms:      t.wcm_inbound_rtt_avg_ms,
          mos_avg:         t.wcm_inbound_mos_avg
        },
        tags: t.wcm_tags
      }
    })),
    status_history: (children.statusHistory || []).map((h) => ({
      activity_name: h.activity_name,
      activity_at:   h.activity_at
    }))
  };
}

// ---------- Anthropic call ----------
// Exported. `cfg` only needs the anthropic* fields, so the Slack pipeline
// can construct a stub cfg with just those three to share this code.
export async function callAnthropic(cfg, issue, children) {
  const system = `${KNOWLEDGE_BASE}\n\n${AUTO_TRIAGE_PREAMBLE}`;
  const payload = buildTriagePayload(issue, children);
  const userMessage = [
    'A rep on your team just submitted a Flex issue report. Triage it now and produce a manager-ready email body.',
    '',
    `REP: ${issue.agent_name || 'unknown'} (${issue.worker_email || 'no email'})`,
    `TEAM: ${issue.team_name || 'unknown'}`,
    `SUBMITTED: ${issue.issue_created_at || 'unknown'}`,
    `PLUGIN VERSION: ${issue.plugin_version || 'unknown'}`,
    '',
    'ISSUE REPORT (JSON):',
    '```json',
    JSON.stringify(payload, null, 2),
    '```'
  ].join('\n');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key':         cfg.anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type':      'application/json'
    },
    body: JSON.stringify({
      model:      cfg.anthropicModel,
      max_tokens: cfg.anthropicMaxTokens,
      system,
      messages:   [{ role: 'user', content: userMessage }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
  if (!text) throw new Error('Anthropic returned no text content');
  return text;
}

// ---------- Email composition ----------
function subjectFor(issue) {
  const name    = (issue.agent_name || 'Unknown rep').trim();
  const symptom = (issue.agent_description || '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'New Flex issue';
  return `[Flex Issue] ${name} — ${symptom}`;
}

function buildPlaintext({ issue, triageMd }) {
  return [
    `Rep:        ${issue.agent_name || 'unknown'} (${issue.worker_email || 'no email'})`,
    `Team:       ${issue.team_name || 'unknown'}`,
    `Submitted:  ${issue.issue_created_at || 'unknown'}`,
    `Plugin:     ${issue.plugin_version || 'unknown'}`,
    '',
    '---',
    '',
    triageMd,
    '',
    '---',
    '',
    `Rep's own description: "${issue.agent_description || '(none provided)'}"`,
    '',
    '— Auto-generated by VT Flex Issues Bot. Reply to discuss with the team.'
  ].join('\n');
}

function buildHtml({ issue, triageMd }) {
  const triageHtml = markdownToHtml(triageMd);
  const desc       = escapeHtml(issue.agent_description || '(none provided)');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f9;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#111;background:#fff;">
    <div style="background:#f1f3f5;padding:14px 16px;border-radius:8px;margin-bottom:18px;font-size:14px;line-height:1.55;">
      <div><strong>Rep:</strong> ${escapeHtml(issue.agent_name || 'unknown')}${issue.worker_email ? ` &lt;${escapeHtml(issue.worker_email)}&gt;` : ''}</div>
      <div><strong>Team:</strong> ${escapeHtml(issue.team_name || 'unknown')}</div>
      <div><strong>Submitted:</strong> ${escapeHtml(issue.issue_created_at || 'unknown')}</div>
      <div><strong>Plugin:</strong> ${escapeHtml(issue.plugin_version || 'unknown')}</div>
    </div>

    <div style="border-left:3px solid #0a7cff;padding:2px 16px;margin:16px 0;">
      <div style="font-size:12px;letter-spacing:0.05em;text-transform:uppercase;color:#0a7cff;font-weight:600;margin-bottom:4px;">AI-generated triage</div>
      <div style="font-size:15px;line-height:1.55;">${triageHtml}</div>
    </div>

    <div style="background:#fff8e1;padding:12px 14px;border-radius:8px;margin:16px 0;font-size:14px;line-height:1.5;">
      <strong>Rep's own description:</strong><br>
      <em>"${desc}"</em>
    </div>

    <p style="font-size:11px;color:#999;margin:12px 0 0;">Auto-generated by VT Flex Issues Bot. Reply to discuss with the team.</p>
  </div>
</body></html>`;
}

// ---------- Tiny markdown converter ----------
// Scoped to the constrained output shape enforced by AUTO_TRIAGE_PREAMBLE:
// blank-line-separated blocks, **bold** inline, numbered lists (`1. ...`).
// Handles the common case of a bold header line followed by an inline list
// (no blank line between them), since that's exactly how the preamble formats
// "What your rep should do (in order):" + the numbered steps.
function markdownToHtml(md) {
  const blocks = md.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map(renderBlock).filter(Boolean).join('');
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');

  // Split into runs of "ordered-list lines" vs "prose lines" so a bold header
  // followed by `1. ...` items renders as <p>header</p><ol>...</ol>.
  const runs = [];
  let current = null;
  for (const line of lines) {
    const isItem = /^\s*\d+\.\s+/.test(line);
    const type = isItem ? 'ol' : 'p';
    if (!current || current.type !== type) {
      current = { type, lines: [line] };
      runs.push(current);
    } else {
      current.lines.push(line);
    }
  }

  return runs.map((run) => {
    if (run.type === 'ol') {
      const items = run.lines
        .map((l) => l.replace(/^\s*\d+\.\s+/, ''))
        .map((l) => `<li>${inlineMd(l)}</li>`)
        .join('');
      return `<ol style="margin:8px 0 8px 22px;padding:0;">${items}</ol>`;
    }
    return `<p style="margin:8px 0;">${run.lines.map(inlineMd).join('<br>')}</p>`;
  }).join('');
}

function inlineMd(s) {
  return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- DB writes (no-op in dry-run / mock mode) ----------
async function markNotified(supabase, dryRun, issueId) {
  if (dryRun || !supabase) return;
  const { error } = await supabase
    .from('vt_flex_issues')
    .update({ notified_at: new Date().toISOString() })
    .eq('issue_id', issueId);
  if (error) console.error(`[notify] markNotified ${issueId} failed: ${error.message}`);
}

async function logNotification(supabase, dryRun, row) {
  if (dryRun || !supabase) return;
  const { error } = await supabase.from('vt_flex_notifications').insert([row]);
  if (error) console.error(`[notify] logNotification failed: ${error.message}`);
}

async function recordRun(supabase, dryRun, row) {
  if (dryRun || !supabase) return;
  const { error } = await supabase.from('vt_flex_notification_runs').insert([row]);
  if (error) console.error(`[notify] recordRun failed: ${error.message}`);
}

// ---------- Mock-mode helpers ----------
// When mockIssues is supplied (test-notification or MOCK_API+DRY_RUN), the
// children come embedded on the raw API object rather than from Supabase.
function extractMockChildren(issue) {
  // mockIssues entries can be either:
  //  - a flat row already shaped like the Supabase row (children passed alongside), or
  //  - a raw API-shaped issue with .supervisors and .report.{recent_tasks,status_history}
  if (issue.__children) return issue.__children;
  const raw = issue.__raw || issue;
  const supervisors = (raw.supervisors || []).map((s) => ({
    supervisor_worker_sid: s.worker_sid,
    supervisor_email:      s.email
  }));
  const tasks = (raw.report?.recent_tasks || []).map((t, idx) => ({
    task_order: idx,
    task_sid: t.task_sid,
    channel: t.channel,
    skill: t.skill,
    cm_call_state:           t.call_metrics?.call_state,
    cm_processing_state:     t.call_metrics?.processing_state,
    cm_who_hung_up:          t.call_metrics?.who_hung_up,
    cm_from_carrier:         t.call_metrics?.from?.carrier,
    cm_to_carrier:           t.call_metrics?.to?.carrier,
    cm_edge_type:            t.call_metrics?.edge?.edge_type,
    cm_inbound_codec:        t.call_metrics?.edge?.inbound?.codec,
    cm_inbound_jitter_avg_ms:   t.call_metrics?.edge?.inbound?.jitter_avg_ms,
    cm_inbound_packet_loss_pct: t.call_metrics?.edge?.inbound?.packet_loss_pct,
    cm_inbound_latency_avg_ms:  t.call_metrics?.edge?.inbound?.latency_avg_ms,
    cm_inbound_rtt_avg_ms:      t.call_metrics?.edge?.inbound?.rtt_avg_ms,
    cm_inbound_mos_avg:         t.call_metrics?.edge?.inbound?.mos_avg,
    cm_outbound_codec:          t.call_metrics?.edge?.outbound?.codec,
    cm_outbound_latency_avg_ms: t.call_metrics?.edge?.outbound?.latency_avg_ms,
    cm_outbound_jitter_avg_ms:  t.call_metrics?.edge?.outbound?.jitter_avg_ms,
    cm_outbound_packet_loss_pct: t.call_metrics?.edge?.outbound?.packet_loss_pct,
    cm_tags: t.call_metrics?.tags,
    wcm_call_state:       t.worker_call_metrics?.call_state,
    wcm_processing_state: t.worker_call_metrics?.processing_state,
    wcm_who_hung_up:      t.worker_call_metrics?.who_hung_up,
    wcm_inbound_jitter_avg_ms:   t.worker_call_metrics?.edge?.inbound?.jitter_avg_ms,
    wcm_inbound_packet_loss_pct: t.worker_call_metrics?.edge?.inbound?.packet_loss_pct,
    wcm_inbound_rtt_avg_ms:      t.worker_call_metrics?.edge?.inbound?.rtt_avg_ms,
    wcm_inbound_mos_avg:         t.worker_call_metrics?.edge?.inbound?.mos_avg,
    wcm_tags: t.worker_call_metrics?.tags
  }));
  const statusHistory = (raw.report?.status_history || []).map((h, idx) => ({
    status_order:  idx,
    activity_name: h.activity_name,
    activity_at:   h.timestamp
  }));
  return { supervisors, tasks, statusHistory };
}

// ---------- Flat-row helper for mock mode ----------
// sync-issues.mjs already calls flattenIssue() before handing rows to us in
// MOCK mode, but tests may want to feed raw API issues directly. Export this
// shim so callers can construct the issue object easily.
export function mockIssueFromRaw(raw, flattenIssueFn) {
  const flat = flattenIssueFn(raw);
  return { ...flat, __raw: raw };
}

// Exposed for offline rendering tests (see scripts/inspect-html.mjs if you
// want to eyeball the email shell). Not part of the runtime path.
export const __renderers = { buildHtml, buildPlaintext, markdownToHtml, subjectFor };
