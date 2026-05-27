#!/usr/bin/env node
// VT Flex Issues → Supabase sync
// Fetches /vt-flex/issues?issue_type=technical_issue, flattens nested JSON,
// upserts to relational tables. Designed to run from GitHub Actions on a cron.

import { createClient } from '@supabase/supabase-js';

const API_BASE         = process.env.VT_FLEX_API_BASE || 'https://api.varsitytutors.com';
const API_PATH         = '/vt-flex/issues';
const ISSUE_TYPE       = process.env.VT_FLEX_ISSUE_TYPE || 'technical_issue';
const BEARER_TOKEN     = process.env.VT_FLEX_BEARER_TOKEN;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAGE_LIMIT       = parseInt(process.env.VT_FLEX_PAGE_LIMIT || '100', 10);
const MAX_PAGES        = parseInt(process.env.VT_FLEX_MAX_PAGES || '200', 10);
const DRY_RUN          = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const MOCK_API         = process.env.MOCK_API === '1' || process.env.MOCK_API === 'true';

function required(name, val) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
if (!MOCK_API) {
  required('VT_FLEX_BEARER_TOKEN', BEARER_TOKEN);
}
if (!DRY_RUN) {
  required('SUPABASE_URL', SUPABASE_URL);
  required('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY);
}

if (MOCK_API) console.log('[mock] MOCK_API=1 — no network calls; using built-in fixture');
if (DRY_RUN)  console.log('[dry-run] DRY_RUN=1 — no writes to Supabase');

const supabase = DRY_RUN
  ? null
  : createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });

// ---------- helpers ----------
const pick = (obj, path) => {
  if (!obj) return null;
  return path.split('.').reduce((acc, k) => (acc == null ? null : acc[k]), obj);
};
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
const boolOrNull = (v) => (v == null ? null : Boolean(v));
const strOrNull = (v) => (v == null ? null : String(v));
const arrOrNull = (v) => (Array.isArray(v) && v.length ? v : null);

// ---------- flatteners ----------
function flattenIssue(raw) {
  const r  = raw.report || {};
  const wa = r.worker_attributes || {};
  const hw = r.hardware_config || {};
  const nd = r.network_diagnostics || {};
  const perms = hw.permissions || {};

  return {
    issue_id:         raw.issue_id,
    issue_type:       raw.issue_type,
    status:           raw.status,
    agent_worker_sid: raw.agent_worker_sid,
    agent_name:       raw.agent_name,
    team_sid:         raw.team_sid,
    team_name:        raw.team_name,
    issue_created_at: raw.created_at,
    issue_updated_at: raw.updated_at,
    plugin_version:   raw.plugin_version,

    worker_full_name:  wa.full_name,
    worker_email:      wa.email,
    worker_manager_id: wa.manager_id ?? null,
    worker_team_id:    wa.team_id,
    worker_roles:      arrOrNull(wa.roles),

    agent_description: r.agent_description,

    hw_browser:                  hw.browser,
    hw_user_agent:               hw.user_agent,
    hw_flex_version:             hw.flex_version,
    hw_os:                       hw.os,
    hw_timezone:                 hw.timezone,
    hw_audio_input:              hw.audio_input,
    hw_audio_output:             hw.audio_output,
    hw_permission_microphone:    perms.microphone,
    hw_permission_notifications: perms.notifications,
    hw_memory_limit_gb:          numOrNull(hw.memory_limit_gb),
    hw_memory_used_gb:           numOrNull(hw.memory_used_gb),

    net_effective_type: nd.effective_type,
    net_downlink:       nd.downlink,
    net_rtt:            nd.rtt,

    // store the raw object too (sans console_output) for future-proofing
    raw_payload: stripConsoleOutput(raw),
    synced_at:   new Date().toISOString()
  };
}

function stripConsoleOutput(raw) {
  if (!raw || !raw.report) return raw;
  const { console_output, ...rest } = raw.report;
  return { ...raw, report: rest };
}

