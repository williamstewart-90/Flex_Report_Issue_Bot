import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase.js';
import Header from './components/Header.jsx';
import StatsBar from './components/StatsBar.jsx';
import FilterBar from './components/FilterBar.jsx';
import IssuesTable from './components/IssuesTable.jsx';
import IssueDetail from './components/IssueDetail.jsx';
import IssuesByTeamChart from './components/IssuesByTeamChart.jsx';
import IssuesOverTimeChart from './components/IssuesOverTimeChart.jsx';

export default function App({ session }) {
  const [issues, setIssues]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [selected, setSelected] = useState(null);
  const [lastSync, setLastSync] = useState(null);

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
      const { data, error: err } = await supabase
        .from('vt_flex_issues')
        .select('*')
        .gte('issue_created_at', since)
        .order('issue_created_at', { ascending: false })
        .limit(1000);
      if (err) throw err;
      setIssues(data || []);

      const { data: runs } = await supabase
        .from('vt_flex_sync_runs')
        .select('completed_at, status')
        .order('completed_at', { ascending: false })
        .limit(1);
      if (runs && runs[0]) setLastSync(runs[0]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

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
        i.worker_email, i.issue_id, i.hw_timezone, i.plugin_version
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [issues, filters]);

  const teams   = useMemo(() => unique(issues.map((i) => i.team_name)), [issues]);
  const agents  = useMemo(() => unique(issues.map((i) => i.agent_name)), [issues]);
  const statuses = useMemo(() => unique(issues.map((i) => i.status)), [issues]);

  return (
    <div className="min-h-screen">
      <Header lastSync={lastSync} onRefresh={load} session={session} />

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
          </div>

          <FilterBar
            filters={filters}
            setFilters={setFilters}
            teams={teams}
            agents={agents}
            statuses={statuses}
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
      </main>

      {selected && (
        <IssueDetail
          issueRow={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}
