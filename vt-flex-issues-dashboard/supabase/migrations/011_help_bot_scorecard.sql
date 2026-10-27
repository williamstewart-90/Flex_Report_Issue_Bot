-- ============================================================
-- 011_help_bot_scorecard.sql
-- Read-only scorecard for the Flex help bot (Scorecard tab).
--
-- - vt_flex_help_bot_scorecard_weekly(p_weeks): one row per week
--   (Mon-start, America/Chicago) with issue volume, Slack delivery,
--   @mention coverage, same-day repeat rate, chatbot and email usage.
-- - vt_flex_help_bot_scorecard_by_team(p_days): one row per team over
--   the trailing window, including whether the team is in
--   vt_flex_slack_team_managers. Unmapped rows are the seeding queue.
--
-- "Repeat" = the same rep filed another technical issue in the prior
-- 24 hours. A 7-day window flags ~90% of issues (reps file several a
-- day about different calls), so it doesn't separate anything.
--
-- Allowlist-gated like tech_disconnect_by_rep.
-- ============================================================

CREATE OR REPLACE FUNCTION public.vt_flex_help_bot_scorecard_weekly(p_weeks int DEFAULT 8)
RETURNS TABLE (
  week_start     date,
  issues         bigint,
  reps           bigint,
  repeat_issues  bigint,
  posted         bigint,
  mentioned      bigint,
  filtered       bigint,
  failed         bigint,
  chat_users     bigint,
  chat_msgs      bigint,
  emails_sent    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first    date;
  v_first_ts timestamptz;
BEGIN
  IF NOT public.vt_flex_caller_allowed() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  v_first := (date_trunc('week', now() AT TIME ZONE 'America/Chicago')
              - (greatest(p_weeks, 1) - 1) * interval '1 week')::date;
  v_first_ts := v_first::timestamp AT TIME ZONE 'America/Chicago';

  RETURN QUERY
  WITH weeks AS (
    SELECT generate_series(v_first,
                           date_trunc('week', now() AT TIME ZONE 'America/Chicago')::date,
                           interval '1 week')::date AS wk
  ),
  iss AS (
    SELECT
      date_trunc('week', i.issue_created_at AT TIME ZONE 'America/Chicago')::date AS wk,
      lower(i.worker_email) AS em,
      coalesce(
        i.issue_created_at - lag(i.issue_created_at) OVER (
          PARTITION BY lower(i.worker_email) ORDER BY i.issue_created_at
        ) <= interval '24 hours',
        false
      ) AS is_repeat
    FROM vt_flex_issues i
    WHERE i.issue_type = 'technical_issue'
      AND i.worker_email IS NOT NULL
      AND i.issue_created_at >= v_first_ts - interval '1 day'
  ),
  iss_w AS (
    SELECT s.wk, count(*) AS issues, count(DISTINCT s.em) AS reps,
           count(*) FILTER (WHERE s.is_repeat) AS repeat_issues
    FROM iss s
    GROUP BY s.wk
  ),
  posts AS (
    SELECT
      date_trunc('week', p.posted_at AT TIME ZONE 'America/Chicago')::date AS wk,
      count(*) FILTER (WHERE p.status = 'posted') AS posted,
      count(*) FILTER (WHERE p.status = 'posted'
                         AND cardinality(coalesce(p.mentioned_user_ids, '{}')) > 0) AS mentioned,
      count(*) FILTER (WHERE p.status = 'skipped_filtered') AS filtered,
      count(*) FILTER (WHERE p.status IN ('anthropic_failed', 'slack_failed')) AS failed
    FROM vt_flex_slack_posts p
    WHERE p.posted_at >= v_first_ts
    GROUP BY 1
  ),
  chat AS (
    SELECT date_trunc('week', c.used_at AT TIME ZONE 'America/Chicago')::date AS wk,
           count(*) AS msgs, count(DISTINCT lower(c.user_email)) AS users
    FROM vt_flex_chat_usage c
    WHERE c.used_at >= v_first_ts
    GROUP BY 1
  ),
  mail AS (
    SELECT date_trunc('week', n.sent_at AT TIME ZONE 'America/Chicago')::date AS wk,
           count(*) FILTER (WHERE NOT coalesce(n.shadow_mode, false)) AS sent
    FROM vt_flex_notifications n
    WHERE n.sent_at >= v_first_ts
    GROUP BY 1
  )
  SELECT
    w.wk,
    coalesce(i.issues, 0),
    coalesce(i.reps, 0),
    coalesce(i.repeat_issues, 0),
    coalesce(p.posted, 0),
    coalesce(p.mentioned, 0),
    coalesce(p.filtered, 0),
    coalesce(p.failed, 0),
    coalesce(c.users, 0),
    coalesce(c.msgs, 0),
    coalesce(m.sent, 0)
  FROM weeks w
  LEFT JOIN iss_w i ON i.wk = w.wk
  LEFT JOIN posts p ON p.wk = w.wk
  LEFT JOIN chat  c ON c.wk = w.wk
  LEFT JOIN mail  m ON m.wk = w.wk
  ORDER BY w.wk;
END;
$$;

CREATE OR REPLACE FUNCTION public.vt_flex_help_bot_scorecard_by_team(p_days int DEFAULT 28)
RETURNS TABLE (
  team_name       text,
  mapped          boolean,
  mentions        text,
  issues          bigint,
  reps            bigint,
  repeat_issues   bigint,
  posted          bigint,
  unmentioned     bigint,
  last_issue_at   timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  IF NOT public.vt_flex_caller_allowed() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  v_since := now() - greatest(p_days, 1) * interval '1 day';

  RETURN QUERY
  WITH iss AS (
    SELECT
      coalesce(i.team_name, '(none)') AS team,
      lower(i.worker_email) AS em,
      i.issue_created_at AS ts,
      coalesce(
        i.issue_created_at - lag(i.issue_created_at) OVER (
          PARTITION BY lower(i.worker_email) ORDER BY i.issue_created_at
        ) <= interval '24 hours',
        false
      ) AS is_repeat
    FROM vt_flex_issues i
    WHERE i.issue_type = 'technical_issue'
      AND i.worker_email IS NOT NULL
      AND i.issue_created_at >= v_since - interval '1 day'
  ),
  by_team AS (
    SELECT
      s.team,
      count(*) FILTER (WHERE s.ts >= v_since) AS issues,
      count(DISTINCT s.em) FILTER (WHERE s.ts >= v_since) AS reps,
      count(*) FILTER (WHERE s.is_repeat AND s.ts >= v_since) AS repeat_issues,
      max(s.ts) AS last_at
    FROM iss s
    GROUP BY s.team
  ),
  posts AS (
    SELECT
      coalesce(p.team_name, '(none)') AS team,
      count(*) AS posted,
      count(*) FILTER (WHERE cardinality(coalesce(p.mentioned_user_ids, '{}')) = 0) AS unmentioned
    FROM vt_flex_slack_posts p
    WHERE p.status = 'posted'
      AND p.posted_at >= v_since
    GROUP BY 1
  )
  SELECT
    t.team,
    m.team_name IS NOT NULL,
    m.display_name,
    t.issues,
    t.reps,
    t.repeat_issues,
    coalesce(p.posted, 0),
    coalesce(p.unmentioned, 0),
    t.last_at
  FROM by_team t
  LEFT JOIN vt_flex_slack_team_managers m ON m.team_name = t.team
  LEFT JOIN posts p ON p.team = t.team
  WHERE t.issues > 0
  ORDER BY coalesce(p.unmentioned, 0) DESC, t.issues DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.vt_flex_help_bot_scorecard_weekly(int)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vt_flex_help_bot_scorecard_by_team(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vt_flex_help_bot_scorecard_weekly(int)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.vt_flex_help_bot_scorecard_by_team(int) TO authenticated;