function flattenTask(issueId, t, idx) {
  const cm  = t.call_metrics || {};
  const wcm = t.worker_call_metrics || {};
  const cmFrom = cm.from || {};
  const cmTo   = cm.to || {};
  const cmEdge = cm.edge || {};
  const cmIn   = cmEdge.inbound  || {};
  const cmOut  = cmEdge.outbound || {};
  const wcmFrom = wcm.from || {};
  const wcmTo   = wcm.to || {};
  const wcmEdge = wcm.edge || {};
  const wcmIn   = wcmEdge.inbound  || {};

  return {
    issue_id:          issueId,
    task_order:        idx,
    task_sid:          t.task_sid,
    conference_sid:    t.conference_sid,
    customer_call_sid: t.customer_call_sid,
    worker_call_sid:   t.worker_call_sid,
    channel:           t.channel,
    skill:             t.skill,
    entity_type:       t.entity_type,
    entity_id:         strOrNull(t.entity_id),

    cm_call_state:               cm.call_state,
    cm_processing_state:         cm.processing_state,
    cm_who_hung_up:              cm.who_hung_up,
    cm_post_dial_delay_seconds:  numOrNull(cm.post_dial_delay_seconds),
    cm_last_sip_response:        cm.last_sip_response ?? null,
    cm_verified_caller:          boolOrNull(cm.verified_caller),
    cm_from_number:              cmFrom.number,
    cm_from_connection:          cmFrom.connection,
    cm_from_country:             cmFrom.country,
    cm_from_carrier:             cmFrom.carrier,
    cm_to_number:                cmTo.number,
    cm_to_connection:            cmTo.connection,
    cm_to_country:               cmTo.country,
    cm_to_carrier:               cmTo.carrier,
    cm_edge_type:                cmEdge.edge_type,
    cm_edge_location:            cmEdge.edge_location,
    cm_media_region:             cmEdge.media_region,
    cm_inbound_codec:            cmIn.codec,
    cm_inbound_jitter_avg_ms:    numOrNull(cmIn.jitter_avg_ms),
    cm_inbound_packet_loss_pct:  numOrNull(cmIn.packet_loss_pct),
    cm_inbound_latency_avg_ms:   numOrNull(cmIn.latency_avg_ms),
    cm_inbound_rtt_avg_ms:       numOrNull(cmIn.rtt_avg_ms),
    cm_inbound_mos_avg:          numOrNull(cmIn.mos_avg),
    cm_outbound_codec:           cmOut.codec,
    cm_outbound_latency_avg_ms:  numOrNull(cmOut.latency_avg_ms),
    cm_outbound_jitter_avg_ms:   numOrNull(cmOut.jitter_avg_ms),
    cm_outbound_packet_loss_pct: numOrNull(cmOut.packet_loss_pct),
    cm_tags:                     arrOrNull(cm.tags),

    wcm_call_state:              wcm.call_state,
    wcm_processing_state:        wcm.processing_state,
    wcm_who_hung_up:             wcm.who_hung_up,
    wcm_post_dial_delay_seconds: numOrNull(wcm.post_dial_delay_seconds),
    wcm_last_sip_response:       wcm.last_sip_response ?? null,
    wcm_from_number:             wcmFrom.number,
    wcm_to_number:                wcmTo.number,
    wcm_to_connection:            wcmTo.connection,
    wcm_to_country:               wcmTo.country,
    wcm_edge_type:                wcmEdge.edge_type,
    wcm_inbound_rtt_avg_ms:       numOrNull(wcmIn.rtt_avg_ms),
    wcm_inbound_jitter_avg_ms:    numOrNull(wcmIn.jitter_avg_ms),
    wcm_inbound_packet_loss_pct:  numOrNull(wcmIn.packet_loss_pct),
    wcm_inbound_mos_avg:          numOrNull(wcmIn.mos_avg),
    wcm_outbound_codec:           pick(wcmEdge, 'outbound.codec'),
    wcm_tags:                     arrOrNull(wcm.tags)
  };
}

