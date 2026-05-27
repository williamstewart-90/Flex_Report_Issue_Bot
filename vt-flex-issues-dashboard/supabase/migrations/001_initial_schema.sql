-- VT Flex Issues Dashboard schema
-- Flattens nested API response into relational tables.
-- console_output is intentionally excluded (per requirements).

-- =========================================================
-- Main issues table (one row per issue_id)
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_issues (
  issue_id              UUID PRIMARY KEY,
  issue_type            TEXT,
  status                TEXT,
  agent_worker_sid      TEXT,
  agent_name            TEXT,
  team_sid              TEXT,
  team_name             TEXT,
  issue_created_at      TIMESTAMPTZ,
  issue_updated_at      TIMESTAMPTZ,
  plugin_version        TEXT,

  -- report.worker_attributes (flattened)
  worker_full_name      TEXT,
  worker_email          TEXT,
  worker_manager_id     INTEGER,
  worker_team_id        TEXT,
  worker_roles          TEXT[],

  -- report.agent_description
  agent_description     TEXT,

  -- report.hardware_config (flattened)
  hw_browser                    TEXT,
  hw_user_agent                 TEXT,
  hw_flex_version               TEXT,
  hw_os                         TEXT,
  hw_timezone                   TEXT,
  hw_audio_input                TEXT,
  hw_audio_output               TEXT,
  hw_permission_microphone      TEXT,
  hw_permission_notifications   TEXT,
  hw_memory_limit_gb            NUMERIC,
  hw_memory_used_gb             NUMERIC,

  -- report.network_diagnostics (flattened)
  net_effective_type    TEXT,
  net_downlink          TEXT,
  net_rtt               TEXT,

  -- pipeline metadata
  raw_payload           JSONB,
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_created_at        ON vt_flex_issues(issue_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_agent             ON vt_flex_issues(agent_worker_sid);
CREATE INDEX IF NOT EXISTS idx_issues_team_sid          ON vt_flex_issues(team_sid);
CREATE INDEX IF NOT EXISTS idx_issues_status            ON vt_flex_issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_issue_type        ON vt_flex_issues(issue_type);
CREATE INDEX IF NOT EXISTS idx_issues_agent_name        ON vt_flex_issues(agent_name);

-- =========================================================
-- Supervisors (many per issue)
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_issue_supervisors (
  id                BIGSERIAL PRIMARY KEY,
  issue_id          UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  supervisor_worker_sid TEXT,
  supervisor_email      TEXT,
  UNIQUE (issue_id, supervisor_worker_sid)
);

CREATE INDEX IF NOT EXISTS idx_supervisors_issue ON vt_flex_issue_supervisors(issue_id);
CREATE INDEX IF NOT EXISTS idx_supervisors_email ON vt_flex_issue_supervisors(supervisor_email);

-- =========================================================
-- Recent tasks (many per issue)
-- Columns mirror your requested naming: recent_tasks.task_sid etc.
-- Stored in snake_case here; the Supabase view below exposes the dotted names.
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_recent_tasks (
  id                          BIGSERIAL PRIMARY KEY,
  issue_id                    UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  task_order                  INTEGER,

  task_sid                    TEXT,
  conference_sid              TEXT,
  customer_call_sid           TEXT,
  worker_call_sid             TEXT,
  channel                     TEXT,
  skill                       TEXT,
  entity_type                 TEXT,
  entity_id                   TEXT,

  -- customer call_metrics
  cm_call_state                       TEXT,
  cm_processing_state                 TEXT,
  cm_who_hung_up                      TEXT,
  cm_post_dial_delay_seconds          NUMERIC,
  cm_last_sip_response                INTEGER,
  cm_verified_caller                  BOOLEAN,
  cm_from_number                      TEXT,
  cm_from_connection                  TEXT,
  cm_from_country                     TEXT,
  cm_from_carrier                     TEXT,
  cm_to_number                        TEXT,
  cm_to_connection                    TEXT,
  cm_to_country                       TEXT,
  cm_to_carrier                       TEXT,
  cm_edge_type                        TEXT,
  cm_edge_location                    TEXT,
  cm_media_region                     TEXT,
  cm_inbound_codec                    TEXT,
  cm_inbound_jitter_avg_ms            NUMERIC,
  cm_inbound_packet_loss_pct          NUMERIC,
  cm_inbound_latency_avg_ms           NUMERIC,
  cm_inbound_rtt_avg_ms               NUMERIC,
  cm_inbound_mos_avg                  NUMERIC,
  cm_outbound_codec                   TEXT,
  cm_outbound_latency_avg_ms          NUMERIC,
  cm_outbound_jitter_avg_ms           NUMERIC,
  cm_outbound_packet_loss_pct         NUMERIC,
  cm_tags                             TEXT[],

  -- worker_call_metrics
  wcm_call_state                      TEXT,
  wcm_processing_state                TEXT,
  wcm_who_hung_up                     TEXT,
  wcm_post_dial_delay_seconds         NUMERIC,
  wcm_last_sip_response               INTEGER,
  wcm_from_number                     TEXT,
  wcm_to_number                       TEXT,
  wcm_to_connection                   TEXT,
  wcm_to_country                      TEXT,
  wcm_edge_type                       TEXT,
  wcm_inbound_rtt_avg_ms              NUMERIC,
  wcm_inbound_jitter_avg_ms           NUMERIC,
  wcm_inbound_packet_loss_pct         NUMERIC,
  wcm_inbound_mos_avg                 NUMERIC,
  wcm_outbound_codec                  TEXT,
  wcm_tags                            TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_tasks_issue          ON vt_flex_recent_tasks(issue_id);
CREATE INDEX IF NOT EXISTS idx_tasks_channel        ON vt_flex_recent_tasks(channel);
CREATE INDEX IF NOT EXISTS idx_tasks_skill          ON vt_flex_recent_tasks(skill);
CREATE INDEX IF NOT EXISTS idx_tasks_call_state     ON vt_flex_recent_tasks(cm_call_state);
CREATE INDEX IF NOT EXISTS idx_tasks_tags_gin       ON vt_flex_recent_tasks USING GIN (cm_tags);

-- =========================================================
-- Status history (many per issue)
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_status_history (
  id              BIGSERIAL PRIMARY KEY,
  issue_id        UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  status_order    INTEGER,
  activity_name   TEXT,
  activity_at     TIMESTAMPTZ,
  UNIQUE (issue_id, status_order)
);

CREATE INDEX IF NOT EXISTS idx_status_issue   ON vt_flex_status_history(issue_id);
CREATE INDEX IF NOT EXISTS idx_status_at      ON vt_flex_status_history(activity_at);

-- =========================================================
-- Worker routing queues (many per issue)
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_worker_queues (
  id          BIGSERIAL PRIMARY KEY,
  issue_id    UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  queue_name  TEXT,
  UNIQUE (issue_id, queue_name)
);

CREATE INDEX IF NOT EXISTS idx_queues_issue ON vt_flex_worker_queues(issue_id);

-- =========================================================
-- Worker routing skills (with levels)
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_worker_skills (
  id            BIGSERIAL PRIMARY KEY,
  issue_id      UUID NOT NULL REFERENCES vt_flex_issues(issue_id) ON DELETE CASCADE,
  skill_name    TEXT,
  skill_level   INTEGER,
  UNIQUE (issue_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_skills_issue ON vt_flex_worker_skills(issue_id);

-- =========================================================
-- Sync run audit log
-- =========================================================
CREATE TABLE IF NOT EXISTS vt_flex_sync_runs (
  id                BIGSERIAL PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  pages_fetched     INTEGER,
  issues_upserted   INTEGER,
  status            TEXT,
  error_message     TEXT
);

-- =========================================================
-- Convenience view: flat "wide" row per issue with arrays
-- aggregated. Useful for ad-hoc Supabase queries.
-- =========================================================
CREATE OR REPLACE VIEW vt_flex_issues_wide AS
SELECT
  i.*,
  (SELECT array_agg(supervisor_email)
     FROM vt_flex_issue_supervisors s WHERE s.issue_id = i.issue_id) AS supervisor_emails,
  (SELECT array_agg(queue_name)
     FROM vt_flex_worker_queues q WHERE q.issue_id = i.issue_id) AS queues,
  (SELECT jsonb_object_agg(skill_name, skill_level)
     FROM vt_flex_worker_skills sk WHERE sk.issue_id = i.issue_id) AS skills_with_levels,
  (SELECT count(*) FROM vt_flex_recent_tasks t WHERE t.issue_id = i.issue_id) AS recent_task_count,
  (SELECT count(*) FROM vt_flex_status_history h WHERE h.issue_id = i.issue_id) AS status_history_count
FROM vt_flex_issues i;

-- =========================================================
-- RLS: enable and add read policy for authenticated users
-- Adjust as needed for your auth model.
-- =========================================================
ALTER TABLE vt_flex_issues               ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_issue_supervisors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_recent_tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_status_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_worker_queues        ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_worker_skills        ENABLE ROW LEVEL SECURITY;
ALTER TABLE vt_flex_sync_runs            ENABLE ROW LEVEL SECURITY;

-- Read policy for authenticated users (frontend uses anon key + JWT)
DO $$ BEGIN
  CREATE POLICY "read_authenticated_issues"
    ON vt_flex_issues FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "read_authenticated_supervisors"
    ON vt_flex_issue_supervisors FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "read_authenticated_tasks"
    ON vt_flex_recent_tasks FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "read_authenticated_status"
    ON vt_flex_status_history FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "read_authenticated_queues"
    ON vt_flex_worker_queues FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "read_authenticated_skills"
    ON vt_flex_worker_skills FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- If you want anonymous reads from the dashboard (no auth), swap the policies:
-- DROP POLICY ... and use TO anon USING (true).
