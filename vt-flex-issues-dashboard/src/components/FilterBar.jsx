// Hardcoded so escalated_ops / resolved stay selectable even if no rows
// in the current range have that status. Add new statuses here as they
// appear in the upstream data.
const STATUS_OPTIONS = [
  { value: 'open',           label: 'Open' },
  { value: 'escalated_ops',  label: 'Escalated Ops' },
  { value: 'resolved',       label: 'Resolved' }
];

// YYYY-MM-DD in local time. Avoids the UTC-shift gotcha of toISOString().slice(0,10),
// which can move a date by a day for users west of UTC right after midnight.
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function FilterBar({ filters, setFilters, teams, agents }) {
  const upd = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  // Range select handles two value families: numeric presets (7, 14, …) and
  // the 'custom' sentinel. Switching INTO custom seeds reasonable defaults so
  // the user isn't staring at empty date inputs; switching OUT leaves the
  // custom dates inert so they're remembered if the user toggles back.
  function onRangeChange(e) {
    const raw = e.target.value;
    const next = raw === 'custom' ? 'custom' : parseInt(raw, 10);
    setFilters((f) => {
      const out = { ...f, rangeDays: next };
      if (next === 'custom' && !f.rangeStart) {
        const days = typeof f.rangeDays === 'number' ? f.rangeDays : 7;
        const today = new Date();
        const start = new Date(today.getTime() - (days - 1) * 86400_000);
        out.rangeStart = toLocalDateStr(start);
        out.rangeEnd   = toLocalDateStr(today);
      }
      return out;
    });
  }

  const isCustom = filters.rangeDays === 'custom';
  const todayStr = toLocalDateStr(new Date());

  return (
    <div className="mb-4">
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
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
          <select className="field" value={isCustom ? 'custom' : filters.rangeDays} onChange={onRangeChange}>
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value="custom">Custom range…</option>
          </select>
        </div>
      </div>

      {isCustom && (
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mt-3">
          <div className="md:col-start-5">
            <label className="label-tag block mb-1">From</label>
            <input
              type="date"
              className="field"
              value={filters.rangeStart || ''}
              max={filters.rangeEnd || todayStr}
              onChange={(e) => upd('rangeStart', e.target.value)}
            />
          </div>
          <div>
            <label className="label-tag block mb-1">To</label>
            <input
              type="date"
              className="field"
              value={filters.rangeEnd || ''}
              min={filters.rangeStart || undefined}
              max={todayStr}
              onChange={(e) => upd('rangeEnd', e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
