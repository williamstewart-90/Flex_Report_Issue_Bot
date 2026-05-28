// Hardcoded so escalated_ops / resolved stay selectable even if no rows
// in the current range have that status. Add new statuses here as they
// appear in the upstream data.
const STATUS_OPTIONS = [
  { value: 'open',           label: 'Open' },
  { value: 'escalated_ops',  label: 'Escalated Ops' },
  { value: 'resolved',       label: 'Resolved' }
];

export default function FilterBar({ filters, setFilters, teams, agents }) {
  const upd = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
      <div className="md:col-span-2">
        <label className="label-tag block mb-1">Search</label>
        <input
          type="text"
          className="field"
          placeholder="agent, description, email, sid…"
          value={filters.search}
          onChange={(e) => upd('search', e.target.value)}
        />
      </div>
      <div>
        <label className="label-tag block mb-1">Team</label>
        <select className="field" value={filters.team} onChange={(e) => upd('team', e.target.value)}>
          <option value="all">All teams</option>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label className="label-tag block mb-1">Agent</label>
        <select className="field" value={filters.agent} onChange={(e) => upd('agent', e.target.value)}>
          <option value="all">All agents</option>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div>
        <label className="label-tag block mb-1">Status</label>
        <select className="field" value={filters.status} onChange={(e) => upd('status', e.target.value)}>
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label-tag block mb-1">Range</label>
        <select className="field" value={filters.rangeDays}
                onChange={(e) => upd('rangeDays', parseInt(e.target.value, 10))}>
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
    </div>
  );
}
