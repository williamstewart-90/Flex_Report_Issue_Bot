import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  // Surface this loudly in dev — silent failures here are misery.
  // eslint-disable-next-line no-console
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

export const supabase = createClient(url || '', key || '', {
  auth: {
    persistSession:    true,
    autoRefreshToken:  true,
    detectSessionInUrl: true,
    storage:           typeof window !== 'undefined' ? window.localStorage : undefined,
    storageKey:        'vt-flex-auth'
  }
});
