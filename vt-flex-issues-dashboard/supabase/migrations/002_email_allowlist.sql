-- ============================================================
-- 002_email_allowlist.sql
-- Lock dashboard reads to a maintained allowlist of emails.
--
-- - Adds vt_flex_allowed_emails table (one row per email)
-- - Replaces the prior read_authenticated_* policies with policies
--   that also require auth.email() to be in the allowlist.
-- - Service role still bypasses RLS (sync script keeps working).
--
-- To add/remove access later:
--   INSERT INTO vt_flex_allowed_emails (email) VALUES ('new.person@varsitytutors.com');
--   DELETE FROM vt_flex_allowed_emails WHERE email = 'old.person@varsitytutors.com';
-- ============================================================

-- ---------- Allowlist table ----------
CREATE TABLE IF NOT EXISTS vt_flex_allowed_emails (
  email       TEXT PRIMARY KEY,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by    TEXT
);

-- Seed initial allowlist. Re-runnable.
INSERT INTO vt_flex_allowed_emails (email, added_by) VALUES
  ('sean.groves@varsitytutors.com',         'initial seed'),
  ('william.stewart@varsitytutors.com',     'initial seed'),
  ('kristian.stephens@varsitytutors.com',   'initial seed')
ON CONFLICT (email) DO NOTHING;

-- RLS on the allowlist itself: no SELECT for anon/authenticated by default.
-- Service role bypasses RLS, so the sync script + admin tools still see it.
ALTER TABLE vt_flex_allowed_emails ENABLE ROW LEVEL SECURITY;

-- ---------- Helper function ----------
-- Returns true if the currently-authenticated user is on the allowlist.
-- LANGUAGE sql + STABLE so Postgres can inline + cache during a query.
CREATE OR REPLACE FUNCTION vt_flex_caller_allowed()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM vt_flex_allowed_emails
    WHERE email = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
  );
$$;

-- Grant execute so authenticated users can call the function (they can't
-- read the table directly, but the SECURITY DEFINER function can).
GRANT EXECUTE ON FUNCTION vt_flex_caller_allowed() TO authenticated;

-- ---------- Replace permissive read policies with allowlist-gated ones ----------
-- Drop the prior open "read for any authenticated user" policies.
DROP POLICY IF EXISTS "read_authenticated_issues"      ON vt_flex_issues;
DROP POLICY IF EXISTS "read_authenticated_supervisors" ON vt_flex_issue_supervisors;
DROP POLICY IF EXISTS "read_authenticated_tasks"       ON vt_flex_recent_tasks;
DROP POLICY IF EXISTS "read_authenticated_status"      ON vt_flex_status_history;
DROP POLICY IF EXISTS "read_authenticated_queues"      ON vt_flex_worker_queues;
DROP POLICY IF EXISTS "read_authenticated_skills"      ON vt_flex_worker_skills;

-- Drop replacements too in case this migration is re-run.
DROP POLICY IF EXISTS "read_allowlisted_issues"        ON vt_flex_issues;
DROP POLICY IF EXISTS "read_allowlisted_supervisors"   ON vt_flex_issue_supervisors;
DROP POLICY IF EXISTS "read_allowlisted_tasks"         ON vt_flex_recent_tasks;
DROP POLICY IF EXISTS "read_allowlisted_status"        ON vt_flex_status_history;
DROP POLICY IF EXISTS "read_allowlisted_queues"        ON vt_flex_worker_queues;
DROP POLICY IF EXISTS "read_allowlisted_skills"        ON vt_flex_worker_skills;

CREATE POLICY "read_allowlisted_issues"
  ON vt_flex_issues
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

CREATE POLICY "read_allowlisted_supervisors"
  ON vt_flex_issue_supervisors
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

CREATE POLICY "read_allowlisted_tasks"
  ON vt_flex_recent_tasks
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

CREATE POLICY "read_allowlisted_status"
  ON vt_flex_status_history
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

CREATE POLICY "read_allowlisted_queues"
  ON vt_flex_worker_queues
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

CREATE POLICY "read_allowlisted_skills"
  ON vt_flex_worker_skills
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

-- ---------- Sync runs: same treatment (lets the UI surface last-sync info) ----------
ALTER TABLE vt_flex_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_allowlisted_sync_runs" ON vt_flex_sync_runs;
CREATE POLICY "read_allowlisted_sync_runs"
  ON vt_flex_sync_runs
  FOR SELECT TO authenticated
  USING (vt_flex_caller_allowed());

-- ---------- Wide view: PostgREST checks underlying table policies, so this
--           inherits the same allowlist gate. No extra config needed.
