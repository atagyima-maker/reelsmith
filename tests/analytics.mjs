// Tests for api/event.js and api/stats.js against a fake Upstash Redis in this process.
// Run: node tests/analytics.mjs   (after npm install)
import http from 'node:http';

const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };

// Fake Upstash: the REST /pipeline endpoint with the commands the functions use.
const kv = new Map(), hll = new Map(); let commandsSeen = 0, saltSet = null;
function run([cmd, ...a]) {
  commandsSeen++;
  switch (cmd) {
    case 'SET': { if (String(a[0]).startsWith('rs:a:salt:')) saltSet = a; const nx = a.includes('NX'); if (nx && kv.has(a[0])) return null; kv.set(a[0], a[1]); return 'OK'; }
    case 'GET': return kv.has(a[0]) ? kv.get(a[0]) : null;
    case 'MGET': return a.map(k => (kv.has(k) ? kv.get(k) : null));
    case 'INCR': case 'INCRBY': { const n = (Number(kv.get(a[0])) || 0) + (cmd === 'INCR' ? 1 : Number(a[1])); kv.set(a[0], String(n)); return n; }
    case 'EXPIRE': return 1;
    case 'PFADD': { const s = hll.get(a[0]) || new Set(); const before = s.size; a.slice(1).forEach(x => s.add(x)); hll.set(a[0], s); return s.size > before ? 1 : 0; }
    case 'PFCOUNT': { const u = new Set(); a.forEach(k => (hll.get(k) || []).forEach(x => u.add(x))); return u.size; }
    default: throw new Error('fake redis: unsupported ' + cmd);
  }
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer redis-token') { res.writeHead(401); return res.end('{}'); }
    const out = JSON.parse(body).map(c => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ev = (body, headers = {}) => new Request('https://reelsmith.example/api/event', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { host: 'reelsmith.example', origin: 'https://reelsmith.example', 'x-real-ip': '203.0.113.7', 'user-agent': UA, ...headers }
});
const statsReq = (key, days = 7) => new Request('https://reelsmith.example/api/stats?days=' + days, { headers: key ? { authorization: 'Bearer ' + key } : {} });
const day = Math.floor(Date.now() / 86400e3);
const count = e => Number(kv.get(`rs:a:${day}:n:${e}`)) || 0;
const uniques = e => (hll.get(`rs:a:${day}:u:${e}`) || new Set()).size;

try {
  const event = await import('../api/event.js');
  const stats = await import('../api/stats.js');

  // Off without Redis
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  let r = await event.POST(ev({ e: 'visit' }));
  check('without Redis, events are accepted and dropped', r.status === 204 && commandsSeen === 0);
  check('without Redis, GET reports analytics off', (await event.GET().json()).enabled === false);

  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';

  // Counting
  await event.POST(ev({ e: 'visit' })); await event.POST(ev({ e: 'visit' }));
  await event.POST(ev({ e: 'visit' }, { 'x-real-ip': '198.51.100.4' }));
  check('counts every visit event', count('visit') === 3, String(count('visit')));
  check('counts the same visitor once per day', uniques('visit') === 2, String(uniques('visit')));
  await event.POST(ev({ e: 'render_ok', v: 'fast' })); await event.POST(ev({ e: 'render_ok', v: 'sideways' }));
  check('allowed values are counted', kv.get(`rs:a:${day}:v:render_ok:fast`) === '1');
  check('unknown values are dropped but the event still counts', count('render_ok') === 2 && ![...kv.keys()].some(k => k.includes('sideways')));

  // Ignored traffic
  const before = commandsSeen;
  await event.POST(ev({ e: 'drop_table' }));
  await event.POST(ev({ e: 'visit' }, { 'user-agent': 'Googlebot/2.1' }));
  await event.POST(ev({ e: 'visit' }, { 'user-agent': 'Mozilla/5.0 HeadlessChrome/130.0' }));
  await event.POST(ev({ e: 'visit' }, { 'sec-gpc': '1' }));
  await event.POST(ev({ e: 'visit' }, { origin: 'https://evil.example' }));
  await event.POST(ev('{"e":"visit","pad":"' + 'x'.repeat(400) + '"}'));
  await event.POST(ev('not json'));
  check('unknown events, bots, Global Privacy Control, other sites and junk are ignored', commandsSeen === before && count('visit') === 3);

  // Flood protection
  for (let i = 0; i < 310; i++) await event.POST(ev({ e: 'js_error' }, { 'x-real-ip': '192.0.2.99' }));
  check('one browser cannot add more than 300 events a day', count('js_error') === 300, String(count('js_error')));

  // Privacy: nothing that identifies a person is stored
  const everything = JSON.stringify([...kv.entries(), ...[...hll.entries()].map(([k, s]) => [k, [...s]])]);
  check('no IP address or browser string is stored', !/203\.0\.113\.7|198\.51\.100\.4|192\.0\.2\.99|Macintosh|Chrome/.test(everything));
  check('the daily salt is created once and set to expire within 2 days', saltSet && saltSet.includes('NX') && saltSet[saltSet.indexOf('EX') + 1] === String(2 * 86400), JSON.stringify(saltSet && saltSet.slice(2)));

  // Made something = edited OR wrote a script, counted once
  await event.POST(ev({ e: 'scene_edit' })); await event.POST(ev({ e: 'script_ok', v: 'new' }));
  await event.POST(ev({ e: 'script_ok', v: 'new' }, { 'x-real-ip': '198.51.100.4' }));

  // Stats endpoint
  delete process.env.REELSMITH_STATS_KEY;
  check('stats are off until a key is set', (await stats.GET(statsReq('anything'))).status === 503);
  process.env.REELSMITH_STATS_KEY = 'correct-horse-battery';
  check('stats refuse a missing key', (await stats.GET(statsReq(''))).status === 401);
  check('stats refuse a wrong key', (await stats.GET(statsReq('correct-horse-batterz'))).status === 401);
  r = await stats.GET(statsReq('correct-horse-battery', 7));
  const body = await r.json(); const t = body.days && body.days[body.days.length - 1];
  check('stats return one row per day', r.status === 200 && body.days.length === 7);
  check('today matches what was recorded', t && t.counts.visit === 3 && t.visitors.visit === 2 && t.values.render_ok.fast === 1, JSON.stringify(t && t.counts));
  check('made-something counts each visitor once across edits and scripts', t && t.visitors.made_something === 2, String(t && t.visitors.made_something));
  check('days ask is capped at 90', (await (await stats.GET(statsReq('correct-horse-battery', 5000))).json()).days.length === 90);

  // Script writer: token usage is recorded, rate limits use Redis
  process.env.ANTHROPIC_API_KEY = 'test';
  const script = await import('../api/script.js');
  const fake = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 1500 },
    content: [{ type: 'text', text: JSON.stringify({ title: 't', scenes: [{ kind: 'scene', caption: 'a', sub: '', narration: 'b', visual: 'c', duration: 4, palette: ['#000000', '#ffffff'] }] }) }] }) } } };
  const sr = await script.handlePost(new Request('https://reelsmith.example/api/script', { method: 'POST', headers: { host: 'reelsmith.example', 'x-real-ip': '203.0.113.50' }, body: JSON.stringify({ mode: 'new', idea: 'a cat cafe opening' }) }), fake);
  check('script writer still works with Redis on', sr.status === 200);
  check('Claude tokens are recorded for the cost estimate', kv.get(`rs:a:${day}:s:tokens_in`) === '900' && kv.get(`rs:a:${day}:s:tokens_out`) === '1500' && kv.get(`rs:a:${day}:s:script_calls`) === '1');
  check('rate limits are kept in Redis when it is connected', [...kv.keys()].some(k => /^rs:ip:[0-9a-f]{20}:h:/.test(k)));
  check('rate-limit keys hold no IP address', ![...kv.keys()].some(k => k.includes('203.0.113')));
} catch (e) {
  check('analytics test run finished', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally { server.close(); }

console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : '\nAll analytics checks passed');
process.exit(failed ? 1 : 0);