// ---------- Mock fixture (used when MOCK_API=1) ----------
// Two pages of realistic-ish data covering all flattener edge cases:
//   - full + partial + sparse issues
//   - supervisors, recent_tasks, status_history, queues, skills+levels
//   - call_metrics (from/to/edge/inbound/outbound, tags)
//   - worker_call_metrics
//   - hardware_config + network_diagnostics + permissions
//   - console_output (to verify it's stripped from raw_payload)
//   - pagination via next_cursor
const MOCK_PAGES = {
  null: {
    next_cursor: 'page-2',
    issues: [
      {
        issue_id: 'iss_mock_0001',
        issue_type: 'technical_issue',
        status: 'open',
        agent_worker_sid: 'WK1111111111111111111111111111aaaa',
        agent_name: 'Ada Lovelace',
        team_sid: 'TM222222222222222222222222222222',
        team_name: 'Calculus West',
        created_at: '2026-05-27T19:00:00Z',
        updated_at: '2026-05-27T19:05:00Z',
        plugin_version: '2.41.0',
        supervisors: [
          { worker_sid: 'WKsuper1', email: 'supervisor.one@varsitytutors.com' },
          { worker_sid: 'WKsuper2', email: 'supervisor.two@varsitytutors.com' }
        ],
        report: {
          agent_description: 'Audio dropped mid-session, then call disconnected.',
          worker_attributes: {
            full_name: 'Ada Lovelace',
            email: 'ada@varsitytutors.com',
            manager_id: 9001,
            team_id: 'team_calc_w',
            roles: ['agent', 'tutor'],
            routing: {
              queues: ['general_queue', 'calculus_queue', 'priority_queue'],
              skills: ['calculus', 'algebra', 'spanish'],
              levels: { calculus: 5, algebra: 4, spanish: 2 }
            }
          },
          hardware_config: {
            browser: 'Chrome 124',
            user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36',
            flex_version: '2.41.0',
            os: 'macOS 14.5',
            timezone: 'America/Chicago',
            audio_input: 'MacBook Pro Microphone',
            audio_output: 'AirPods Pro',
            permissions: { microphone: true, notifications: true },
            memory_limit_gb: 16,
            memory_used_gb: 11.4
          },
          network_diagnostics: {
            effective_type: '4g',
            downlink: 18.5,
            rtt: 50
          },
          console_output: 'SHOULD_BE_STRIPPED line 1\nSHOULD_BE_STRIPPED line 2',
          recent_tasks: [
            {
              task_sid: 'WTtask1',
              conference_sid: 'CFconf1',
              customer_call_sid: 'CAcust1',
              worker_call_sid: 'CAwork1',
              channel: 'voice',
              skill: 'calculus',
              entity_type: 'lesson',
              entity_id: 42,
              call_metrics: {
                call_state: 'completed',
                processing_state: 'complete',
                who_hung_up: 'customer',
                post_dial_delay_seconds: 1.2,
                last_sip_response: 200,
                verified_caller: true,
                from:  { number: '+15551110000', connection: 'pstn',   country: 'US', carrier: 'verizon' },
                to:    { number: '+15552220000', connection: 'client', country: 'US', carrier: 'twilio' },
                edge:  {
                  edge_type: 'roaming', edge_location: 'ashburn', media_region: 'us1',
                  inbound:  { codec: 'opus', jitter_avg_ms: 4.2, packet_loss_pct: 0.5, latency_avg_ms: 62, rtt_avg_ms: 70, mos_avg: 4.3 },
                  outbound: { codec: 'opus', latency_avg_ms: 60, jitter_avg_ms: 3.9, packet_loss_pct: 0.2 }
                },
                tags: ['high_latency']
              },
              worker_call_metrics: {
                call_state: 'completed',
                processing_state: 'complete',
                who_hung_up: 'customer',
                post_dial_delay_seconds: 0.8,
                last_sip_response: 200,
                from: { number: '+15552220000' },
                to:   { number: '+15551110000', connection: 'pstn', country: 'US' },
                edge: {
                  edge_type: 'roaming',
                  inbound:  { rtt_avg_ms: 65, jitter_avg_ms: 5.1, packet_loss_pct: 0.7, mos_avg: 3.8 },
                  outbound: { codec: 'opus' }
                },
                tags: ['low_mos']
              }
            },
            {
              task_sid: 'WTtask2',
              conference_sid: 'CFconf2',
              customer_call_sid: 'CAcust2',
              worker_call_sid: 'CAwork2',
              channel: 'voice',
              skill: 'calculus',
              entity_type: 'lesson',
              entity_id: '43',
              call_metrics: {
                call_state: 'completed', processing_state: 'complete', who_hung_up: 'agent',
                from: { number: '+15553330000' }, to: { number: '+15554440000' },
                edge: { edge_type: 'roaming' },
                tags: []
              },
              worker_call_metrics: { call_state: 'completed' }
            }
          ],
          status_history: [
            { activity_name: 'Available',  timestamp: '2026-05-27T18:30:00Z' },
            { activity_name: 'Busy',       timestamp: '2026-05-27T18:50:00Z' },
            { activity_name: 'Wrap Up',    timestamp: '2026-05-27T19:02:00Z' },
            { activity_name: 'Available',  timestamp: '2026-05-27T19:04:30Z' }
          ]
        }
      },
      // Sparse issue — most optional fields missing. Tests null handling.
      {
        issue_id: 'iss_mock_0002',
        issue_type: 'technical_issue',
        status: 'open',
        agent_worker_sid: 'WK1111111111111111111111111111bbbb',
        agent_name: 'Grace Hopper',
        team_sid: null,
        team_name: null,
        created_at: '2026-05-27T19:10:00Z',
        updated_at: '2026-05-27T19:10:00Z',
        plugin_version: '2.41.0',
        supervisors: [],
        report: {
          agent_description: null,
          worker_attributes: {
            full_name: 'Grace Hopper',
            email: 'grace@varsitytutors.com',
            team_id: 'team_unknown',
            roles: [],
            routing: { queues: [], skills: [], levels: {} }
          },
          hardware_config: {},
          network_diagnostics: {},
          recent_tasks: [],
          status_history: []
        }
      }
    ]
  },
  'page-2': {
    next_cursor: null,
    issues: [
      {
        issue_id: 'iss_mock_0003',
        issue_type: 'technical_issue',
        status: 'resolved',
        agent_worker_sid: 'WK1111111111111111111111111111cccc',
        agent_name: 'Margaret Hamilton',
        team_sid: 'TM333333333333333333333333333333',
        team_name: 'Aerospace South',
        created_at: '2026-05-27T19:20:00Z',
        updated_at: '2026-05-27T19:25:00Z',
        plugin_version: '2.40.9',
        supervisors: [
          { worker_sid: 'WKsuper3', email: 'supervisor.three@varsitytutors.com' }
        ],
        report: {
          agent_description: 'Browser crashed after 30 minutes of use.',
          worker_attributes: {
            full_name: 'Margaret Hamilton',
            email: 'margaret@varsitytutors.com',
            manager_id: 9002,
            team_id: 'team_aero_s',
            roles: ['agent'],
            routing: {
              queues: ['priority_queue'],
              skills: ['physics'],
              levels: { physics: 5 }
            }
          },
          hardware_config: {
            browser: 'Firefox 126',
            user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0)',
            flex_version: '2.40.9',
            os: 'Ubuntu 22.04',
            timezone: 'America/Los_Angeles',
            permissions: { microphone: true, notifications: false },
            memory_limit_gb: 8,
            memory_used_gb: 7.8
          },
          network_diagnostics: { effective_type: '3g', downlink: 2.1, rtt: 220 },
          console_output: 'SHOULD_BE_STRIPPED too',
          recent_tasks: [],
          status_history: [
            { activity_name: 'Available', timestamp: '2026-05-27T19:18:00Z' },
            { activity_name: 'Offline',   timestamp: '2026-05-27T19:24:00Z' }
          ]
        }
      }
    ]
  }
};

