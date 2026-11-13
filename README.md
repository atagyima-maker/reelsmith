# Reelsmith

A video studio that runs entirely in the browser. Write scenes with captions and voiceover
lines, add photos or clips, pick a look, compose a music score, generate AI voiceover, and
render an MP4 in 9:16, 16:9 or 1:1.

This is the standalone website version. Script writing, AI images and prompt packs live in
the Claude version of Reelsmith; move a project between the two with **My projects → Export
project file / Import project file**.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The whole studio: layout, styles and editor code. |
| `standalone.js` | Storage and downloads for a plain website. Projects, brand kit, photos, clips and voice clips are kept in this browser (IndexedDB). |
| `tts-worker.js` | The voice engine. Runs the open-source Kokoro model in the browser; the first use downloads about 90 MB, then it is cached. |
| `tests/smoke.mjs` | End-to-end check: drives the studio in headless Chromium (play, edit, undo, looks, music, save and reload, import, render, phone layout). |
| `.claude/agents/app-guardian.md` | A Claude Code agent that runs the check, fixes what breaks and re-runs until it passes. Ask Claude Code to "use app-guardian". |

## Test

```
node tests/smoke.mjs
```

Needs Node and Playwright with Chromium. It serves the repo itself, so no web server is needed.

## Deploy

It is a static site with no build step. On Vercel: **Add New → Project**, import this
repository, leave every setting at its default (Framework Preset: Other) and press Deploy.

## Good to know

- Edits save automatically in this browser from the first change. Projects are stored on the device and browser you used. Export a project file for anything
  you want to keep safe or move to another device.
- Rendering and AI voice work best in Chrome or Edge on a computer.
- The site loads fonts from Google Fonts, the MP4 writer and voice library from jsDelivr, and
  the voice model from Hugging Face, so it needs an internet connection.
