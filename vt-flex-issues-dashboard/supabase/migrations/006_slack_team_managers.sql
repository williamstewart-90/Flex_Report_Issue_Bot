-- ============================================================
-- 006_slack_team_managers.sql
-- Pivot manager @mentions from "supervisor email" to "team_name".
--
-- Why: vt_flex_issues.team_name (e.g. "Kimberly Murdock") is the
-- rep's actual manager. The supervisor list from the Twilio worker
-- attributes is a wider matrix (multiple people per rep, often
-- including peer / escalation supervisors) — too noisy for an @mention.
--
-- - Drops vt_flex_slack_user_map (added in 005, never seeded).
-- - Adds vt_flex_slack_team_managers keyed on team_name.
-- - Replaces vt_flex_slack_posts.unmapped_supervisor_emails (TEXT[])
--   with vt_flex_slack_posts.unmapped_team_name (TEXT) — at most one
--   team per issue, so a scalar is the right shape.
--
-- Re-runnable: all DDL is IF (NOT) EXISTS / DROP-IF-EXISTS guarded.
-- ============================================================

DROP TABLE IF EXISTS vt_flex_slack_user_map;

CREATE TABLE IF NOT EXISTS vt_flex_slack_team_managers (
  team_name       TEXT PRIMARY KEY,
  slack_user_id   TEXT NOT NULL,
  display_name    TEXT NULL,
  email           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vt_flex_slack_team_managers IS
  'Maps vt_flex_issues.team_name -> the team manager''s Slack member ID for @mentioning on Flex issue posts. Seed by hand: in Slack desktop, click avatar -> View profile -> "..." menu -> Copy member ID.';

CREATE INDEX IF NOT EXISTS idx_slack_team_managers_user_id
  ON vt_flex_slack_team_managers (slack_user_id);

ALTER TABLE vt_flex_slack_team_managers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_allowlisted_slack_team_managers" ON vt_flex_slack_team_managers;
CREATE POLICY "read_allowlisted_slack_team_managers"
  ON vt_flex_slack_team_managers
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

-- ---------- Migrate audit column shape ----------
-- One team per issue, so unmapped is a scalar (TEXT) not an array.
ALTER TABLE vt_flex_slack_posts
  DROP COLUMN IF EXISTS unmapped_supervisor_emails,
  ADD COLUMN IF NOT EXISTS unmapped_team_name TEXT NULL;

COMMENT ON COLUMN vt_flex_slack_posts.unmapped_team_name IS
  'The issue''s team_name if it had no row in vt_flex_slack_team_managers at post time. NULL when the team was mapped (mention fired) or when team_name itself was NULL on the issue. Work-queue query: SELECT DISTINCT unmapped_team_name FROM vt_flex_slack_posts WHERE unmapped_team_name IS NOT NULL AND posted_at > NOW() - INTERVAL ''7 days'';';
