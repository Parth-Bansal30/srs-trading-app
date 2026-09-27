// Staff management goes to the backend "staff-admin" function (it also creates the login for a new number).
import { db } from './backend.js';
import { BACKEND } from '../config/app.js';
import { ApiError } from './api.js';

export async function staff(action, body = {}) {
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(`${BACKEND.url}/functions/v1/staff-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: BACKEND.publicKey, Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error, data.message || 'Something went wrong.');
  return data;
}
