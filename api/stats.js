// Reelsmith analytics read-out for the owner's dashboard (stats.html).
// Needs REELSMITH_STATS_KEY; the dashboard sends it as a Bearer token. Without the key set, it is off.
import { timingSafeEqual, createHash } from 'node:crypto';
import { json, redis, redisConfigured, dayNumber } from './_lib.js';
import { EVENTS } from './event.js';

const SERVER = ['script_calls', 'tokens_in', 'tokens_out'];
const digest = s => createHash('sha256').update(String(s)).digest();
function authorized(request) {
  const key = process.env.REELSMITH_STATS_KEY;
  if (!key || key.length < 12) return false;
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  return !!m && timingSafeEqual(digest(m[1]), digest(key));
}

export async function GET(request) {
  if (!process.env.REELSMITH_STATS_KEY) return json(503, { error: 'off', why: 'REELSMITH_STATS_KEY is not set' });
  if (!authorized(request)) return json(401, { error: 'unauthorized' });
  if (!redisConfigured()) return json(503, { error: 'off', why: 'Upstash Redis is not connected' });
  const n = Math.min(90, Math.max(1, parseInt(new URL(request.url).searchParams.get('days'), 10) || 30));
  const today = dayNumber();
  const names = Object.keys(EVENTS);
  const valueKeys = names.flatMap(e => (EVENTS[e] || []).map(v => [e, v]));
  const cmds = [];
  for (let k = n - 1; k >= 0; k--) {
    const d = today - k;
    cmds.push(['MGET', ...names.map(e => `rs:a:${d}:n:${e}`), ...valueKeys.map(([e, v]) => `rs:a:${d}:v:${e}:${v}`), ...SERVER.map(s => `rs:a:${d}:s:${s}`)]);
    names.forEach(e => cmds.push(['PFCOUNT', `rs:a:${d}:u:${e}`]));
    // Visitors who made something that day: edited a scene by hand or had Claude write a script.
    cmds.push(['PFCOUNT', `rs:a:${d}:u:scene_edit`, `rs:a:${d}:u:script_ok`]);
  }
  let out;
  try { out = await redis(cmds); } catch (e) { console.error('stats read failed', e.message); return json(502, { error: 'store' }); }
  const days = []; let i = 0;
  for (let k = n - 1; k >= 0; k--) {
    const vals = (out[i++] || []).map(x => Number(x) || 0); let j = 0;
    const counts = {}, values = {}, server = {}, visitors = {};
    names.forEach(e => { counts[e] = vals[j++]; });
    valueKeys.forEach(([e, v]) => { (values[e] = values[e] || {})[v] = vals[j++]; });
    SERVER.forEach(s => { server[s] = vals[j++]; });
    names.forEach(e => { visitors[e] = Number(out[i++]) || 0; });
    visitors.made_something = Number(out[i++]) || 0;
    days.push({ date: new Date((today - k) * 86400e3).toISOString().slice(0, 10), counts, values, visitors, server });
  }
  return json(200, { days });
}
