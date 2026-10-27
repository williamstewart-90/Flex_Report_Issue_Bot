-- ============================================================
-- 010_seed_new_team_managers.sql
-- @mention the managers who took over teams after the June 12 seed.
--
-- - Angela Damon: inherited John Wright II's reps starting 2026-07-09.
--   Slack profile shows "Angie Damon"; team_name in vt_flex_issues is
--   "Angela Damon", which is the lookup key.
-- - Liz Weiss: inherited Aaron Bunch's reps starting 2026-09-16
--   (Aaron moved to Senior Manager).
--
-- The old John Wright II / Aaron Bunch / Joshua Langford rows are left
-- in place: no current issues carry those team names, so they never
-- fire, and keeping them avoids losing the IDs if a team is reassigned
-- back.
--
-- Re-runnable: upsert on team_name.
-- ============================================================

INSERT INTO vt_flex_slack_team_managers (team_name, slack_user_id, display_name, email)
VALUES
  ('Angela Damon', 'U01NF4NHSEL', 'Angie Damon', 'angela.damon@varsitytutors.com'),
  ('Liz Weiss',    'U09C7NB29LK', 'Liz Weiss',   'liz.weiss@varsitytutors.com')
ON CONFLICT (team_name) DO UPDATE
  SET slack_user_id = EXCLUDED.slack_user_id,
      display_name  = EXCLUDED.display_name,
      email         = EXCLUDED.email,
      updated_at    = NOW();
