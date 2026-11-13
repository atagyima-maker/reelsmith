// Reelsmith script writer: a Vercel function that turns a video idea into scenes with Claude, paid for
// with the site owner's API key. (Visitors can also write with their own key: that goes straight from
// their browser to Anthropic, see standalone.js, and never reaches this function.)
//
// Who may spend the owner's key:
// - Default: nobody. With ANTHROPIC_API_KEY set, a request must carry one of the invite codes in
//   REELSMITH_INVITE_CODES (header x-reelsmith-invite). No codes set means the key is never used.
// - REELSMITH_OPEN=1 lets anyone use it, within the limits below. Opt-in only.
//
// Safety model, because every call spends real money:
// - The browser sends only form fields. The prompt is built from script-prompt.js, so the endpoint
//   cannot be used as a general-purpose chatbot. Every field is checked and length-capped first.
// - Limits per visitor, per invite code and site-wide (see LIMITS); wrong invite codes are limited
//   too, so codes cannot be guessed. With Upstash Redis the limits hold across every server instance;
//   without it they are per instance, so ALSO set a monthly spend limit on the key in the Anthropic
//   Console. That limit is the hard ceiling no bug here can exceed.
// - Requests from other websites are refused.
import Anthropic from '@anthropic-ai/sdk';
import { createHash, timingSafeEqual } from 'node:crypto';
import { json, redis, redisConfigured, sameSite, clientIp } from './_lib.js';
import { recordServerEvent } from './event.js';
import { readRequest, scriptParams, readScriptMessage } from '../script-prompt.js';

export const maxDuration = 60;

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : d);
const LIMITS = {
  perHour: num(process.env.REELSMITH_PER_HOUR, 8),
  perDay: num(process.env.REELSMITH_PER_DAY, 25),
  perCodeDay: num(process.env.REELSMITH_PER_CODE_DAY, 40),
  sitePerDay: num(process.env.REELSMITH_SITE_PER_DAY, 200),
  badCodesPerHour: 10
};

/* ---------- Rate limits ---------- */
const mem = new Map();
async function hit(key, ttl) {
  if (redisConfigured()) { const out = await redis([['INCR', key], ['EXPIRE', key, ttl, 'NX']]); return Number(out[0]) || 0; }
  const now = Date.now(); const e = mem.get(key);
  if (!e || e.exp <= now) { mem.set(key, { n: 1, exp: now + ttl * 1000 }); return 1; }
  e.n++; return e.n;
}
// Returns null when allowed, or { code, retryAfter } when a limit is reached.
// Limits are keyed by a keyed hash of the IP address (or invite code), so the store never holds either.
const keyed = v => createHash('sha256').update(`${process.env.ANTHROPIC_API_KEY}|${v}`).digest('hex').slice(0, 20);
async function overLimit(rawIp, code) {
  const ip = keyed(rawIp);
  const hour = Math.floor(Date.now() / 3600e3), day = Math.floor(Date.now() / 86400e3);
  const ttlH = 3600 - Math.floor(Date.now() / 1000) % 3600, ttlD = 86400 - Math.floor(Date.now() / 1000) % 86400;
  // Per-visitor limits first, so one visitor hammering the button cannot use up the site-wide budget.
  if (await hit(`rs:ip:${ip}:h:${hour}`, ttlH) > LIMITS.perHour) return { code: 'rate_limited', retryAfter: ttlH };
  if (await hit(`rs:ip:${ip}:d:${day}`, ttlD) > LIMITS.perDay) return { code: 'daily_limit', retryAfter: ttlD };
  if (code && await hit(`rs:code:${keyed('code:' + code)}:d:${day}`, ttlD) > LIMITS.perCodeDay) return { code: 'code_limit', retryAfter: ttlD };
  if (await hit(`rs:site:${day}`, ttlD) > LIMITS.sitePerDay) return { code: 'site_busy', retryAfter: ttlD };
  return null;
}
export function _resetLimits() { mem.clear(); } // tests only

