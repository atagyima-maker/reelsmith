// Tests for api/script.js. The real Anthropic SDK talks to a fake API server inside this process,
// so this checks what is sent to Claude and how every answer is handled, with no key and no cost.
// Run: node tests/api.mjs   (after npm install)
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.REELSMITH_PER_HOUR = '3';
process.env.REELSMITH_PER_CODE_DAY = '2';
process.env.REELSMITH_OPEN = '1'; // most checks below run in open mode; invite mode is checked further down
process.env.REELSMITH_SITE_PER_DAY = '1000';
const api = await import('../api/script.js');

const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };

// Fake Anthropic API: replies with whatever `next` says and records the last request.
let next = null, last = null;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    last = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
    const r = typeof next === 'function' ? next() : next;
    res.writeHead(r.status || 200, { 'content-type': 'application/json', 'request-id': 'req_test' });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });

const message = (text, stop = 'end_turn') => ({ status: 200, body: {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, stop_sequence: null,
  content: text == null ? [] : [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } } });
const good = JSON.stringify({ title: 'Sleep better', scenes: [
  { kind: 'scene', caption: 'You are under-slept', sub: 'ignored', narration: 'Hook line.', visual: 'Snooze button', duration: 4, palette: ['#112233', '#445566'] },
  { kind: 'title', caption: 'SLEEP BETTER', sub: 'Three habits', narration: '', visual: '', duration: 99, palette: ['nope', '#000000'] }
] });
let ip = 0;
const req = (body, headers = {}) => new Request('https://reelsmith.example/api/script', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { host: 'reelsmith.example', origin: 'https://reelsmith.example', 'x-real-ip': '10.0.0.' + (++ip), 'content-type': 'application/json', ...headers }
});
const newIdea = { mode: 'new', idea: 'A promo for my barbershop Saturday hours', format: 'Promo / ad', tone: 'Funny', length: 30, aspect: '9:16' };
const call = async (r) => { const res = await api.handlePost(r, client); return { status: res.status, body: await res.json(), headers: res.headers }; };

