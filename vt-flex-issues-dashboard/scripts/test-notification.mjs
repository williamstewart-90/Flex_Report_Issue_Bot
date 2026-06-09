#!/usr/bin/env node
// Re-run the manager-notification pipeline against a single issue_id.
//
// Usage:
//   node test-notification.mjs <issue_id>                 # dry-run (no SMTP, no DB writes)
//   FORCE_SEND=1 node test-notification.mjs <issue_id>    # actually send email + mark notified
//
// Pulls the issue from Supabase, ignores notified_at + the 24h recency filter,
// then runs the full triage + email flow. Useful for spot-testing prompt tweaks
// against a real incident.

import { createClient } from '@supabase/supabase-js';
import { runNotifications } from './notify.mjs';

const issueId = (process.argv[2] || '').trim();
if (!issueId) {
  console.error('Usage: node test-notification.mjs <issue_id> [FORCE_SEND=1]');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const FORCE_SEND = process.env.FORCE_SEND === '1' || process.env.FORCE_SEND === 'true';
const dryRun = !FORCE_SEND;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Fetch the target issue and its children directly (bypass notify.mjs's
// 24h + notified_at filter so we can re-test any historical issue).
const { data: issue, error } = await supabase
  .from('vt_flex_issues')
  .select('*')
  .eq('issue_id', issueId)
  .single();
if (error || !issue) {
  console.error(`Issue ${issueId} not found:`, error?.message || 'no rows');
  process.exit(1);
}

const [{ data: supervisors }, { data: tasks }, { data: history }] = await Promise.all([
  supabase.from('vt_flex_issue_supervisors').select('*').eq('issue_id', issueId),
  supabase.from('vt_flex_recent_tasks').select('*').eq('issue_id', issueId).order('task_order', { ascending: true }),
  supabase.from('vt_flex_status_history').select('*').eq('issue_id', issueId).order('status_order', { ascending: true })
]);

console.log(`[test] Loaded ${issueId}: rep=${issue.agent_name}, supervisors=${supervisors?.length || 0}, tasks=${tasks?.length || 0}`);
console.log(`[test] Mode: ${dryRun ? 'DRY-RUN (set FORCE_SEND=1 to actually send)' : 'LIVE — will send email + mark notified_at'}`);

await runNotifications({
  supabase: dryRun ? null : supabase,
  dryRun,
  mockIssues: [{
    ...issue,
    __children: {
      supervisors:   supervisors || [],
      tasks:         tasks || [],
      statusHistory: history || []
    }
  }]
});
