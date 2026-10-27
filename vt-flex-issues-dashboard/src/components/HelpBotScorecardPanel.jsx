import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend
} from 'recharts';
import { supabase } from '../lib/supabase.js';

const WEEK_OPTIONS = [8, 12, 26];
const DAY_OPTIONS = [7, 28, 90];

// Targets shown next to the headline numbers. Coverage below target means
// the manager map in vt_flex_slack_team_managers has drifted.
const MENTION_TARGET_PCT = 95;

function pct(num, den) {
  return den ? (100 * num) / den : null;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function deriveWeek(w) {
  const issues = Number(w.issues);
  const reps = Number(w.reps);
  const posted = Number(w.posted);
  return {
    ...w,
    label: format(parseISO(w.week_start), 'MMM d'),
    mention_pct: pct(Number(w.mentioned), posted),
    repeat_pct: pct(Number(w.repeat_issues), issues),
    per_rep: reps ? issues / reps : null
  };
}

export default function HelpBotScorecardPanel({ active = false, onLoadReady }) {
  const [weeks, setWeeks] = useState(8);
  const [days, setDays] = useState(28);
  const [weekly, setWeekly] = useState([]);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, t] = await Promise.all([
        supabase.rpc('vt_flex_help_bot_scorecard_weekly', { p_weeks: weeks }),
        supabase.rpc('vt_flex_help_bot_scorecard_by_team', { p_days: days })
      ]);
      if (w.error) throw w.error;
      if (t.error) throw t.error;
      setWeekly((w.data || []).map(deriveWeek));
      setTeams(t.data || []);
    } catch (e) {
      setWeekly([]);
      setTeams([]);
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [weeks, days]);

  useEffect(() => {
    onLoadReady?.(() => load);
  }, [onLoadReady, load]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  // The current week is partial; compare the last two complete weeks.
  const lastFull = weekly.length >= 2 ? weekly[weekly.length - 2] : null;
  const priorFull = weekly.length >= 3 ? weekly[weekly.length - 3] : null;

  const unmapped = useMemo(
    () => teams.filter((t) => !t.mapped && Number(t.unmentioned) > 0),
    [teams]
  );
  const unmentionedTotal = useMemo(
    () => unmapped.reduce((s, t) => s + Number(t.unmentioned), 0),
    [unmapped]
  );

  return (
    <main className="max-w-[1600px] mx-auto px-6 lg:px-10 pb-20">
      <section className="mt-8 flex flex-col gap-2">
        <h2 className="font-display text-3xl">Help bot scorecard</h2>
        <p className="text-sm text-ink/60 max-w-3xl">
          Weekly health of the Slack manager-notification bot: is it reaching the right
          manager, and are reps still filing the same problem? Weeks start Monday, Central time.
          Headline numbers compare the last two complete weeks.
        </p>
      </section>

      <section className="mt-6 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi
          label="Manager @mention coverage"
          value={fmtPct(lastFull?.mention_pct)}
          prior={priorFull?.mention_pct}
          current={lastFull?.mention_pct}
          higherIsBetter
          emphasize={lastFull?.mention_pct != null && lastFull.mention_pct < MENTION_TARGET_PCT}
          hint={`target ≥ ${MENTION_TARGET_PCT}%`}
        />
        <Kpi
          label="Repeat within 24h"
          value={fmtPct(lastFull?.repeat_pct)}
          prior={priorFull?.repeat_pct}
          current={lastFull?.repeat_pct}
          higherIsBetter={false}
          hint="lower is better"
        />
        <Kpi
          label="Issues per rep"
          value={fmtNum(lastFull?.per_rep, 1)}
          prior={priorFull?.per_rep}
          current={lastFull?.per_rep}
          higherIsBetter={false}
          hint={`${fmtNum(lastFull?.reps)} reps reporting`}
        />
        <Kpi
          label="Slack posts"
          value={fmtNum(lastFull?.posted)}
          hint={`${fmtNum(lastFull?.filtered)} filtered · ${fmtNum(lastFull?.failed)} failed`}
          emphasize={Number(lastFull?.failed) > 0}
        />
        <Kpi
          label="Dashboard chatbot users"
          value={fmtNum(lastFull?.chat_users)}
          hint={`${fmtNum(lastFull?.chat_msgs)} messages`}
        />
        <Kpi
          label="Manager emails sent"
          value={fmtNum(lastFull?.emails_sent)}
          hint="excludes shadow mode"
        />
      </section>

      <section className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="label-tag block mb-1">Trend window</label>
          <select className="field" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {WEEK_OPTIONS.map((n) => <option key={n} value={n}>{n} weeks</option>)}
          </select>
        </div>
        <div>
          <label className="label-tag block mb-1">Team window</label>
          <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((n) => <option key={n} value={n}>last {n} days</option>)}
          </select>
        </div>
        {loading ? <span className="label-tag pb-2">loading…</span> : null}
      </section>

      {error && (
        <div className="mt-4 p-4 border-2 border-ember bg-ember/10 font-mono text-sm">
          <strong>Error:</strong> {error}
        </div>
      )}

      <section className="mt-6 card p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="font-display text-2xl">Coverage vs. repeats</h3>
          <span className="label-tag">weekly · current week is partial</span>
        </div>
        <TrendChart data={weekly} />
      </section>

      {unmapped.length > 0 ? (
        <section className="mt-6 p-4 border-2 border-rust/40 bg-rust/5">
          <h3 className="font-display text-xl">
            {fmtNum(unmentionedTotal)} posts went out with no @mention in the last {days} days
          </h3>
          <p className="text-sm text-ink/70 mt-1">
            Teams without a row in <code className="font-mono text-xs">vt_flex_slack_team_managers</code>:{' '}
            {unmapped.map((t) => `${t.team_name} (${fmtNum(t.unmentioned)})`).join(', ')}.
            Department buckets like Retention or default are expected here; a person&apos;s name
            usually means a new manager who needs a Slack ID.
          </p>
        </section>
      ) : null}

      <section className="mt-8">
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="font-display text-2xl">
            By team <span className="font-sans text-base text-ink/50 ml-2">{teams.length}</span>
          </h3>
          <span className="label-tag">last {days} days</span>
        </div>
        <TeamTable rows={teams} loading={loading} />
      </section>

      <section className="mt-8">
        <h3 className="font-display text-2xl mb-4">By week</h3>
        <WeekTable rows={weekly} />
      </section>

      <footer className="mt-10 text-sm text-ink/55 space-y-2 max-w-3xl">
        <h3 className="font-display text-xl text-ink">Definitions</h3>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>@mention coverage:</strong> share of posted Slack messages that tagged a
            manager. Misses come from <code className="font-mono text-xs">team_name</code> values
            with no row in the manager map.
          </li>
          <li>
            <strong>Repeat within 24h:</strong> technical issues filed by a rep who had already
            filed one in the previous 24 hours. A proxy for &quot;the first fix didn&apos;t stick&quot;
            or habitual reporting — either way, worth a manager conversation.
          </li>
          <li>
            <strong>Slack posts:</strong> counted by when the bot posted, not when the rep filed,
            so weekly totals can differ slightly from issue counts.
          </li>
          <li>
            Not yet tracked: whether a manager read or acted on a post. That needs the Slack bot
            token (the webhook doesn&apos;t return a message ID) plus reactions or buttons.
          </li>
        </ul>
      </footer>
    </main>
  );
}

