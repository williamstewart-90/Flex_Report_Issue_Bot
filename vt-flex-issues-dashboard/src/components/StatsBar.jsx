import { useMemo } from 'react';

export default function StatsBar({ issues, loading }) {
  const stats = useMemo(() => {
    const total = issues.length;
    const uniqueAgents = new Set(issues.map((i) => i.agent_worker_sid)).size;
    const uniqueTeams  = new Set(issues.map((i) => i.team_sid)).size;
    const open = issues.filter((i) => i.status === 'open').length;
    return { total, uniqueAgents, uniqueTeams, open };
  }, [issues]);

  const cells = [
    { label: 'Total issues',     value: stats.total },
    { label: 'Open',             value: stats.open },
    { label: 'Distinct agents',  value: stats.uniqueAgents },
    { label: 'Distinct teams',   value: stats.uniqueTeams }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-0 mt-8 border border-ink/15">
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={`p-5 ${i < cells.length - 1 ? 'border-r border-ink/15' : ''}`}
        >
          <div className="label-tag">{c.label}</div>
          <div className="font-display text-5xl mt-2 tabular-nums">
            {loading ? <span className="text-ink/30">—</span> : c.value.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
