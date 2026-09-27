// The connection to the shop's database (Supabase). Reads go straight to the database
// (it only returns what this person may see); every CHANGE goes through api.js.
import { createClient } from '@supabase/supabase-js';
import { BACKEND } from '../config/app.js';

export const db = createClient(BACKEND.url, BACKEND.publicKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'srs:auth', detectSessionInUrl: false },
});
