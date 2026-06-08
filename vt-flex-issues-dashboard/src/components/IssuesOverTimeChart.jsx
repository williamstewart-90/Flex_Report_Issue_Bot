import { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format, startOfDay, addDays, differenceInCalendarDays } from 'date-fns';

// Builds one bucket per day from startDate to endDate (inclusive). Anchoring
// on startDate (rather than "today minus N") lets custom historical ranges
// that don't end today render correctly.
export default function IssuesOverTimeChart({ issues, startDate, endDate }) {
  const data = useMemo(() => {
    if (!startDate || !endDate) return [];
    const start = startOfDay(startDate);
    const end   = startOfDay(endDate);
    const days  = Math.max(1, differenceInCalendarDays(end, start) + 1);
    const buckets = new Map();
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      buckets.set(d.toISOString(), { date: d, count: 0, label: format(d, 'MMM d') });
    }
    for (const i of issues) {
      if (!i.issue_created_at) continue;
      const k = startOfDay(new Date(i.issue_created_at)).toISOString();
      if (buckets.has(k)) buckets.get(k).count += 1;
    }
    return Array.from(buckets.values());
  }, [issues, startDate, endDate]);

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgba(10,10,10,0.08)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} stroke="rgba(10,10,10,0.4)" />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} stroke="rgba(10,10,10,0.4)" />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a', color: '#f5f1ea', border: 'none',
              fontFamily: 'JetBrains Mono', fontSize: 11
            }}
            cursor={{ fill: 'rgba(194,65,12,0.1)' }}
          />
          <Bar dataKey="count" fill="#c2410c" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
