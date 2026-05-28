import { format } from 'date-fns';

export default function IssuesTable({ rows, loading, onSelect }) {
  if (loading) {
    return (
      <div className="border border-ink/15 p-12 text-center font-mono text-sm text-ink/50">
        Loading…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="border border-ink/15 p-12 text-center font-mono text-sm text-ink/50">
        No issues match the current filters.
      </div>
    );
  }

  return (
    <div className="border border-ink/15 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bone/50 border-b border-ink/15">
          <tr>
            <Th>Created</Th>
            <Th>Agent</Th>
            <Th>Team</Th>
            <Th>Status</Th>
            <Th>Description</Th>
            <Th>Timezone</Th>
            <Th>Task SID</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.issue_id}
              className={`${i % 2 === 0 ? 'bg-paper' : 'bg-bone/20'} hover:bg-rust/10 cursor-pointer transition-colors`}
              onClick={() => onSelect(r)}
            >
              <Td className="font-mono text-xs whitespace-nowrap">
                {r.issue_created_at ? format(new Date(r.issue_created_at), 'MMM d, HH:mm') : '—'}
              </Td>
              <Td>
                <div className="font-medium">{r.agent_name || '—'}</div>
                <div className="font-mono text-[10px] text-ink/50">{r.worker_email}</div>
              </Td>
              <Td className="text-sm">{r.team_name || '—'}</Td>
              <Td>
                <span className={`pill ${r.status === 'open' ? 'text-ember border-ember/40' : ''}`}>
                  {r.status}
                </span>
              </Td>
              <Td className="max-w-[420px]">
                <div className="line-clamp-2 text-[13px]">{r.agent_description || <span className="text-ink/40">—</span>}</div>
              </Td>
              <Td className="font-mono text-[11px]">{r.hw_timezone || '—'}</Td>
              <Td className="font-mono text-[11px] whitespace-nowrap">
                {r.most_recent_task_sid ? (
                  <span title={r.most_recent_task_sid}>
                    …{r.most_recent_task_sid.slice(-8)}
                  </span>
                ) : (
                  '—'
                )}
              </Td>
              <Td>
                <span className="font-mono text-[10px] text-rust">view →</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Th = ({ children }) => (
  <th className="text-left px-3 py-2 label-tag whitespace-nowrap">{children}</th>
);
const Td = ({ children, className = '' }) => (
  <td className={`px-3 py-3 align-top ${className}`}>{children}</td>
);
