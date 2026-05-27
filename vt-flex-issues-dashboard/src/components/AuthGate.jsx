import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';

const STATE = {
  CHECKING:  'checking',
  SIGNED_IN: 'signed_in',
  SIGNED_OUT: 'signed_out'
};

export default function AuthGate({ children }) {
  const [state, setState]     = useState(STATE.CHECKING);
  const [session, setSession] = useState(null);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data?.session) {
        setSession(data.session);
        setState(STATE.SIGNED_IN);
      } else {
        setState(STATE.SIGNED_OUT);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, newSession) => {
      if (!mounted) return;
      setSession(newSession);
      setState(newSession ? STATE.SIGNED_IN : STATE.SIGNED_OUT);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  if (state === STATE.CHECKING) {
    return <FullScreen><span className="label-tag">checking session…</span></FullScreen>;
  }

  if (state === STATE.SIGNED_OUT) {
    return <SignInScreen />;
  }

  return typeof children === 'function' ? children(session) : children;
}

function SignInScreen() {
  const [email, setEmail]       = useState('');
  const [submitting, setSubmit] = useState(false);
  const [sent, setSent]         = useState(false);
  const [error, setError]       = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmit(true);
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: window.location.origin
        }
      });
      if (err) throw err;
      setSent(true);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSubmit(false);
    }
  }

  return (
    <FullScreen>
      <div className="card p-8 w-full max-w-md">
        <div className="mb-6">
          <h1 className="font-display text-4xl leading-none">
            VT Flex <em className="not-italic text-rust">issues</em>
          </h1>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink/55 mt-2">
            sign in to continue
          </p>
        </div>

        {sent ? (
          <div className="space-y-3">
            <div className="label-tag">link sent</div>
            <p className="font-sans text-sm">
              Check <span className="font-mono">{email}</span> for a sign-in link.
              The link opens this dashboard signed in.
            </p>
            <button
              type="button"
              className="btn mt-2"
              onClick={() => { setSent(false); setEmail(''); }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="label-tag block mb-2">work email</label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@varsitytutors.com"
                className="field"
              />
            </div>

            {error && (
              <div className="p-3 border-2 border-ember bg-ember/10 font-mono text-xs">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !email}
              className="btn w-full disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'sending…' : 'send magic link'}
            </button>

            <p className="font-mono text-[10px] tracking-[0.15em] uppercase text-ink/45 pt-2">
              access is restricted. unauthorized emails will be unable to load data.
            </p>
          </form>
        )}
      </div>
    </FullScreen>
  );
}

function FullScreen({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      {children}
    </div>
  );
}
