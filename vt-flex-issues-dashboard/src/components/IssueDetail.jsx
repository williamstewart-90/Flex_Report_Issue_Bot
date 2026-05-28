import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { supabase } from '../lib/supabase.js';

export default function IssueDetail({ issueRow, onClose, onSendToHelpBot }) {
  const [supervisors, setSupervisors] = useState([]);
  const [tasks,       setTasks]       = useState([]);
  const [history,     setHistory]     = useState([]);
  const [queues,      setQueues]      = useState([]);
  const [skills,      setSkills]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [copied,      setCopied]      = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const id = issueRow.issue_id;
      const [s, t, h, q, sk] = await Promise.all([
        supabase.from('vt_flex_issue_supervisors').select('*').eq('issue_id', id),
        supabase.from('vt_flex_recent_tasks').select('*').eq('issue_id', id).order('task_order'),
        supabase.from('vt_flex_status_history').select('*').eq('issue_id', id).order('status_order'),
        supabase.from('vt_flex_worker_queues').select('*').eq('issue_id', id),
        supabase.from('vt_flex_worker_skills').select('*').eq('issue_id', id)
      ]);
      if (cancelled) return;
      setSupervisors(s.data || []);
      setTasks(t.data || []);
      setHistory(h.data || []);
      setQueues(q.data || []);
      setSkills(sk.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [issueRow.issue_id]);

  // Build the message the Help Bot will receive. We use raw_payload (the
  // original upstream JSON the sync script stored), so the bot sees the
  // exact shape its system prompt's "H. Analyzing a Flex Issue Report"
  // section was designed for — no flattening or translation.
  function buildHelpBotMessage() {
    const payload = issueRow.raw_payload ?? {
      // Defensive fallback if raw_payload is somehow missing (older rows
      // from before raw_payload was wired, or if it was nulled). The
      // assistant gets less rich data but can still triage.
      issue: issueRow,
      recent_tasks: tasks,
      supervisors,
      status_history: history,
      worker_queues: queues,
      worker_skills: skills
    };
    const prefix = `Please analyze this Flex issue report and give me the manager next steps:\n\n`;
    return prefix + '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to legacy path
    }
    // Legacy fallback (non-HTTPS or older browsers)
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  async function handleSendToHelpBot() {
    const message = buildHelpBotMessage();
    const ok = await copyToClipboard(message);
    if (!ok) {
      // eslint-disable-next-line no-alert
      alert('Copy failed. Switching to Help Bot — you may need to paste manually.');
    }
    setCopied(true);
    // Give the manager a beat to see the confirmation before the tab swap
    // hides this drawer.
    setTimeout(() => {
      onSendToHelpBot?.(message);
    }, 350);
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-ink/50" onClick={onClose} />
      <aside className="w-full max-w-[920px] h-full bg-paper border-l-2 border-ink overflow-y-auto">
        <div className="sticky top-0 bg-paper border-b border-ink/15 px-6 py-4 flex items-baseline justify-between gap-3">
          <div>
            <div className="label-tag">Issue</div>
            <div className="font-mono text-xs mt-0.5">{issueRow.issue_id}</div>
          </div>
          <div className="flex items-center gap-2">
            {onSendToHelpBot && (
              <button
                type="button"
                className="btn"
                onClick={handleSendToHelpBot}
                disabled={copied}
              >
                {copied ? '✓ Copied' : '↗ Copy for Help Bot'}
              </button>
            )}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="px-6 py-6 space-y-8">
          <Section title="Summary">
            <Grid>
              <Field label="Agent" value={issueRow.agent_name} />
              <Field label="Email" value={issueRow.worker_email} mono />
              <Field label="Team"  value={issueRow.team_name} />
              <Field label="Manager ID" value={issueRow.worker_manager_id} mono />
              <Field label="Status" value={issueRow.status} />
              <Field label="Plugin Version" value={issueRow.plugin_version} mono />
              <Field label="Created" value={fmt(issueRow.issue_created_at)} mono />
              <Field label="Updated" value={fmt(issueRow.issue_updated_at)} mono />
            </Grid>
            {issueRow.agent_description && (
              <div className="mt-4 p-4 bg-bone/30 border border-ink/10">
                <div className="label-tag mb-2">Agent description</div>
                <p className="text-sm whitespace-pre-wrap">{issueRow.agent_description}</p>
              </div>
            )}
          </Section>

          <Section title="Hardware">
            <Grid>
              <Field label="Browser"    value={issueRow.hw_browser} />
              <Field label="Flex"       value={issueRow.hw_flex_version} mono />
              <Field label="OS"         value={issueRow.hw_os || '—'} mono />
              <Field label="Timezone"   value={issueRow.hw_timezone} mono />
              <Field label="Audio in"   value={issueRow.hw_audio_input} />
              <Field label="Audio out"  value={issueRow.hw_audio_output} />
              <Field label="Mic perm"   value={issueRow.hw_permission_microphone} mono />
              <Field label="Notif perm" value={issueRow.hw_permission_notifications} mono />
              <Field label="Mem used"   value={issueRow.hw_memory_used_gb && `${issueRow.hw_memory_used_gb} GB`} mono />
              <Field label="Mem limit"  value={issueRow.hw_memory_limit_gb && `${issueRow.hw_memory_limit_gb} GB`} mono />
            </Grid>
          </Section>

          <Section title="Network">
            <Grid>
              <Field label="Effective" value={issueRow.net_effective_type} mono />
              <Field label="Downlink"  value={issueRow.net_downlink} mono />
              <Field label="RTT"       value={issueRow.net_rtt} mono />
            </Grid>
          </Section>

          <Section title={`Supervisors (${supervisors.length})`}>
            <ul className="space-y-1 font-mono text-xs">
              {supervisors.map((s) => (
                <li key={s.id} className="flex justify-between border-b border-ink/10 py-1">
                  <span>{s.supervisor_email}</span>
                  <span className="text-ink/40">{s.supervisor_worker_sid}</span>
                </li>
              ))}
              {!supervisors.length && !loading && <li className="text-ink/40">none</li>}
            </ul>
          </Section>

          <Section title={`Routing (${queues.length} queues, ${skills.length} skills)`}>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {queues.map((q) => <span key={q.id} className="pill">{q.queue_name}</span>)}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skills.map((sk) => (
                <span key={sk.id} className="pill">
                  {sk.skill_name} <span className="text-rust">·{sk.skill_level}</span>
                </span>
              ))}
            </div>
          </Section>

          <Section title={`Recent tasks (${tasks.length})`}>
            <div className="space-y-3">
              {tasks.map((t) => (
                <div key={t.id} className="border border-ink/15 p-3 font-mono text-[11px] space-y-1">
                  <div className="flex justify-between">
                    <span className="text-ink/60">task_sid</span>
                    <span>{t.task_sid}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink/60">conference_sid</span>
                    <span>{t.conference_sid || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink/60">channel / skill</span>
                    <span>{t.channel} / {t.skill || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink/60">customer call</span>
                    <span>{t.cm_call_state || 'pending'} {t.cm_who_hung_up ? `· hung up: ${t.cm_who_hung_up}` : ''}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink/60">from → to</span>
                    <span>{t.cm_from_number || '—'} → {t.cm_to_number || '—'}</span>
                  </div>
                  {t.cm_tags?.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-ink/60">tags</span>
                      <span className="text-rust">{t.cm_tags.join(', ')}</span>
                    </div>
                  )}
                  {t.wcm_inbound_mos_avg != null && (
                    <div className="flex justify-between">
                      <span className="text-ink/60">worker MOS / RTT</span>
                      <span>{t.wcm_inbound_mos_avg} / {t.wcm_inbound_rtt_avg_ms}ms</span>
                    </div>
                  )}
                </div>
              ))}
              {!tasks.length && !loading && <div className="text-ink/40 font-mono text-xs">none</div>}
            </div>
          </Section>

          <Section title={`Status history (${history.length})`}>
            <div className="font-mono text-xs space-y-0.5 max-h-80 overflow-y-auto">
              {history.map((h) => (
                <div key={h.id} className="flex justify-between border-b border-ink/10 py-1">
                  <span>{h.activity_name}</span>
                  <span className="text-ink/50">{fmt(h.activity_at, 'MMM d HH:mm:ss')}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

const Section = ({ title, children }) => (
  <section>
    <h3 className="font-display text-2xl mb-3">{title}</h3>
    {children}
  </section>
);
const Grid = ({ children }) => (
  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">{children}</div>
);
const Field = ({ label, value, mono }) => (
  <div>
    <div className="label-tag">{label}</div>
    <div className={mono ? 'font-mono text-xs mt-0.5' : 'text-sm mt-0.5'}>
      {value == null || value === '' ? <span className="text-ink/40">—</span> : value}
    </div>
  </div>
);
function fmt(d, pattern = 'MMM d, yyyy HH:mm') {
  if (!d) return null;
  try { return format(new Date(d), pattern); } catch { return d; }
}