function mockPage(cursor) {
  const key = cursor || 'null';
  const page = MOCK_PAGES[key === 'null' ? null : key] ?? MOCK_PAGES[key];
  if (!page) throw new Error(`mock: unknown cursor ${cursor}`);
  return page;
}

// ---------- API fetcher ----------
async function fetchPage(cursor) {
  const url = new URL(API_PATH, API_BASE);
  url.searchParams.set('issue_type', ISSUE_TYPE);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);

  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${BEARER_TOKEN}`,
      'Accept':        'application/json'
    }
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API ${resp.status} ${resp.statusText} :: ${body.slice(0, 500)}`);
  }
  return resp.json();
}

// ---------- upsert helpers ----------
async function upsertIssues(rows) {
  if (DRY_RUN) return;
  if (!rows.length) return;
  const { error } = await supabase
    .from('vt_flex_issues')
    .upsert(rows, { onConflict: 'issue_id' });
  if (error) throw new Error(`upsert vt_flex_issues: ${error.message}`);
}

async function replaceChildren(table, issueIds, rows) {
  if (DRY_RUN) return;
  if (!issueIds.length) return;
  // wipe existing children for these issue_ids, then insert fresh.
  // This keeps the child rows in sync if the API mutates them.
  const { error: delErr } = await supabase
    .from(table).delete().in('issue_id', issueIds);
  if (delErr) throw new Error(`delete ${table}: ${delErr.message}`);
  if (!rows.length) return;
  const { error: insErr } = await supabase.from(table).insert(rows);
  if (insErr) throw new Error(`insert ${table}: ${insErr.message}`);
}

