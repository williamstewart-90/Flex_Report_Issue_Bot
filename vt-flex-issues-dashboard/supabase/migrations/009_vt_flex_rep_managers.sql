-- Allowlist-gated rep → manager lookup (optional; Tech Disconnects tab
-- currently uses regional_director from langfuse_call_scoring_new_sales).
CREATE OR REPLACE FUNCTION public.vt_flex_rep_managers()
RETURNS TABLE (rep_name text, manager_name text)
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
  SELECT DISTINCT ON (d.rep_name)
    d.rep_name::text,
    d.manager_name::text
  FROM public.daily_rep_performance_raw d
  WHERE d.rep_name IS NOT NULL
    AND d.manager_name IS NOT NULL
    AND d.date_ct >= (CURRENT_DATE - 60)
  ORDER BY d.rep_name, d.date_ct DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.vt_flex_rep_managers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vt_flex_rep_managers() TO authenticated;