function Kpi({ label, value, hint, prior, current, higherIsBetter = true, emphasize }) {
  let delta = null;
  if (prior != null && current != null) {
    const diff = current - prior;
    if (Math.abs(diff) >= 0.05) {
      const good = higherIsBetter ? diff > 0 : diff < 0;
      delta = (
        <span className={good ? 'text-moss' : 'text-ember'}>
          {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toFixed(1)}
        </span>
      );
    }
  }
  return (
    <article className="card p-4">
      <div className="label-tag">{label}</div>
      <div className={'mt-2 font-display text-2xl leading-none ' + (emphasize ? 'text-rust' : '')}>
        {value}
      </div>
      <div className="mt-2 font-mono text-[11px] text-ink/55 flex gap-2 flex-wrap">
        {delta}
        {hint ? <span>{hint}</span> : null}
      </div>
    </article>
  );
}

function TrendChart({ data }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgba(10,10,10,0.08)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} stroke="rgba(10,10,10,0.4)" />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} stroke="rgba(10,10,10,0.4)" unit="%" />
          <Tooltip
            formatter={(v) => fmtPct(v)}
            contentStyle={{
              background: '#0a0a0a', color: '#f5f1ea', border: 'none',
              fontFamily: 'JetBrains Mono', fontSize: 11
            }}
          />
          <Legend wrapperStyle={{ fontFamily: 'JetBrains Mono', fontSize: 11 }} />
          <Line type="monotone" dataKey="mention_pct" name="@mention coverage" stroke="#c2410c" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="repeat_pct" name="Repeat within 24h" stroke="#0a0a0a" strokeWidth={2} strokeDasharray="4 3" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const TH = 'px-3 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink/60';