try {
  // Feature switch
  check('GET reports the feature on when a key is set', (await (await api.GET()).json()).enabled === true);

  // Happy path, and exactly what Claude receives
  next = message(good);
  let r = await call(req(newIdea));
  check('writes a script', r.status === 200 && r.body.scenes.length === 2, JSON.stringify(r.body).slice(0, 120));
  check('uses claude-opus-5-5 with low effort and a JSON schema', last.body.model === 'claude-opus-5-5' && last.body.output_config.effort === 'low' && last.body.output_config.format.type === 'json_schema');
  check('opts into server-side refusal fallback', last.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(last.headers['anthropic-beta'] || ''));
  check('sends no thinking or sampling settings Opus 5.5 rejects', !('thinking' in last.body) && !('temperature' in last.body));
  check('idea is wrapped as data, not instructions', /<idea>A promo for my barbershop Saturday hours<\/idea>/.test(last.body.messages[0].content));
  check('model output is re-checked: bad colour dropped, duration capped, sub cleared on scenes',
    r.body.scenes[1].palette === null && r.body.scenes[1].duration === 12 && r.body.scenes[0].sub === '');

  // Revise mode
  next = message(good);
  r = await call(req({ mode: 'revise', ask: 'make it funnier', title: 'T', aspect: '1:1', scenes: [{ caption: 'a', narration: 'b', duration: 4, palette: ['#000000', '#ffffff'] }] }));
  check('revises an existing script', r.status === 200 && /<change>make it funnier<\/change>/.test(last.body.messages[0].content));

  // Input checking happens before any money is spent
  last = null;
  for (const [name, body] of [
    ['empty idea', { ...newIdea, idea: '  ' }], ['unknown mode', { mode: 'chat', idea: 'hello there' }],
    ['revise without scenes', { mode: 'revise', ask: 'x y', scenes: [] }], ['not JSON', '{oops']
  ]) { const x = await call(req(body)); check(`rejects ${name} with 400`, x.status === 400); }
  check('no API call was made for rejected input', last === null);
  next = message(good);
  await call(req({ ...newIdea, idea: 'x'.repeat(5000), format: 'Hack the planet', length: 9999 }));
  const sent = last.body.messages[0].content;
  check('long ideas are cut to 600 characters and unknown options replaced', sent.includes('x'.repeat(600) + '</idea>') && !sent.includes('x'.repeat(601)) && /explainer/.test(sent) && /about 30 seconds/.test(sent));
  r = await call(req('x'.repeat(40000)));
  check('oversized request body refused', r.status === 413);

  // Other websites
  r = await call(req(newIdea, { origin: 'https://evil.example' }));
  check('requests from other websites refused', r.status === 403);

  // Rate limit (3 per hour in this test)
  api._resetLimits(); next = message(good);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await call(req(newIdea, { 'x-real-ip': '9.9.9.9' }))).status);
  r = await call(req(newIdea, { 'x-real-ip': '9.9.9.9' }));
  check('4th request in an hour from one visitor is limited', codes.join() === '200,200,200,429' && r.body.error === 'rate_limited' && r.headers.get('retry-after'), codes.join());
  check('other visitors are not affected', (await call(req(newIdea, { 'x-real-ip': '8.8.8.8' }))).status === 200);

  // Model and API failures become clear errors, never a crash
  next = message(null, 'refusal');
  check('refusal returns 422 refused', (r = await call(req(newIdea))).status === 422 && r.body.error === 'refused');
  next = message('{"title": "cut off', 'max_tokens');
  check('truncated output returns a shape error', (await call(req(newIdea))).body.error === 'shape');
  next = message('not json at all');
  check('non-JSON output returns a shape error', (await call(req(newIdea))).body.error === 'shape');
  next = message(JSON.stringify({ title: 'x', scenes: [] }));
  check('empty script returns a shape error', (await call(req(newIdea))).body.error === 'shape');
  next = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } };
  check('Anthropic rate limit returns 429', (r = await call(req(newIdea))).status === 429 && r.body.error === 'rate_limited');
  next = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } };
  check('bad API key returns 503 unavailable', (await call(req(newIdea))).status === 503);
  next = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } };
  check('Anthropic outage returns 502 failed', (await call(req(newIdea))).body.error === 'failed');

  // Invite mode: the owner's key only works with a code
  delete process.env.REELSMITH_OPEN;
  process.env.REELSMITH_INVITE_CODES = 'short, friends-2026-reel , family-9f3k2';
  let st = await (await api.GET()).json();
  check('with invite codes set, GET reports invite mode', st.enabled === true && st.invite === true && st.open === false, JSON.stringify(st));
  next = message(good); last = null;
  r = await call(req(newIdea));
  check('no invite code: refused before any API call', r.status === 401 && r.body.error === 'invite_required' && last === null);
  r = await call(req(newIdea, { 'x-reelsmith-invite': 'friends-2026-rea' }));
  check('wrong invite code: refused before any API call', r.status === 401 && r.body.error === 'bad_invite' && last === null);
  r = await call(req(newIdea, { 'x-reelsmith-invite': 'short' }));
  check('codes shorter than 6 characters are ignored', r.status === 401 && r.body.error === 'bad_invite');
  r = await call(req(newIdea, { 'x-reelsmith-invite': 'friends-2026-reel' }));
  check('valid invite code (spaces around it in the setting are fine) writes a script', r.status === 200 && last !== null);
  r = await call(req(newIdea, { 'x-reelsmith-invite': 'family-9f3k2' }));
  check('any of the listed codes works', r.status === 200);
  api._resetLimits();
  const codeUses = [];
  for (let i = 0; i < 3; i++) codeUses.push((await call(req(newIdea, { 'x-reelsmith-invite': 'friends-2026-reel' }))).status);
  check('each invite code has its own daily limit (2 in this test)', codeUses.join() === '200,200,429', codeUses.join());
  api._resetLimits();
  const guesses = [];
  for (let i = 0; i < 12; i++) guesses.push((await call(req(newIdea, { 'x-reelsmith-invite': 'guess-' + i, 'x-real-ip': '6.6.6.6' }))).status);
  check('guessing codes is cut off after 10 wrong tries an hour', guesses.slice(0, 10).every(c => c === 401) && guesses[10] === 429, guesses.join());

  // Key set but no codes and not open: the key is never used
  delete process.env.REELSMITH_INVITE_CODES;
  st = await (await api.GET()).json();
  check('key without codes or REELSMITH_OPEN: GET reports the writer off', st.enabled === false);
  last = null;
  check('key without codes or REELSMITH_OPEN: nobody can spend it', (await call(req(newIdea, { 'x-reelsmith-invite': 'friends-2026-reel' }))).status === 503 && last === null);

  // Feature off
  delete process.env.ANTHROPIC_API_KEY;
  check('with no key, GET reports the feature off', (await (await api.GET()).json()).enabled === false);
  check('with no key, POST returns 503 without calling anything', (await call(req(newIdea))).status === 503);
} catch (e) {
  check('api test run finished', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally { server.close(); }

console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : '\nAll API checks passed');
process.exit(failed ? 1 : 0);
