import { useMemo } from 'react';

export default function IssuesByTeamChart({ issues }) {
  const data = useMemo(() => {
    const m = new Map();
    for (const i of issues) {
      const k = i.team_name || 'unknown';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(m, ([team, count]) => ({ team, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [issues]);

  const max = Math.max(1, ...data.map((d) => d.count));

  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.team} className="grid grid-cols-[1fr_auto] gap-2 items-center">
          <div>
            <div className="text-xs truncate">{d.team}</div>
            <div className="h-1.5 bg-bone/60 mt-1 relative">
              <div
                className="absolute inset-y-0 left-0 bg-ink"
                style={{ width: `${(d.count / max) * 100}%` }}
              />
            </div>
          </div>
          <div className="font-mono text-sm tabular-nums w-8 text-right">{d.count}</div>
        </div>
      ))}
      {!data.length && <div className="text-ink/40 font-mono text-xs">no data</div>}
    </div>
  );
}
