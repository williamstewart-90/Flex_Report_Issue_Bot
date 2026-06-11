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

## Manager-notification pipeline (auto-email triage)

After each successful sync, `scripts/notify.mjs` finds newly-arrived issues, runs each through the existing Flex Troubleshooting Assistant prompt (Claude Sonnet, same as the dashboard chatbot), and emails the AI-generated triage to the issue's supervisor(s) via Gmail SMTP.

Pipeline:

1. Find rows where `notified_at IS NULL` AND `issue_created_at > now() - NOTIFICATIONS_RECENCY_HOURS` AND `issue_type = 'technical_issue'`.
2. For each (capped at `MAX_NOTIFICATIONS_PER_RUN`): build a slim triage payload, call Anthropic, send the email, set `notified_at`, log to `vt_flex_notifications`.
3. Log the run summary to `vt_flex_notification_runs`.

### Required setup

1. Apply the migration in `supabase/migrations/003_notifications.sql`.
2. On the sending Google account: enable 2FA, then generate a 16-char app password at https://myaccount.google.com/apppasswords (label it "Flex Issues Bot").
3. Set these GitHub Actions secrets (in addition to the existing three):

   | Secret | Purpose |
   |---|---|
   | `ANTHROPIC_API_KEY` | Same key the Netlify chat function uses |
   | `GMAIL_USER` | Sending Gmail/Workspace account (e.g. `flex-alerts@varsitytutors.com`) |
   | `GMAIL_APP_PASSWORD` | 16-char app password from step 2 |
   | `NOTIFICATIONS_FROM_EMAIL` | From address (usually same as `GMAIL_USER`; can be a "send-as" alias) |
   | `NOTIFICATIONS_FORCE_TO` | **Shadow mode** — while this is set, ALL emails route here. Set to your own email for the rollout. Unset to go live. |
   | `NOTIFICATIONS_ENABLED` | Optional master kill-switch (default `1`; set to `0` to pause) |
   | `MAX_NOTIFICATIONS_PER_RUN` | Optional per-run cap (default `25`) |
   | `NOTIFICATIONS_RECENCY_HOURS` | Optional recency window in hours (default `24`) |
   | `ANTHROPIC_MODEL` | Optional model override (default `claude-sonnet-4-20250514`) |
   | `ANTHROPIC_MAX_TOKENS` | Optional output cap (default `1200`) |

### Rollout

1. **Shadow week.** Ship with `NOTIFICATIONS_FORCE_TO=<your email>` set. Every issue triages and emails you so you can validate the AI's tone and accuracy before any manager sees it.
2. **Iterate.** Adjust `scripts/lib/auto-triage-preamble.js` (or the knowledge base at `netlify/functions/lib/system-prompt.js`) based on what shows up in your inbox.
3. **Go live.** Remove `NOTIFICATIONS_FORCE_TO` from the GitHub Actions secrets. Emails now route to the actual supervisor emails on each issue.
4. **Pause anytime.** Set `NOTIFICATIONS_ENABLED=0`.

### Local testing

```bash
cd scripts

# Fully offline: uses the built-in fixture issues + Anthropic (real call) + prints email to stdout.
# Requires ANTHROPIC_API_KEY in .env.local. Costs ~$0.02 to test all fixture issues.
MOCK_API=1 DRY_RUN=1 node sync-issues.mjs

# Re-run notify against a single issue_id that already exists in Supabase:
node test-notification.mjs <issue_id>
```

### Editing the prompt

- `netlify/functions/lib/system-prompt.js` — the shared knowledge base (also used by the chatbot).
- `scripts/lib/auto-triage-preamble.js` — the email-mode override layered on top (one-shot output, fixed sections, no clarifying questions).

Both are picked up automatically on the next sync run.

## Slack manager-notification route (`post-to-slack.mjs`)

Sibling pipeline to the email route. Runs in the same hourly GitHub Action,
right after the sync + email step. Posts each new technical issue to a
Slack channel, with the same AI triage the email pipeline uses — except
that `scripts/lib/issue-filter.mjs` first classifies the issue and
**skips** routing/attribution complaints (Prof Certs, PC, Client Services,
existing-client misroutes) since managers can't action those between
calls.

Pipeline:

1. Find rows where `slack_posted_at IS NULL` AND `issue_created_at > now() - SLACK_RECENCY_HOURS` AND `issue_type = 'technical_issue'`.
2. For each (capped at `MAX_SLACK_POSTS_PER_RUN`): classify, then either
   (a) post the AI triage to Slack and stamp `slack_posted_at`, or
   (b) skip (filtered) and still stamp `slack_posted_at` so we don't
       re-classify forever.
3. Log every decision to `vt_flex_slack_posts`; log the run summary to
   `vt_flex_slack_runs`. The audit table records which filter rules
   matched on skipped rows so the classifier can be tuned from real data.

### One-time Slack app setup

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
   - App name: `VT Flex Issues`
   - Workspace: VT
2. **OAuth & Permissions** → add Bot Token Scopes: `chat:write`, `chat:write.public`.
3. **Install App** → install to workspace (requires a workspace admin). Copy
   the **Bot User OAuth Token** (`xoxb-…`) — this is `SLACK_BOT_TOKEN`.
4. Find the channel ID for the destination channel (right-click channel
   in Slack → View channel details → ID at the bottom). Spike-week
   default: `#flex-support-help-bot` = `C0B7UGBJNQ3`.

### Required GitHub Actions secrets (in addition to the email pipeline)

| Secret | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token from the VT Flex Issues app |
| `SLACK_CHANNEL_ID` | Destination channel ID (e.g. `C0B7UGBJNQ3`) |
| `SLACK_ENABLED` | Optional master kill-switch (default on; set to `0` to pause) |
| `MAX_SLACK_POSTS_PER_RUN` | Optional per-run cap (default `25`) |
| `SLACK_RECENCY_HOURS` | Optional recency window in hours (default `24`) |

Anthropic + Supabase secrets are reused from the email pipeline; no
duplicate values needed.

### Local testing

```bash
cd scripts

# Dry-run against the real DB: classifies and triages everything but
# never calls Slack and never writes to Supabase. Safe to run as often
# as you want — only Anthropic charges.
DRY_RUN=1 node post-to-slack.mjs
```

### Editing the filter

`scripts/lib/issue-filter.mjs` holds the regex rules. Every filter
decision is logged with the matched rule names in
`vt_flex_slack_posts.filter_hits`, so after a week of live data you can
query that table for misclassifications and tune the rules off real
evidence.

## Notes

- Bearer token never touches the frontend.
- The schema uses snake_case columns; the dotted naming you asked about (e.g. `recent_tasks.task_sid`) is preserved by the table prefix + column name (`vt_flex_recent_tasks.task_sid`). If you want literal dotted column names, Postgres requires quoting them everywhere; the snake_case convention plays nicer with PostgREST/Supabase clients.
- Adjust the cron in `.github/workflows/sync-issues.yml`. GitHub schedules are best-effort and can drift a few minutes.
- `MAX_PAGES` defaults to 200 (20,000 issues at `PAGE_LIMIT=100`). Bump if your backfill is larger.