const TD_NUM = 'px-3 py-2.5 font-mono text-right tabular-nums';

function TeamTable({ rows, loading }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink/15 text-left">
            <th className={TH}>Team</th>
            <th className={TH}>Mentions</th>
            <th className={TH + ' text-right'}>Issues</th>
            <th className={TH + ' text-right'}>Reps</th>
            <th className={TH + ' text-right'}>Per rep</th>
            <th className={TH + ' text-right'}>Repeat 24h</th>
            <th className={TH + ' text-right'}>Posts</th>
            <th className={TH + ' text-right'}>No @mention</th>
            <th className={TH}>Last issue</th>
          </tr>
        </thead>
        <tbody>
          {!loading && rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-ink/50 font-mono text-xs">
                No issues in this window
              </td>
            </tr>
          ) : null}
          {rows.map((r) => {
            const issues = Number(r.issues);
            const reps = Number(r.reps);
            return (
              <tr key={r.team_name} className="border-b border-ink/8 hover:bg-bone/30">
                <td className="px-3 py-2.5">{r.team_name}</td>
                <td className="px-3 py-2.5">
                  {r.mapped
                    ? <span className="text-ink/80">{r.mentions || '—'}</span>
                    : <span className="pill text-rust border-rust/30">not mapped</span>}
                </td>
                <td className={TD_NUM}>{fmtNum(issues)}</td>
                <td className={TD_NUM}>{fmtNum(reps)}</td>
                <td className={TD_NUM}>{fmtNum(reps ? issues / reps : null, 1)}</td>
                <td className={TD_NUM}>{fmtPct(pct(Number(r.repeat_issues), issues))}</td>
                <td className={TD_NUM}>{fmtNum(r.posted)}</td>
                <td className={TD_NUM + (Number(r.unmentioned) > 0 ? ' text-rust font-semibold' : '')}>
                  {fmtNum(r.unmentioned)}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-ink/60">
                  {r.last_issue_at
                    ? formatDistanceToNowStrict(new Date(r.last_issue_at), { addSuffix: true })
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WeekTable({ rows }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink/15 text-left">
            <th className={TH}>Week of</th>
            <th className={TH + ' text-right'}>Issues</th>
            <th className={TH + ' text-right'}>Reps</th>
            <th className={TH + ' text-right'}>Repeat 24h</th>
            <th className={TH + ' text-right'}>Posted</th>
            <th className={TH + ' text-right'}>@mention</th>
            <th className={TH + ' text-right'}>Filtered</th>
            <th className={TH + ' text-right'}>Failed</th>
            <th className={TH + ' text-right'}>Chat users</th>
            <th className={TH + ' text-right'}>Emails</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((w) => (
            <tr key={w.week_start} className="border-b border-ink/8 hover:bg-bone/30">
              <td className="px-3 py-2.5 font-mono text-xs">{w.label}</td>
              <td className={TD_NUM}>{fmtNum(w.issues)}</td>
              <td className={TD_NUM}>{fmtNum(w.reps)}</td>
              <td className={TD_NUM}>{fmtPct(w.repeat_pct)}</td>
              <td className={TD_NUM}>{fmtNum(w.posted)}</td>
              <td className={TD_NUM}>{fmtPct(w.mention_pct)}</td>
              <td className={TD_NUM}>{fmtNum(w.filtered)}</td>
              <td className={TD_NUM}>{fmtNum(w.failed)}</td>
              <td className={TD_NUM}>{fmtNum(w.chat_users)}</td>
              <td className={TD_NUM}>{fmtNum(w.emails_sent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
