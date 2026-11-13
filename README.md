# Reelsmith

A video studio that runs in the browser. Type an idea and Claude writes the script: scenes,
captions, voiceover lines and shot ideas. Then add photos or clips, pick a look, compose a
music score, generate AI voiceover, and render an MP4 in 9:16, 16:9 or 1:1.

AI images and prompt packs live in the Claude version of Reelsmith; move a project between the
two with **My projects → Export project file / Import project file**.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The whole studio: layout, styles and editor code. |
| `standalone.js` | Storage, downloads and the script-writer connection for a plain website. Projects, brand kit, photos, clips and voice clips are kept in this browser (IndexedDB). |
| `api/script.js` | The script writer: a Vercel function that asks Claude for a script. It builds the prompt itself, checks every field, and applies rate limits. |
| `tts-worker.js` | The voice engine. Runs the open-source Kokoro model in the browser; the first use downloads about 90 MB, then it is cached. |
| `tests/api.mjs` | Checks the script writer against a fake Anthropic API: what is sent, input checks, rate limits, every failure. No key, no cost. |
| `tests/smoke.mjs` | End-to-end check: drives the studio in headless Chromium (writing a script, play, edit, undo, looks, music, save and reload, import, render, phone layout). |
| `.claude/agents/app-guardian.md` | A Claude Code agent that runs the checks, fixes what breaks and re-runs until they pass. Ask Claude Code to "use app-guardian". |

## Deploy

On Vercel: **Add New → Project**, import this repository, leave every setting at its default
(Framework Preset: Other) and press Deploy. The site works straight away as an editor; the
script writer switches on when you add an API key.

### Switch on AI script writing

1. Create an API key at console.anthropic.com.
2. **Set a monthly spend limit first** (Console → Settings → Limits). It is the one hard
   ceiling on what the public site can cost you, whatever happens in the code.
3. In Vercel: **Project → Settings → Environment Variables**, add `ANTHROPIC_API_KEY`, then
   redeploy. The idea box and **Write my video** button appear; with no key they stay hidden
   and the site says plainly that it is an editor.

**Cost.** Each script is one Claude Opus 5.5 call at low effort, roughly 2 to 5 US cents.
The built-in limits cap the worst case:

| Variable | Default | Meaning |
| --- | --- | --- |
| `REELSMITH_PER_HOUR` | 8 | Scripts one visitor (IP address) can write per hour |
| `REELSMITH_PER_DAY` | 25 | Scripts one visitor can write per day |
| `REELSMITH_SITE_PER_DAY` | 200 | Scripts the whole site can write per day (about $4 to $10 at most) |

These counters live in each server instance's memory unless you connect Upstash Redis (free
tier is enough): add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from the Upstash
integration in the Vercel Marketplace, and the limits then hold across the whole site.
Without Redis the limits are approximate, which is why the spend limit in step 2 matters.

## Test

```
npm install
node tests/api.mjs
node tests/smoke.mjs
```

The browser test needs Playwright with Chromium. It serves the repo itself, so no web server is
needed.

## Good to know

- Edits save automatically in this browser from the first change. Projects are stored on the
  device and browser you used. Export a project file for anything you want to keep safe or move
  to another device.
- Only the idea or change you type, plus the current scene text when you ask for a change, is
  sent to Anthropic to write the script. Photos, clips and voices never leave the browser.
- Rendering and AI voice work best in Chrome or Edge on a computer.
- The site loads fonts from Google Fonts, the MP4 writer and voice library from jsDelivr, and
  the voice model from Hugging Face, so it needs an internet connection.
