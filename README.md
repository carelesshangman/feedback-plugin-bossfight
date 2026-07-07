# feedBack plugin: Boss Fight

A [feedBack](https://github.com/got-feedBack/feedBack) **visualization plugin** that replaces
the highway with a 3D boss-fight arena rendered in Three.js (WebGL2). The note highway runs
through the foreground; **The Gravelord** looms in the background.

![screenshot](demo/screenshot.png)

## Gameplay

- **Streaks attack.** Every 5 consecutive correct notes hurls a rock at the boss; damage scales
  with the length of your streak. Drop the boss's HP to zero and it dies — then respawns a level
  higher with 30% more HP.
- **The boss fights back, on the beat.** Every 8 measures the boss winds up (`⚠ INCOMING RIFF`)
  and launches a boulder at *you*. It launches on the downbeat and lands exactly 4 beats later.
  Play that riff cleanly (no misses, at least half the notes hit) and the boulder is **deflected**
  back into the boss for heavy counter-damage. Flub it and you get **crushed** — screen flash,
  camera shake, streak gone.
- A miss anywhere breaks your streak and makes the boss's eyes flare.
- The strike line pulses on every beat.

## Install

Clone into your feedBack plugins directory (Desktop: Settings → Plugins shows the path;
web/Docker: `plugins/` next to the app), then restart:

```bash
cd /path/to/feedback/plugins
git clone https://github.com/carelesshangman/feedback-plugin-bossfight bossfight
```

Then in the player, pick **Boss Fight** from the visualization picker.

### Hit detection

Verdicts come from whatever scorer plugin has registered a note-state provider
(e.g. `note_detect` — mic on). With no scorer active, the **Auto-hit (demo mode)**
per-instance setting (default on) treats every note as a hit so the fight is watchable
without an instrument. The moment a real scorer produces a verdict, auto-hit disengages
automatically.

Per-instance settings (viz settings panel): **Auto-hit** and **Screen shake**.

## Standalone demo (no feedBack needed)

A fake host with a synthetic 120 BPM chart and a simulated ~94%-accuracy scorer:

```bash
npm run demo        # serves on http://localhost:8137
# open http://localhost:8137/demo/demo.html
```

Keys: **Space** pause · **M** fumble (forces misses for 1.5 s — get crushed by the next boulder) ·
**R** restart.

## How it works

- `plugin.json` declares `"type": "visualization"`, so the plugin appears in the
  main-player / splitscreen viz pickers.
- `screen.js` exports the setRenderer factory `window.feedBackViz_bossfight` with
  `contextType: 'webgl2'` — the host swaps the canvas to a fresh one so Three.js can own it.
- Each `draw(bundle)` frame it reads `bundle.currentTime`, `notes`, `chords`, `beats`,
  `stringCount`, `lefty`/`inverted`, and judges due notes via
  `bundle.getNoteState(note, chartTime)`.
- Boss attacks are scheduled off `beats[].measure` boundaries, so boulders launch and land
  on downbeats. Projectile flight advances in **chart time**, so it pauses with playback and
  stays beat-consistent.
- HUD (boss HP, streak, toasts, crush flash) is a DOM overlay with cached element refs —
  no per-frame DOM queries, per the plugin performance rules.
- Three.js is vendored at `assets/three.module.js` (`npm run vendor` refreshes it) and loaded
  with a dynamic `import()` resolved relative to the script URL, falling back to the sandboxed
  `/api/plugins/bossfight/assets/` route.
