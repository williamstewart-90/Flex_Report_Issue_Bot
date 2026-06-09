-- ============================================================
-- 003_notifications.sql
-- Auto-email manager triage for new Flex issues.
--
-- - Adds vt_flex_issues.notified_at (idempotency watermark)
-- - vt_flex_notification_runs: per-run audit log
-- - vt_flex_notifications:     per-email audit log
-- - RLS via the same vt_flex_caller_allowed() gate as 002
--
-- Re-runnable: all DDL is IF NOT EXISTS / DROP-IF-EXISTS guarded.
-- ============================================================

-- ---------- Add notified_at watermark on issues ----------
ALTER TABLE vt_flex_issues
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN vt_flex_issues.notified_at IS
  'Set after the manager-notification pipeline successfully emails for this issue. NULL = eligible for notification (subject to the 24h recency window in notify.mjs).';

-- Partial index makes "find unnotified issues" trivially cheap
-- regardless of total row count. We always order by issue_created_at,
-- so include it in the index.
CREATE INDEX IF NOT EXISTS idx_issues_unnotified
  ON vt_flex_issues (issue_created_at)
  WHERE notified_at IS NULL;

-- ---------- Per-run audit log ----------
CREATE TABLE IF NOT EXISTS vt_flex_notification_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL,
  issues_found    INTEGER NOT NULL,
  emails_sent     INTEGER NOT NULL,
  emails_failed   INTEGER NOT NULL,
  shadow_mode     BOOLEAN NOT NULL,
  error_message   TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_runs_started
  ON vt_flex_notification_runs (started_at DESC);

-- ---------- Per-email audit log ----------
CREATE TABLE IF NOT EXISTS vt_flex_notifications (
  id          BIGSERIAL PRIMARY KEY,
  issue_id    UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipients  TEXT[] NOT NULL,
  shadow_mode BOOLEAN NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL,    -- 'sent' | 'anthropic_failed' | 'smtp_failed' | 'no_recipient' | 'skipped'
  error       TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_issue
  ON vt_flex_notifications (issue_id);
CREATE INDEX IF NOT EXISTS idx_notifications_sent_at
  ON vt_flex_notifications (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status
  ON vt_flex_notifications (status);

-- ---------- RLS: allowlisted users can read the audit logs ----------
-- Service role bypasses RLS so notify.mjs writes through unaffected.
ALTER TABLE vt_flex_notification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_notifications     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_allowlisted_notification_runs" ON vt_flex_notification_runs;
CREATE POLICY "read_allowlisted_notification_runs"
  ON vt_flex_notification_runs
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

DROP POLICY IF EXISTS "read_allowlisted_notifications" ON vt_flex_notifications;
CREATE POLICY "read_allowlisted_notifications"
  ON vt_flex_notifications
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());
