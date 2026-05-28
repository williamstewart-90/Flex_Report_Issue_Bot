import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase.js';
import Header from './components/Header.jsx';
import StatsBar from './components/StatsBar.jsx';
import FilterBar from './components/FilterBar.jsx';
import IssuesTable from './components/IssuesTable.jsx';
import IssueDetail from './components/IssueDetail.jsx';
import IssuesByTeamChart from './components/IssuesByTeamChart.jsx';
import IssuesOverTimeChart from './components/IssuesOverTimeChart.jsx';
import FlexChatbot from './components/FlexChatbot.jsx';

const TABS = [
  { id: 'reports',  label: 'Issue Reports', icon: '📋' },
  { id: 'helpbot',  label: 'Help Bot',      icon: '🛠️' }
];

export default function App({ session }) {
  const [activeTab, setActiveTab] = useState('reports');
  const [lastSync, setLastSync]   = useState(null);
  const [refreshFn, setRefreshFn] = useState(() => () => {});

  return (
    <div className="min-h-screen">
      <Header
        lastSync={activeTab === 'reports' ? lastSync : null}
        onRefresh={activeTab === 'reports' ? refreshFn : null}
        session={session}
      />

      <TabBar
        tabs={TABS}
        active={activeTab}
        onChange={setActiveTab}
      />

      {/* Both panels stay mounted; toggle visibility so chat history survives switches */}
      <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
        <Dashboard
          session={session}
          onLastSyncChange={setLastSync}
          onLoadReady={setRefreshFn}
        />
      </div>
      <div className={activeTab === 'helpbot' ? 'block' : 'hidden'}>
        <FlexChatbot session={session} />
      </div>
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <nav className="border-b border-ink/15 bg-paper/60 backdrop-blur sticky top-[88px] z-[5]">
      <div className="max-w-[1600px] mx-auto px-6 lg:px-10 flex items-stretch">
        {tabs.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={
                'px-5 py-3 font-mono text-xs uppercase tracking-[0.18em] border-b-2 transition-colors ' +
                (isActive
                  ? 'border-rust text-ink'
                  : 'border-transparent text-ink/45 hover:text-ink/70')
              }
            >
              <span className="mr-2">{t.icon}</span>
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Dashboard({ session, onLastSyncChange, onLoadReady }) {
  const [issues, setIssues]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [selected, setSelected] = useState(null);

  const [filters, setFilters] = useState({
    search:    '',
    team:      'all',
    status:    'all',
    agent:     'all',
    rangeDays: 7
  });

  async function load() {
    setLoading(true); setError(null);
    try {
      const since = new Date(Date.now() - filters.rangeDays * 86400_000).toISOString();
      // Embed the most recent task per issue (lowest task_order = most recent
      // per upstream API convention). PostgREST returns it as a sub-array;
      // we flatten to a scalar `most_recent_task_sid` for the table view.
      const { data, error: err } = await supabase
        .from('vt_flex_issues')
        .select('*, most_recent_task:vt_flex_recent_tasks(task_sid)')
        .gte('issue_created_at', since)
        .order('issue_created_at', { ascending: false })
        .order('task_order', { foreignTable: 'vt_flex_recent_tasks', ascending: true })
        .limit(1, { foreignTable: 'vt_flex_recent_tasks' })
        .limit(1000);
      if (err) throw err;
      const normalized = (data || []).map((row) => ({
        ...row,
        most_recent_task_sid: row.most_recent_task?.[0]?.task_sid || null
      }));
      setIssues(normalized);

      const { data: runs } = await supabase
        .from('vt_flex_sync_runs')
        .select('completed_at, status')
        .order('completed_at', { ascending: false })
        .limit(1);
      if (runs && runs[0]) {
        setLastSync(runs[0]);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function setLastSync(run) {
    onLastSyncChange?.(run);
  }

  // Expose `load` to the App-level Header so its Refresh button works.
  useEffect(() => {
    onLoadReady?.(() => load);
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.rangeDays]);

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return issues.filter((i) => {
      if (filters.team   !== 'all' && i.team_name      !== filters.team)   return false;
      if (filters.status !== 'all' && i.status         !== filters.status) return false;
      if (filters.agent  !== 'all' && i.agent_name     !== filters.agent)  return false;
      if (!q) return true;
      const hay = [
        i.agent_name, i.team_name, i.agent_description,
        i.worker_email, i.issue_id, i.hw_timezone, i.most_recent_task_sid
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [issues, filters]);

  const teams    = useMemo(() => unique(issues.map((i) => i.team_name)), [issues]);
  const agents   = useMemo(() => unique(issues.map((i) => i.agent_name)), [issues]);

  return (
    <main className="max-w-[1600px] mx-auto px-6 lg:px-10 pb-20">
      <StatsBar issues={filtered} loading={loading} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-8">
        <div className="xl:col-span-2 card p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-2xl">Issues over time</h2>
            <span className="label-tag">last {filters.rangeDays} days</span>
          </div>
          <IssuesOverTimeChart issues={filtered} days={filters.rangeDays} />
        </div>
        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-2xl">By team</h2>
            <span className="label-tag">top 10</span>
          </div>
          <IssuesByTeamChart issues={filtered} />
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="font-display text-3xl">
            Issues <span className="font-sans text-base text-ink/50 ml-2">{filtered.length}</span>
          </h2>
          <button
            type="button"
            onClick={() => downloadIssuesCsv(filtered)}
            disabled={filtered.length === 0}
            className="btn disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↓ Download CSV
          </button>
        </div>

        <FilterBar
          filters={filters}
          setFilters={setFilters}
          teams={teams}
          agents={agents}
        />

        {error && (
          <div className="mt-4 p-4 border-2 border-ember bg-ember/10 font-mono text-sm">
            <strong>Error:</strong> {error}
          </div>
        )}

        <IssuesTable
          rows={filtered}
          loading={loading}
          onSelect={setSelected}
        />
      </div>

      {selected && (
        <IssueDetail
          issueRow={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}

// ---------- CSV export ----------
// RFC 4180-ish: wrap every field in double quotes and escape embedded quotes.
// Always-quoting is simpler than conditional and Excel parses it correctly.
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildIssuesCsv(rows) {
  const headers = ['Agent Name', 'Description', 'Task SID'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.agent_name),
      csvEscape(r.agent_description),
      csvEscape(r.most_recent_task_sid)
    ].join(','));
  }
  // CRLF line endings per RFC 4180 — Excel and Sheets both prefer this.
  return lines.join('\r\n');
}

function downloadIssuesCsv(rows) {
  const csv = buildIssuesCsv(rows);
  // Prepend UTF-8 BOM so Excel renders unicode (em-dashes, accents, emoji)
  // correctly without manual import wizardry.
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `vt-flex-issues-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
