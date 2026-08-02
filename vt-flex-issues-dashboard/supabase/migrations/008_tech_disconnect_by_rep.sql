-- Aggregate technical_disconnect rates for consumer new-sales scoring.
-- Allowlist-gated to match vt_flex dashboard access.

CREATE OR REPLACE FUNCTION public.tech_disconnect_by_rep(
  p_start timestamptz,
  p_end   timestamptz
)
RETURNS TABLE (
  agent_name     text,
  calls          bigint,
  tech_n         bigint,
  tech_pct       numeric,
  ge15           bigint,
  tech_ge15      bigint,
  tech_ge15_pct  numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.vt_flex_caller_allowed() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      s.agent_name AS agent,
      s.call_duration_s,
      lower(coalesce(s.disconnect_label, '')) LIKE '%technical%' AS is_tech
    FROM public.langfuse_call_scoring_new_sales s
    WHERE s.called_at_utc >= p_start
      AND s.called_at_utc < p_end
      AND s.agent_name IS NOT NULL
  ),
  by_rep AS (
    SELECT
      b.agent,
      count(*)::bigint AS calls,
      count(*) FILTER (WHERE b.is_tech)::bigint AS tech_n,
      count(*) FILTER (WHERE b.call_duration_s >= 900)::bigint AS ge15,
      count(*) FILTER (WHERE b.call_duration_s >= 900 AND b.is_tech)::bigint AS tech_ge15
    FROM base b
    GROUP BY b.agent
  )
  SELECT
    r.agent,
    r.calls,
    r.tech_n,
    round(100.0 * r.tech_n / nullif(r.calls, 0), 2),
    r.ge15,
    r.tech_ge15,
    round(100.0 * r.tech_ge15 / nullif(r.ge15, 0), 2)
  FROM by_rep r
  ORDER BY r.tech_ge15 DESC, r.tech_n DESC, r.agent;
END;
$$;

REVOKE ALL ON FUNCTION public.tech_disconnect_by_rep(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tech_disconnect_by_rep(timestamptz, timestamptz) TO authenticated;
