import { formatDistanceToNow } from 'date-fns';
import { supabase } from '../lib/supabase.js';

export default function Header({ lastSync, onRefresh, session }) {
  const email = session?.user?.email;

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <header className="border-b border-ink/15 bg-paper/80 backdrop-blur sticky top-0 z-10">
      <div className="max-w-[1600px] mx-auto px-6 lg:px-10 py-5 flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-4xl leading-none">
            VT Flex <em className="not-italic text-rust">issues</em>
          </h1>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink/55 mt-1">
            technical_issue · live ops view
          </p>
        </div>
        <div className="flex items-center gap-4">
          {lastSync?.completed_at && (
            <div className="text-right">
              <div className="label-tag">last sync</div>
              <div className="font-mono text-xs mt-0.5">
                {formatDistanceToNow(new Date(lastSync.completed_at), { addSuffix: true })}
                <span className={lastSync.status === 'success' ? 'ml-2 text-moss' : 'ml-2 text-ember'}>
                  ● {lastSync.status}
                </span>
              </div>
            </div>
          )}
          {onRefresh && (
            <button onClick={onRefresh} className="btn">Refresh</button>
          )}
          {email && (
            <div className="text-right">
              <div className="label-tag">signed in</div>
              <div className="font-mono text-xs mt-0.5 flex items-center gap-2">
                <span className="text-ink/70">{email}</span>
                <button onClick={signOut} className="btn">Sign out</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
