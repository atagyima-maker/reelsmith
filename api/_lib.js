// Shared helpers for the Reelsmith functions. Vercel does not publish files whose name starts with "_".

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

// Upstash Redis over its REST API (no client library needed). Returns null when it is not configured.
export function redisConfigured() { return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN); }
export async function redis(commands) {
  if (!redisConfigured()) return null;
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands.map(c => c.map(String)))
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map(x => (x && 'result' in x ? x.result : null));
}

// Requests from other websites are refused. Browsers always send Origin on a cross-site POST.
export function sameSite(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === (request.headers.get('x-forwarded-host') || request.headers.get('host')); } catch { return false; }
}
// On Vercel, x-real-ip is set by the platform and cannot be forged by the visitor.
export const clientIp = request =>
  (request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim().slice(0, 64);

export const dayNumber = (ms = Date.now()) => Math.floor(ms / 86400e3);
export const secondsLeftToday = () => 86400 - Math.floor(Date.now() / 1000) % 86400;
