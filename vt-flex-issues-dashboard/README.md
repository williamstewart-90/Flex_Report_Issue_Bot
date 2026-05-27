# VT Flex Issues Dashboard

Pipeline + Netlify dashboard for the `/vt-flex/issues?issue_type=technical_issue` API. GitHub Action pulls the API on a cron, flattens the nested JSON, upserts into Supabase. Vite + React + Tailwind frontend reads from Supabase.

## Architecture

```
┌──────────────────────┐    cron    ┌──────────────────────┐
│  VT Flex Issues API  │ ─────────► │  GitHub Action       │
│  /vt-flex/issues     │            │  scripts/sync-issues │
└──────────────────────┘            └─────────┬────────────┘
                                              │ upsert
                                              ▼
                                    ┌──────────────────────┐
                                    │  Supabase (Postgres) │
                                    │  - vt_flex_issues    │
                                    │  - vt_flex_recent…   │
                                    │  - vt_flex_status…   │
                                    │  - vt_flex_worker_…  │
                                    │  - vt_flex_issue_su… │
                                    └─────────┬────────────┘
                                              │ anon-key reads
                                              ▼
                                    ┌──────────────────────┐
                                    │  Netlify (Vite SPA)  │
                                    │  React + Tailwind    │
                                    └──────────────────────┘
```

`console_output` is intentionally excluded per requirements. Everything else from the API is flattened into relational tables. The original payload (minus `console_output`) is also stored on `vt_flex_issues.raw_payload` (JSONB) for future-proofing.

## Tables

| Table                          | Purpose                                                    |
|--------------------------------|------------------------------------------------------------|
| `vt_flex_issues`               | One row per issue. Top-level + `worker_attributes` + `hardware_config` + `network_diagnostics` flattened. |
| `vt_flex_issue_supervisors`    | One row per supervisor on an issue.                       |
| `vt_flex_recent_tasks`         | One row per task in `report.recent_tasks` — `task_sid`, `conference_sid`, `customer_call_sid`, `worker_call_sid`, `cm_*` (call_metrics), `wcm_*` (worker_call_metrics). |
| `vt_flex_status_history`       | One row per entry in `report.status_history`.             |
| `vt_flex_worker_queues`        | One row per queue in `worker_attributes.routing.queues`.  |
| `vt_flex_worker_skills`        | One row per skill, joined with level from `routing.levels`. |
| `vt_flex_sync_runs`            | Audit log of each sync run.                               |
| `vt_flex_issues_wide` (view)   | Convenience view that joins everything back into one row per issue. |

## Setup

### 1. Supabase

```bash
# Apply the schema. Either run via Supabase CLI:
supabase db push

# Or paste supabase/migrations/001_initial_schema.sql into the SQL editor.
```

The RLS policies grant `SELECT` to `authenticated`. If you want anonymous reads from the dashboard (no auth wall), edit the policies in the migration to use `TO anon`.

### 2. GitHub repo + secrets

```bash
# From this directory:
git init && git add . && git commit -m "initial commit"
gh repo create seangroves-collab/vt-flex-issues-dashboard --private --source=. --push
```

Add three repo secrets at `Settings → Secrets and variables → Actions`:

- `VT_FLEX_BEARER_TOKEN`     — the API bearer
- `SUPABASE_URL`             — `https://xtvesnascwiecohvkstd.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (not anon)

Trigger the first run from the **Actions** tab → `Sync VT Flex Issues` → Run workflow. The cron is set to every 15 minutes; adjust in `.github/workflows/sync-issues.yml`.

### 3. Netlify

```bash
# Connect the repo to Netlify (or use the Netlify CLI):
netlify init
```

In Netlify UI, set environment variables:

- `VITE_SUPABASE_URL`       — `https://xtvesnascwiecohvkstd.supabase.co`
- `VITE_SUPABASE_ANON_KEY`  — Supabase anon key (safe in the browser)

Build command and publish dir are already wired in `netlify.toml`.

### 4. Local dev

```bash
cp .env.example .env.local
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

To run the sync script locally:

```bash
cd scripts
npm install
VT_FLEX_BEARER_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  node sync-issues.mjs
```

## Reconciliation logic

The sync uses an **upsert + replace-children** pattern per batch:

1. Upsert issue rows on `issue_id`.
2. For each batch of `issue_id`s, delete child rows in `vt_flex_recent_tasks`, `vt_flex_issue_supervisors`, etc., then insert fresh.

This means if the API later mutates `recent_tasks` for an existing issue (e.g. `processing_state: pending` → `complete`), the next sync brings everything in line. The trade-off: slightly more write churn than a true diff. Cheap at this volume.

## Querying

Wide-row queries via the view:

```sql
SELECT issue_id, agent_name, team_name, supervisor_emails,
       queues, skills_with_levels, recent_task_count
FROM vt_flex_issues_wide
WHERE issue_created_at > NOW() - INTERVAL '24 hours'
ORDER BY issue_created_at DESC;
```

Find issues with bad call quality:

```sql
SELECT i.agent_name, t.task_sid, t.cm_tags, t.wcm_inbound_mos_avg
FROM vt_flex_recent_tasks t
JOIN vt_flex_issues i USING (issue_id)
WHERE 'high_latency' = ANY(t.cm_tags)
   OR t.wcm_inbound_mos_avg < 4.0
ORDER BY i.issue_created_at DESC;
```

## Notes

- Bearer token never touches the frontend.
- The schema uses snake_case columns; the dotted naming you asked about (e.g. `recent_tasks.task_sid`) is preserved by the table prefix + column name (`vt_flex_recent_tasks.task_sid`). If you want literal dotted column names, Postgres requires quoting them everywhere; the snake_case convention plays nicer with PostgREST/Supabase clients.
- Adjust the cron in `.github/workflows/sync-issues.yml`. GitHub schedules are best-effort and can drift a few minutes.
- `MAX_PAGES` defaults to 200 (20,000 issues at `PAGE_LIMIT=100`). Bump if your backfill is larger.
