import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, format, startOfDay } from 'date-fns';
import { supabase } from '../lib/supabase.js';

const PAGE_SIZE = 1000;
const STARLINK_COHORT = new Set([
  'Christina Buchanan',
  'Stacy Bennett',
  'Jenna Bass',
  'Natalie Cardenas',
  'Raven Tolbert',
  'Seth Hart',
  'Virginia Bailey-Barnes'
]);

const SORT_KEYS = [
  ['agent_name', 'Rep'],
  ['manager_name', 'Manager'],
  ['calls', 'Calls'],
  ['tech_n', 'Tech'],
  ['tech_pct', 'Tech %'],
  ['ge15', '≥15m'],
  ['tech_ge15', '≥15m tech'],
  ['tech_ge15_pct', '≥15m tech %']
];

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultRange() {
  const end = startOfDay(new Date());
  const start = addDays(end, -13);
  return { start: toLocalDateStr(start), end: toLocalDateStr(end) };
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Number(n).toFixed(2)}%`;
}

function aggregateRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const name = r.agent_name;
    if (!name) continue;
    let cur = map.get(name);
    if (!cur) {
      cur = {
        agent_name: name,
        manager_name: '',
        managerCounts: new Map(),
        calls: 0,
        tech_n: 0,
        ge15: 0,
        tech_ge15: 0
      };
      map.set(name, cur);
    }
    const mgr = (r.regional_director || '').trim();
    if (mgr) {
      cur.managerCounts.set(mgr, (cur.managerCounts.get(mgr) || 0) + 1);
    }
    const isTech = String(r.disconnect_label || '').toLowerCase().includes('technical');
    const ge15 = Number(r.call_duration_s) >= 900;
    cur.calls += 1;
    if (isTech) cur.tech_n += 1;
    if (ge15) {
      cur.ge15 += 1;
      if (isTech) cur.tech_ge15 += 1;
    }
  }

  return [...map.values()].map((r) => {
    let manager_name = '';
    let best = 0;
    for (const [mgr, n] of r.managerCounts) {
      if (n > best) {
        best = n;
        manager_name = mgr;
      }
    }
    return {
      agent_name: r.agent_name,
      manager_name,
      calls: r.calls,
      tech_n: r.tech_n,
      ge15: r.ge15,
      tech_ge15: r.tech_ge15,
      tech_pct: r.calls ? (100 * r.tech_n) / r.calls : null,
      tech_ge15_pct: r.ge15 ? (100 * r.tech_ge15) / r.ge15 : null
    };
  });
}

function summarize(rows) {
  const calls = rows.reduce((s, r) => s + r.calls, 0);
  const tech_n = rows.reduce((s, r) => s + r.tech_n, 0);
  const ge15 = rows.reduce((s, r) => s + r.ge15, 0);
  const tech_ge15 = rows.reduce((s, r) => s + r.tech_ge15, 0);
  return {
    calls,
    tech_n,
    tech_pct: calls ? (100 * tech_n) / calls : null,
    ge15,
    tech_ge15,
    tech_ge15_pct: ge15 ? (100 * tech_ge15) / ge15 : null,
    reps: rows.length
  };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(rows, start, end) {
  const headers = [
    'Rep', 'Manager', 'Calls', 'Tech', 'Tech %', '≥15m', '≥15m tech', '≥15m tech %'
  ];
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.agent_name),
      csvEscape(r.manager_name),
      csvEscape(r.calls),
      csvEscape(r.tech_n),
      csvEscape(r.tech_pct == null ? '' : Number(r.tech_pct).toFixed(2)),
      csvEscape(r.ge15),
      csvEscape(r.tech_ge15),
      csvEscape(r.tech_ge15_pct == null ? '' : Number(r.tech_ge15_pct).toFixed(2))
    ].join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tech-disconnects-${start}_${end}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TechDisconnectPanel({ active = false, onLoadReady }) {
  const defaults = defaultRange();
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [repSearch, setRepSearch] = useState('');
  const [managerFilter, setManagerFilter] = useState('all');
  const [managerSearch, setManagerSearch] = useState('');
  const [sortKey, setSortKey] = useState('tech_ge15');
  const [sortDir, setSortDir] = useState('desc');
  const [hideZero, setHideZero] = useState(false);

  const load = useCallback(async () => {
    if (!start || !end) return;
    setLoading(true);
    setError(null);
    try {
      const startISO = new Date(`${start}T00:00:00`).toISOString();
      const endISO = addDays(new Date(`${end}T00:00:00`), 1).toISOString();

      const collected = [];
      let from = 0;
      for (;;) {
        const { data, error: qErr } = await supabase
          .from('langfuse_call_scoring_new_sales')
          .select('agent_name,call_duration_s,disconnect_label,regional_director')
          .gte('called_at_utc', startISO)
          .lt('called_at_utc', endISO)
          .not('agent_name', 'is', null)
          .range(from, from + PAGE_SIZE - 1);
        if (qErr) throw qErr;
        const chunk = data || [];
        collected.push(...chunk);
        if (chunk.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      setRows(aggregateRows(collected));
    } catch (e) {
      setRows([]);
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    onLoadReady?.(() => load);
  }, [onLoadReady, load]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const companyTotals = useMemo(() => summarize(rows), [rows]);

  const managerOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) {
      if (r.manager_name) set.add(r.manager_name);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filtered = useMemo(() => {
    const rq = repSearch.trim().toLowerCase();
    const mq = managerSearch.trim().toLowerCase();
    let list = rows;
    if (rq) {
      list = list.filter((r) => r.agent_name.toLowerCase().includes(rq));
    }
    if (managerFilter !== 'all') {
      list = list.filter((r) => r.manager_name === managerFilter);
    }
    if (mq) {
      list = list.filter((r) =>
        (r.manager_name || '').toLowerCase().includes(mq)
      );
    }
    if (hideZero) {
      list = list.filter((r) => r.tech_n > 0);
    }
    return list;
  }, [rows, repSearch, managerFilter, managerSearch, hideZero]);

  const filteredTotals = useMemo(() => summarize(filtered), [filtered]);
  const filtersActive =
    Boolean(repSearch.trim()) ||
    managerFilter !== 'all' ||
    Boolean(managerSearch.trim()) ||
    hideZero;

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null || av === '') return 1;
      if (bv == null || bv === '') return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc'
          ? av.localeCompare(bv)
          : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(key === 'agent_name' || key === 'manager_name' ? 'asc' : 'desc');
  }

  function clearFilters() {
    setRepSearch('');
    setManagerFilter('all');
    setManagerSearch('');
    setHideZero(false);
  }

  const rangeLabel = useMemo(() => {
    try {
      const s = new Date(`${start}T00:00:00`);
      const e = new Date(`${end}T00:00:00`);
      return `${format(s, 'MMM d')} – ${format(e, 'MMM d, yyyy')}`;
    } catch {
      return `${start} – ${end}`;
    }
  }, [start, end]);

  return (
    <main className="max-w-[1600px] mx-auto px-6 lg:px-10 pb-20">
      <section className="mt-8 flex flex-col gap-2">
        <h2 className="font-display text-3xl">Technical disconnects</h2>
        <p className="text-sm text-ink/60 max-w-3xl">
          Consumer new-sales Langfuse scoring (
          <code className="font-mono text-xs">langfuse_call_scoring_new_sales</code>
          ). Tech = <code className="font-mono text-xs">disconnect_label</code> matching{' '}
          <code className="font-mono text-xs">technical%</code>. Manager comes from{' '}
          <code className="font-mono text-xs">regional_director</code> on the scored call.
        </p>
      </section>

      <section className="mt-6 grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div className="xl:col-span-5 card p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h3 className="font-display text-xl">Whole company</h3>
            <span className="label-tag">{rangeLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Reps" value={companyTotals.reps.toLocaleString()} compact />
            <StatCard label="Scored calls" value={companyTotals.calls.toLocaleString()} compact />
            <StatCard
              label="Tech disconnects"
              value={`${companyTotals.tech_n.toLocaleString()} · ${fmtPct(companyTotals.tech_pct)}`}
              compact
            />
            <StatCard
              label="≥15m tech"
              value={`${companyTotals.tech_ge15.toLocaleString()} · ${fmtPct(companyTotals.tech_ge15_pct)}`}
              emphasize
              compact
            />
          </div>
        </div>

        <div className="xl:col-span-7 card p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h3 className="font-display text-xl">Filters</h3>
            {filtersActive ? (
              <button type="button" className="btn" onClick={clearFilters}>
                Clear · show company
              </button>
            ) : (
              <span className="label-tag">showing all reps</span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <label className="label-tag block mb-1">Rep name</label>
              <input
                type="text"
                className="field"
                placeholder="search rep…"
                value={repSearch}
                onChange={(e) => setRepSearch(e.target.value)}
              />
            </div>
            <div>
              <label className="label-tag block mb-1">Manager</label>
              <select
                className="field"
                value={managerFilter}
                onChange={(e) => setManagerFilter(e.target.value)}
              >
                <option value="all">All managers</option>
                {managerOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-tag block mb-1">Search manager</label>
              <input
                type="text"
                className="field"
                placeholder="type manager name…"
                value={managerSearch}
                onChange={(e) => setManagerSearch(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink/70 pb-2">
              <input
                type="checkbox"
                checked={hideZero}
                onChange={(e) => setHideZero(e.target.checked)}
              />
              Hide zero tech
            </label>
          </div>
          {filtersActive ? (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 border-t border-ink/10 pt-4">
              <StatCard label="Filtered reps" value={filteredTotals.reps.toLocaleString()} compact />
              <StatCard label="Filtered calls" value={filteredTotals.calls.toLocaleString()} compact />
              <StatCard
                label="Filtered tech"
                value={`${filteredTotals.tech_n.toLocaleString()} · ${fmtPct(filteredTotals.tech_pct)}`}
                compact
              />
              <StatCard
                label="Filtered ≥15m tech"
                value={`${filteredTotals.tech_ge15.toLocaleString()} · ${fmtPct(filteredTotals.tech_ge15_pct)}`}
                emphasize
                compact
              />
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-6 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <div>
          <label className="label-tag block mb-1">Start</label>
          <input
            type="date"
            className="field"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div>
          <label className="label-tag block mb-1">End</label>
          <input
            type="date"
            className="field"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
        <div className="md:col-span-3" />
        <button
          type="button"
          className="btn disabled:opacity-40"
          disabled={sorted.length === 0}
          onClick={() => downloadCsv(sorted, start, end)}
        >
          ↓ CSV
        </button>
      </section>

      {error && (
        <div className="mt-4 p-4 border-2 border-ember bg-ember/10 font-mono text-sm">
          <strong>Error:</strong> {error}
        </div>
      )}

      <section className="mt-8">
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="font-display text-2xl">
            Per rep{' '}
            <span className="font-sans text-base text-ink/50 ml-2">
              {sorted.length}
              {filtersActive ? ` of ${rows.length}` : ''}
              {loading ? ' · loading…' : ''}
            </span>
          </h3>
          <span className="label-tag">{rangeLabel}</span>
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/15 text-left">
                {SORT_KEYS.map(([key, label]) => (
                  <th key={key} className="px-3 py-3">
                    <button
                      type="button"
                      className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink/60 hover:text-ink"
                      onClick={() => toggleSort(key)}
                    >
                      {label}
                      {sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!loading && sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-ink/50 font-mono text-xs">
                    No scored calls match these filters
                  </td>
                </tr>
              ) : null}
              {sorted.map((r) => (
                <tr key={r.agent_name} className="border-b border-ink/8 hover:bg-bone/30">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{r.agent_name}</span>
                      {STARLINK_COHORT.has(r.agent_name) ? (
                        <span className="pill text-rust border-rust/30">starlink pilot</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink/80">
                    {r.manager_name || '—'}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-right tabular-nums">{r.calls}</td>
                  <td className="px-3 py-2.5 font-mono text-right tabular-nums">{r.tech_n}</td>
                  <td className="px-3 py-2.5 font-mono text-right tabular-nums">{fmtPct(r.tech_pct)}</td>
                  <td className="px-3 py-2.5 font-mono text-right tabular-nums">{r.ge15}</td>
                  <td className="px-3 py-2.5 font-mono text-right tabular-nums font-semibold">
                    {r.tech_ge15}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-right tabular-nums">
                    {fmtPct(r.tech_ge15_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-10 text-sm text-ink/55 space-y-2 max-w-3xl">
        <h3 className="font-display text-xl text-ink">Definitions</h3>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Technical disconnect:</strong> Langfuse{' '}
            <code className="font-mono text-xs">disconnect_label</code> contains{' '}
            <code className="font-mono text-xs">technical</code> (usually{' '}
            <code className="font-mono text-xs">technical_disconnect</code>).
          </li>
          <li>
            <strong>Manager:</strong> most common{' '}
            <code className="font-mono text-xs">regional_director</code> on that
            rep&apos;s scored calls in the selected range (same field as performance-dash
            manager_name).
          </li>
          <li>
            <strong>≥15m:</strong> scored calls with duration ≥ 900 seconds.
          </li>
          <li>
            Whole-company stats always cover the full date range. Filtered stats appear
            when a rep/manager filter is active.
          </li>
        </ul>
      </footer>
    </main>
  );
}

function StatCard({ label, value, emphasize, compact }) {
  return (
    <article className={compact ? '' : 'card p-4'}>
      <div className="label-tag">{label}</div>
      <div
        className={
          (compact ? 'mt-1 font-display text-xl leading-none ' : 'mt-2 font-display text-2xl leading-none ') +
          (emphasize ? 'text-rust' : '')
        }
      >
        {value}
      </div>
    </article>
  );
}
