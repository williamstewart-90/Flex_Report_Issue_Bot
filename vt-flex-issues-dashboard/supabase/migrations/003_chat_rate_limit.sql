-- ============================================================
-- 003_chat_rate_limit.sql
-- Per-user rate limiting for the Flex Troubleshooting chatbot.
-- One row per chat request. Lookups: WHERE user_email = X
-- AND used_at > NOW() - INTERVAL '1 hour'. Cap = 30/hr/user.
--
-- Writes happen from the Netlify Function using the service role
-- key (bypasses RLS). No reads from anon/authenticated users —
-- RLS is enabled with no policies so reads are denied by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS vt_flex_chat_usage (
  id          BIGSERIAL PRIMARY KEY,
  user_email  TEXT NOT NULL,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index tuned for the rate-limit query: scan recent rows per user.
CREATE INDEX IF NOT EXISTS idx_chat_usage_lookup
  ON vt_flex_chat_usage (user_email, used_at DESC);

-- Index to support periodic pruning of old rows.
CREATE INDEX IF NOT EXISTS idx_chat_usage_used_at
  ON vt_flex_chat_usage (used_at);

-- Service role bypasses RLS; this just locks out anon/authenticated.
ALTER TABLE vt_flex_chat_usage ENABLE ROW LEVEL SECURITY;

-- ---------- Optional: housekeeping ----------
-- Prune rows older than 24h. Safe to run on a schedule (cron/pg_cron),
-- or call it from the function once every N requests. For now you can
-- invoke it manually if the table grows.
--
--   SELECT vt_flex_prune_chat_usage();
--
CREATE OR REPLACE FUNCTION vt_flex_prune_chat_usage()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM vt_flex_chat_usage WHERE used_at < NOW() - INTERVAL '24 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