/* ---------- Who may spend the key ---------- */
const inviteCodes = () => (process.env.REELSMITH_INVITE_CODES || '').split(',').map(c => c.trim()).filter(c => c.length >= 6);
// 'off': the key is never used. 'invite': only with a valid code. 'open': anyone, within the limits.
function mode() {
  if (!process.env.ANTHROPIC_API_KEY) return 'off';
  if (process.env.REELSMITH_OPEN === '1') return 'open';
  return inviteCodes().length ? 'invite' : 'off';
}
const digest = v => createHash('sha256').update(String(v)).digest();
function matchCode(given) {
  if (!given || given.length > 200) return null;
  let found = null; // compare against every code in constant time, so timing reveals nothing
  for (const c of inviteCodes()) if (timingSafeEqual(digest(given), digest(c))) found = c;
  return found;
}

/* ---------- Handlers ---------- */
export async function GET() {
  const m = mode();
  return json(200, { enabled: m !== 'off', invite: m === 'invite', open: m === 'open' });
}

export function POST(request) { return handlePost(request, null); }

// `client` is injectable so tests can run without a key or network.
export async function handlePost(request, client) {
  const m = mode();
  if (m === 'off') return json(503, { error: 'unavailable' });
  if (!sameSite(request)) return json(403, { error: 'forbidden' });
  let code = null;
  if (m === 'invite') {
    const given = (request.headers.get('x-reelsmith-invite') || '').trim();
    if (!given) return json(401, { error: 'invite_required' });
    code = matchCode(given);
    if (!code) {
      // Count wrong codes per visitor, so codes cannot be found by trying many.
      let tries = 0;
      try { tries = await hit(`rs:bad:${keyed(clientIp(request))}:h:${Math.floor(Date.now() / 3600e3)}`, 3600); } catch (e) {}
      if (tries > LIMITS.badCodesPerHour) return json(429, { error: 'rate_limited', retryAfter: 3600 }, { 'retry-after': '3600' });
      return json(401, { error: 'bad_invite' });
    }
  }
  const len = +request.headers.get('content-length') || 0;
  if (len > 32_000) return json(413, { error: 'too_large' });
  let body;
  try { const text = await request.text(); if (text.length > 32_000) return json(413, { error: 'too_large' }); body = JSON.parse(text); }
  catch { return json(400, { error: 'bad_request' }); }
  const q = readRequest(body);
  if (!q) return json(400, { error: 'bad_request' });

  let limited;
  try { limited = await overLimit(clientIp(request), code); }
  catch (e) { console.error('rate limit store failed', e); return json(503, { error: 'unavailable' }); }
  if (limited) return json(429, { error: limited.code, retryAfter: limited.retryAfter }, { 'retry-after': String(limited.retryAfter) });

  client = client || new Anthropic();
  try {
    const msg = await client.beta.messages.create(scriptParams(q));
    const u = msg.usage || {};
    await Promise.all([recordServerEvent('script_calls', 1), recordServerEvent('tokens_in', (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)), recordServerEvent('tokens_out', u.output_tokens || 0)]);
    const out = readScriptMessage(msg);
    if (out.error) return json(out.error === 'refused' ? 422 : 502, { error: out.error });
    return json(200, out.data);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json(429, { error: 'rate_limited', retryAfter: 60 }, { 'retry-after': '60' });
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) { console.error('Anthropic key problem', e.status); return json(503, { error: 'unavailable' }); }
    if (e instanceof Anthropic.BadRequestError) { console.error('Anthropic rejected the request', e.message); return json(502, { error: 'failed' }); }
    if (e instanceof Anthropic.APIError) { console.error('Anthropic API error', e.status, e.message); return json(502, { error: 'failed' }); }
    console.error('script writer failed', e);
    return json(502, { error: 'failed' });
  }
}