async function recordRun(stats) {
  if (DRY_RUN) return;
  await supabase.from('vt_flex_sync_runs').insert([stats]);
}

// ---------- main ----------
async function main() {
  const startedAt = new Date().toISOString();
  let pagesFetched   = 0;
  let issuesUpserted = 0;
  let cursor = null;

  try {
    do {
      const data = MOCK_API ? mockPage(cursor) : await fetchPage(cursor);
      pagesFetched += 1;

      const issues = Array.isArray(data.issues) ? data.issues : [];
      const issueRows       = [];
      const supervisorRows  = [];
      const taskRows        = [];
      const historyRows     = [];
      const queueRows       = [];
      const skillRows       = [];
      const issueIdsInBatch = [];

      for (const raw of issues) {
        const id = raw.issue_id;
        if (!id) continue;
        issueIdsInBatch.push(id);
        issueRows.push(flattenIssue(raw));

        // supervisors
        for (const s of (raw.supervisors || [])) {
          supervisorRows.push({
            issue_id: id,
            supervisor_worker_sid: s.worker_sid,
            supervisor_email:      s.email
          });
        }

        // recent tasks
        const tasks = raw.report?.recent_tasks || [];
        tasks.forEach((t, idx) => taskRows.push(flattenTask(id, t, idx)));

        // status history
        const hist = raw.report?.status_history || [];
        hist.forEach((h, idx) => historyRows.push({
          issue_id:      id,
          status_order:  idx,
          activity_name: h.activity_name,
          activity_at:   h.timestamp
        }));

        // worker routing - queues
        const queues = raw.report?.worker_attributes?.routing?.queues || [];
        for (const q of queues) {
          queueRows.push({ issue_id: id, queue_name: q });
        }

        // worker routing - skills + levels
        const skills = raw.report?.worker_attributes?.routing?.skills || [];
        const levels = raw.report?.worker_attributes?.routing?.levels || {};
        for (const sk of skills) {
          skillRows.push({
            issue_id:    id,
            skill_name:  sk,
            skill_level: levels[sk] ?? null
          });
        }
      }

      if (DRY_RUN && pagesFetched === 1 && issueRows.length) {
        console.log('--- sample flattened issue ---');
        console.log(JSON.stringify(issueRows[0], null, 2));
        console.log('--- sample task (if any) ---');
        console.log(JSON.stringify(taskRows[0] || null, null, 2));
        console.log('--- batch row counts ---');
        console.log(JSON.stringify({
          issues: issueRows.length,
          supervisors: supervisorRows.length,
          tasks: taskRows.length,
          status_history: historyRows.length,
          queues: queueRows.length,
          skills: skillRows.length
        }, null, 2));
      }

      await upsertIssues(issueRows);
      await replaceChildren('vt_flex_issue_supervisors', issueIdsInBatch, supervisorRows);
      await replaceChildren('vt_flex_recent_tasks',      issueIdsInBatch, taskRows);
      await replaceChildren('vt_flex_status_history',    issueIdsInBatch, historyRows);
      await replaceChildren('vt_flex_worker_queues',     issueIdsInBatch, queueRows);
      await replaceChildren('vt_flex_worker_skills',     issueIdsInBatch, skillRows);

      issuesUpserted += issueRows.length;
      console.log(`Page ${pagesFetched}: upserted ${issueRows.length} issues (running total ${issuesUpserted})`);

      cursor = data.next_cursor || null;
      if (pagesFetched >= MAX_PAGES) {
        console.warn(`Hit MAX_PAGES=${MAX_PAGES}, stopping.`);
        break;
      }
    } while (cursor);

    await recordRun({
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      pages_fetched: pagesFetched,
      issues_upserted: issuesUpserted,
      status: 'success',
      error_message: null
    });
    console.log(`Done. Pages: ${pagesFetched}, issues: ${issuesUpserted}`);
  } catch (err) {
    console.error('Sync failed:', err);
    await recordRun({
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      pages_fetched: pagesFetched,
      issues_upserted: issuesUpserted,
      status: 'failed',
      error_message: String(err?.message || err).slice(0, 1000)
    });
    process.exit(1);
  }
}

main();
