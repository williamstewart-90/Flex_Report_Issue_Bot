-- ============================================================
-- 004_slack_posts.sql
-- Slack manager-notification route.
--
-- Parallels 003_notifications.sql but for Slack:
--   - Adds vt_flex_issues.slack_posted_at (separate watermark from notified_at
--     so an issue can land in BOTH email and Slack independently)
--   - vt_flex_slack_runs:  per-run audit log (mirror of notification_runs)
--   - vt_flex_slack_posts: per-message audit log (mirror of notifications)
--   - RLS via vt_flex_caller_allowed() (same gate as 002/003)
--
-- Re-runnable: all DDL is IF NOT EXISTS / DROP-IF-EXISTS guarded.
-- ============================================================

-- ---------- Add slack_posted_at watermark on issues ----------
ALTER TABLE vt_flex_issues
  ADD COLUMN IF NOT EXISTS slack_posted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN vt_flex_issues.slack_posted_at IS
  'Set after the Slack pipeline successfully posts (or deliberately skips) this issue. NULL = eligible for posting (subject to the recency window in post-to-slack.mjs). Independent of notified_at so email + Slack can run side by side.';

-- Partial index makes "find unposted issues" trivially cheap. We always
-- order by issue_created_at, so include it in the index.
CREATE INDEX IF NOT EXISTS idx_issues_unposted_slack
  ON vt_flex_issues (issue_created_at)
  WHERE slack_posted_at IS NULL;

-- ---------- Per-run audit log ----------
CREATE TABLE IF NOT EXISTS vt_flex_slack_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL,
  issues_found    INTEGER NOT NULL,
  posts_sent      INTEGER NOT NULL,
  posts_skipped   INTEGER NOT NULL,    -- filtered out by classifier
  posts_failed    INTEGER NOT NULL,
  channel_id      TEXT NULL,
  error_message   TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_runs_started
  ON vt_flex_slack_runs (started_at DESC);

-- ---------- Per-message audit log ----------
-- One row per issue we evaluated, whether we posted or skipped. This is the
-- source of truth for "what would the filter do" — keep it forever; spike
-- weeks will tune the classifier off this log.
CREATE TABLE IF NOT EXISTS vt_flex_slack_posts (
  id             BIGSERIAL PRIMARY KEY,
  issue_id       UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  posted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel_id     TEXT NULL,                 -- NULL if status='skipped_filtered'
  message_ts     TEXT NULL,                 -- Slack ts; NULL if we didn't post
  status         TEXT NOT NULL,             -- 'posted' | 'skipped_filtered' | 'anthropic_failed' | 'slack_failed'
  filter_hits    TEXT[] NULL,               -- which classifier rules matched (if any)
  agent_name     TEXT NULL,
  agent_email    TEXT NULL,
  team_name      TEXT NULL,
  description    TEXT NULL,                 -- agent_description verbatim, for audit/tuning
  error          TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_posts_issue
  ON vt_flex_slack_posts (issue_id);
CREATE INDEX IF NOT EXISTS idx_slack_posts_posted_at
  ON vt_flex_slack_posts (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_posts_status
  ON vt_flex_slack_posts (status);

-- ---------- RLS: allowlisted users can read the audit logs ----------
-- Service role bypasses RLS so post-to-slack.mjs writes through unaffected.
ALTER TABLE vt_flex_slack_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_slack_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_allowlisted_slack_runs" ON vt_flex_slack_runs;
CREATE POLICY "read_allowlisted_slack_runs"
  ON vt_flex_slack_runs
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

DROP POLICY IF EXISTS "read_allowlisted_slack_posts" ON vt_flex_slack_posts;
CREATE POLICY "read_allowlisted_slack_posts"
  ON vt_flex_slack_posts
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());
