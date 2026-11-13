// Reelsmith smoke test: drives the real studio in headless Chromium and fails loudly on any break.
// Run:  node tests/smoke.mjs            (needs network for jsDelivr + Google Fonts)
//       VENDOR_DIR=/path/with/mp4-muxer.js node tests/smoke.mjs   (offline: serve the MP4 writer locally)
//       SHOTS=/some/dir node tests/smoke.mjs                      (also save desktop + phone screenshots)
// Files are served straight from the repo through request routing, so no web server is needed.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// require() also finds a globally installed Playwright, which a bare ESM import does not.
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://reelsmith.test'; // https: WebCodecs (fast render) only exists on secure pages
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };

const browser = await chromium.launch();
async function newPage(ctx) {
  await ctx.route(ORIGIN + '/**', async route => {
    let p = new URL(route.request().url()).pathname; if (p === '/') p = '/index.html';
    try { route.fulfill({ status: 200, contentType: TYPES[extname(p)] || 'application/octet-stream', body: await readFile(join(ROOT, p)) }); }
    catch { route.fulfill({ status: 404, body: 'not found' }); }
  });
  if (process.env.VENDOR_DIR) {
    await ctx.route('https://cdn.jsdelivr.net/npm/mp4-muxer@*/build/mp4-muxer.js', async r => r.fulfill({ contentType: 'text/javascript', body: await readFile(join(process.env.VENDOR_DIR, 'mp4-muxer.js')) }));
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  return { page, errors };
}
const status = (page, sel) => page.$eval(sel, el => el.textContent.trim());
const canvasLit = page => page.$eval('#stage', c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++; return lit; });

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const { page, errors } = await newPage(ctx);
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => document.querySelectorAll('.scene').length > 0);

  // Boot and first impression
  check('example project loads with scenes', (await page.$$('.scene')).length === 6);
  check('preview canvas draws', (await canvasLit(page)) > 50);
  check('standalone tagline does not promise AI script writing', !/Get a script/i.test(await page.locator('.brand p:visible').innerText()), await page.locator('.brand p:visible').innerText());

  // Playback
  await page.click('#play'); await page.waitForTimeout(1200); await page.click('#play');
  const tc = await status(page, '#tc');
  check('play advances the timecode', !/^0:00\.0 /.test(tc), tc);

  // Editing + undo
  const cap = page.locator('.scene').first().locator('[data-f=caption]');
  await cap.fill('Edited caption'); await page.waitForTimeout(600);
  const autosaved = await page.waitForFunction(() => /^Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 8000 }).then(() => true, () => false);
  check('standalone autosaves from the first edit (no Save click needed)', autosaved, await status(page, '#save-state'));
  await page.click('body', { position: { x: 5, y: 5 } });
  await page.click('#undo'); await page.waitForTimeout(200);
  check('undo restores the caption', (await page.locator('.scene').first().locator('[data-f=caption]').inputValue()) !== 'Edited caption');

  // Title card label survives a length edit
  await page.click('#add-title'); await page.waitForTimeout(200);
  const last = page.locator('.scene').last();
  await last.locator('[data-f=duration]').fill('6'); await page.waitForTimeout(100);
  check('title card keeps its TITLE label after a length change', /^TITLE/.test(await last.locator('.scene-num').textContent()), await last.locator('.scene-num').textContent());
  await last.locator('[data-act=del]').click();

  // Formats and looks
  for (const id of ['#ar-169', '#ar-11', '#ar-916']) await page.click(`label:has(${id})`);
  check('aspect switch resizes the canvas', await page.$eval('#stage', c => c.width === 720 && c.height === 1280));
  for (const p of ['trailer', 'noir', 'reels', 'doc', 'neon', 'clean']) await page.click(`[data-preset=${p}]`);
  check('every look preset applies', /Clean look on/.test(await status(page, '#look-status')));

  // Music + sound effects
  await page.click('#compose');
  await page.waitForFunction(() => /composed|Could not/.test(document.querySelector('#music-status').textContent), null, { timeout: 60000 });
  check('music composes', /composed/.test(await status(page, '#music-status')), await status(page, '#music-status'));
  await page.check('#sfx-on'); await page.waitForTimeout(1500);

  // Shorten to two scenes so the render is quick
  while ((await page.$$('.scene')).length > 2) await page.locator('.scene').last().locator('[data-act=del]').click();

  // Save, reload, persistence
  await page.click('#proj-save');
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 15000 });
  check('project saves to this browser', true);
  await page.reload(); await page.waitForFunction(() => /^Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 15000 });
  check('saved project reopens after reload', (await page.$$('.scene')).length === 2);

  // Project file import cannot inject markup
  const evil = JSON.stringify({ reelsmith: 1, project: { title: '<img src=x onerror="window.__pwned=1">', scenes: [{ id: 'x"><img src=x onerror="window.__pwned=2">', caption: 'hi', duration: 2 }] } });
  await page.click('#proj-open'); await page.locator('#proj-panel details summary').click();
  await page.fill('#proj-text', evil); await page.click('#proj-text-go'); await page.waitForTimeout(400);
  check('imported project file cannot run script', !(await page.evaluate(() => window.__pwned)));
  check('imported project still loads', (await page.$$('.scene')).length === 1);
  await page.click('#proj-close');

  // Controls are locked while rendering
  await page.click('#render');
  await page.waitForFunction(() => !document.querySelector('#cancel-render').hidden, null, { timeout: 30000 });
  const locked = await page.evaluate(() => !!document.querySelector('#scenes').closest('[inert]'));
  check('scene editing is locked during a render', locked);
  await page.waitForFunction(() => document.querySelector('#cancel-render').hidden, null, { timeout: 120000 });
  const rs = await status(page, '#render-status');
  const res = await page.$$('.res-item');
  check('render produces a video', res.length === 1 && /ready/.test(rs), rs);
  check('fast frame-by-frame render was used (not the real-time fallback)', /faster than real time/.test(rs));
  if (res.length) {
    const ok = await page.$eval('.res-item video', v => new Promise(r => { if (v.readyState >= 1) r(v.duration > 0.5); v.onloadedmetadata = () => r(v.duration > 0.5); v.onerror = () => r(false); setTimeout(() => r(false), 8000); }));
    check('rendered video is playable', ok);
  }
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'desktop.png'), fullPage: false });
  check('no script errors on desktop', errors.length === 0, errors.slice(0, 5).join(' | '));

  // Phone layout
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await newPage(phone);
  await m.page.goto(ORIGIN + '/'); await m.page.waitForFunction(() => document.querySelectorAll('.scene').length > 0);
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no sideways scrolling on a phone', overflow <= 1, `${overflow}px`);
  if (process.env.SHOTS) await m.page.screenshot({ path: join(process.env.SHOTS, 'phone.png') });
  check('no script errors on phone', m.errors.length === 0, m.errors.slice(0, 5).join(' | '));
} catch (e) {
  check('smoke run finished', false, String(e && e.message || e).split('\n')[0]);
} finally {
  await browser.close();
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
