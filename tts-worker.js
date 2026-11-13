/* Reelsmith voice engine.
   Runs the open-source Kokoro text-to-speech model inside this browser, off the main thread.
   Messages in:  { id, type: 'load' }  |  { id, type: 'speak', text, voice, speed }
   Messages out: { type: 'progress', loaded, total } while the model downloads,
                 { id, type: 'ready' }, { id, type: 'audio', samples, rate }, { id, type: 'error', message } */
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null, loading = null;

function load() {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    loading = KokoroTTS.from_pretrained(MODEL, {
      dtype: 'q8', device: 'wasm',
      progress_callback: p => {
        if (p && p.status === 'progress' && p.total && /\.onnx$/.test(p.file || '')) postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
      }
    }).then(t => (tts = t)).catch(e => { loading = null; throw e; });
  }
  return loading;
}

// The model reads a limited amount of text per pass, so long lines are voiced sentence by sentence.
function chunks(text, max = 220) {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
  const out = []; let cur = '';
  for (const raw of parts) {
    let p = raw.trim(); if (!p) continue;
    while (p.length > max) {
      let cut = p.lastIndexOf(' ', max); if (cut < max / 2) cut = max;
      if (cur) { out.push(cur); cur = ''; }
      out.push(p.slice(0, cut).trim()); p = p.slice(cut).trim();
    }
    if (cur && (cur + ' ' + p).length > max) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

async function speak(text, voice, speed) {
  const t = await load();
  const pieces = []; let rate = 24000;
  for (const c of chunks(text)) {
    const a = await t.generate(c, { voice, speed });
    rate = a.sampling_rate || rate; pieces.push(a.audio);
  }
  if (pieces.length === 1) return { samples: pieces[0], rate };
  const gap = Math.floor(rate * 0.12);
  const n = pieces.reduce((s, p) => s + p.length, 0) + gap * (pieces.length - 1);
  const samples = new Float32Array(n); let o = 0;
  pieces.forEach((p, i) => { samples.set(p, o); o += p.length + (i < pieces.length - 1 ? gap : 0); });
  return { samples, rate };
}

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'load') { await load(); postMessage({ id: m.id, type: 'ready' }); }
    else if (m.type === 'speak') {
      const r = await speak(String(m.text || ''), m.voice || 'af_heart', +m.speed || 1);
      // Hand over a buffer the samples own outright: a view into model memory cannot be transferred.
      let out = r.samples;
      if (out.byteOffset || out.byteLength !== out.buffer.byteLength) out = out.slice();
      postMessage({ id: m.id, type: 'audio', samples: out, rate: r.rate }, [out.buffer]);
    }
  } catch (err) {
    postMessage({ id: m.id, type: 'error', message: String((err && err.message) || err) });
  }
};
