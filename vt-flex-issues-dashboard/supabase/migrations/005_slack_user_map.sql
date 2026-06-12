-- ============================================================
-- 005_slack_user_map.sql
-- Manager @mentions for Slack posts.
--
-- - vt_flex_slack_user_map: email → Slack user ID map. Hand-seeded
--   (Slack incoming-webhook auth has no users.lookupByEmail; that
--   requires the users:read.email bot scope, which is still pending
--   admin approval as of this migration).
-- - vt_flex_slack_posts gains two columns to audit who got mentioned
--   and which supervisor emails had no mapping — the latter is the
--   work-queue for the human seeding the map.
--
-- Re-runnable: all DDL is IF NOT EXISTS / DROP-IF-EXISTS guarded.
-- ============================================================

CREATE TABLE IF NOT EXISTS vt_flex_slack_user_map (
  email           TEXT PRIMARY KEY,
  slack_user_id   TEXT NOT NULL,
  display_name    TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vt_flex_slack_user_map IS
  'Maps user email -> Slack member ID for @mentioning rep managers in Flex issue posts. Seed by hand: in Slack desktop, click avatar -> View profile -> "..." menu -> Copy member ID. Example: INSERT INTO vt_flex_slack_user_map (email, slack_user_id, display_name) VALUES (''william.stewart@varsitytutors.com'', ''U01ABC234'', ''Walker Stewart'');';

CREATE INDEX IF NOT EXISTS idx_slack_user_map_user_id
  ON vt_flex_slack_user_map (slack_user_id);

ALTER TABLE vt_flex_slack_user_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_allowlisted_slack_user_map" ON vt_flex_slack_user_map;
CREATE POLICY "read_allowlisted_slack_user_map"
  ON vt_flex_slack_user_map
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

-- ---------- Extend slack-post audit log ----------
ALTER TABLE vt_flex_slack_posts
  ADD COLUMN IF NOT EXISTS mentioned_user_ids        TEXT[] NULL,
  ADD COLUMN IF NOT EXISTS unmapped_supervisor_emails TEXT[] NULL;

COMMENT ON COLUMN vt_flex_slack_posts.mentioned_user_ids IS
  'Slack user IDs that received an @mention on this post. NULL on skipped_filtered rows. Empty array means we tried to mention but none of the supervisor emails were mapped.';

COMMENT ON COLUMN vt_flex_slack_posts.unmapped_supervisor_emails IS
  'Supervisor emails on the issue that had no row in vt_flex_slack_user_map. This is the work queue for seeding new managers — query: SELECT DISTINCT unnest(unmapped_supervisor_emails) FROM vt_flex_slack_posts WHERE unmapped_supervisor_emails IS NOT NULL AND posted_at > NOW() - INTERVAL ''7 days'';';
