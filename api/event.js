// Reelsmith analytics: counts what visitors do, without cookies and without storing anything that
// identifies a person.
//
// - The studio sends one event name (from the fixed list below) and at most one short value.
// - A visitor is counted as a hash of IP address + browser + site, mixed with a random salt that is
//   created each day and deleted after it. Once the salt is gone the hashes cannot be linked back
//   to anyone, or to the same visitor on another day. IP addresses are never stored.
// - Visitors whose browser sends Global Privacy Control are not counted. Bots are ignored.
// - Data lives in the same Upstash Redis as the script-writer rate limits. Without Redis this
//   endpoint does nothing.
import { createHash, randomBytes } from 'node:crypto';
import { json, redis, redisConfigured, sameSite, clientIp, dayNumber } from './_lib.js';

const ASPECTS = ['9:16', '16:9', '1:1'];
// Event name -> allowed values (null: the event takes no value).
export const EVENTS = {
  visit: null,
  script_ok: ['new', 'revise'],
  script_source: ['own', 'invite', 'open'],
  script_fail: ['rate_limited', 'daily_limit', 'site_busy', 'code_limit', 'refused', 'unavailable', 'offline', 'shape', 'failed', 'bad_request', 'forbidden', 'too_large', 'bad_invite', 'invite_required', 'bad_key', 'no_credit', 'key_rate_limited'],
  scene_edit: null,
  media_add: ['image', 'video'],
  voice_ok: null,
  voice_fail: null,
  music_ok: ['suspense', 'epic', 'uplifting', 'corporate', 'lofi'],
  render_start: ASPECTS,
  render_ok: ['fast', 'realtime'],
  render_fail: null,
  render_cancel: null,
  video_save: ASPECTS,
  project_export: null,
  project_import: null,
  rating: ['up', 'down'],
  js_error: null
};
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python|httpclient|java\//i;
const PER_VISITOR_PER_DAY = 300; // stops one browser from flooding the numbers
const KEEP_DAYS = 400;

const salts = new Map(); // day -> salt, cached per server instance
async function saltFor(day) {
  if (salts.has(day)) return salts.get(day);
  const key = `rs:a:salt:${day}`;
  const out = await redis([['SET', key, randomBytes(16).toString('hex'), 'NX', 'EX', 2 * 86400], ['GET', key]]);
  const salt = out[1];
  if (!salt) throw new Error('no salt');
  salts.clear(); salts.set(day, salt);
  return salt;
}

async function record(day, visitor, e, v) {
  const ttl = KEEP_DAYS * 86400;
  const flood = `rs:a:${day}:f:${visitor}`;
  const [n] = await redis([['INCR', flood], ['EXPIRE', flood, 86400, 'NX']]);
  if (n > PER_VISITOR_PER_DAY) return false;
  const cmds = [
    ['INCR', `rs:a:${day}:n:${e}`], ['EXPIRE', `rs:a:${day}:n:${e}`, ttl, 'NX'],
    ['PFADD', `rs:a:${day}:u:${e}`, visitor], ['EXPIRE', `rs:a:${day}:u:${e}`, ttl, 'NX']
  ];
  if (v) cmds.push(['INCR', `rs:a:${day}:v:${e}:${v}`], ['EXPIRE', `rs:a:${day}:v:${e}:${v}`, ttl, 'NX']);
  await redis(cmds);
  return true;
}

// Server-side counters (no visitor involved), e.g. Claude tokens used by the script writer.
export async function recordServerEvent(name, amount) {
  if (!redisConfigured() || !(amount > 0)) return;
  const key = `rs:a:${dayNumber()}:s:${name}`;
  try { await redis([['INCRBY', key, Math.round(amount)], ['EXPIRE', key, KEEP_DAYS * 86400, 'NX']]); }
  catch (e) { console.error('analytics counter failed', e.message); }
}

export async function POST(request) {
  // Always 204: the page never waits on analytics or learns anything from the answer.
  const done = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  if (!redisConfigured() || !sameSite(request)) return done();
  if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') return done();
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BOT.test(ua)) return done();
  let body;
  try { const t = await request.text(); if (t.length > 300) return done(); body = JSON.parse(t); } catch { return done(); }
  const e = body && typeof body.e === 'string' ? body.e : '';
  if (!Object.prototype.hasOwnProperty.call(EVENTS, e)) return done();
  const allowed = EVENTS[e];
  const v = allowed && allowed.includes(body.v) ? body.v : null;
  try {
    const day = dayNumber();
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
    const visitor = createHash('sha256').update(`${await saltFor(day)}|${clientIp(request)}|${ua}|${host}`).digest('hex').slice(0, 16);
    await record(day, visitor, e, v);
  } catch (err) { console.error('analytics failed', err.message); }
  return done();
}

export function GET() { return json(200, { enabled: redisConfigured() }); }
export function _resetSalts() { salts.clear(); } // tests only
