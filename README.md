# GMeet ISO

Zoom-ISO-style isolated feeds for Google Meet: every participant (and every screen share)
becomes its own **NDI source** on the network, e.g. `MACHINE (GMEET - Alice Anderson)`.

## How it works

```
 ┌──────────────── Electron ────────────────┐
 │ Control window      Meet window          │
 │ (settings, feeds)   meet.google.com      │
 │        ▲            signed-in bot acct   │
 │        │ IPC        ┌─ preload (isolated world, Node) ─┐
 │        └────────────┤ dom.ts     find tiles + names    │
 │                     │ capture.ts tile <video> →        │
 │                     │            WebCodecs VideoFrame  │
 │                     │            → copyTo(I420/NV12/   │
 │                     │              BGRA)               │
 │                     │ native addon (in-process) ───────┼──► NDI sources
 │                     └──────────────────────────────────┘
 └──────────────────────────────────────────┘
```

- **No official API.** The Meet Media API is closed to new signups, caps you at 3 video
  streams, and is being shut down on 2027‑01‑15. So the app runs a real Meet web client,
  signed in with a dedicated Google account.
- **Feeds follow tiles, not WebRTC tracks.** Meet's SFU multiplexes participants onto a
  fixed set of "virtual" streams that get reassigned as people speak. Binding each feed to a
  participant tile (`data-participant-id`) keeps the right person on the right source.
- **Native addon** (`native/ndi_addon.cc`, N‑API): dynamically loads the installed NDI 6
  runtime, one worker thread per sender, latest‑frame‑wins (never blocks the page). After
  1 s with no frames (camera off, tile gone) it sends a black slate, so sources stay
  stable for your switcher.
- Camera/mic permissions are denied for the Meet session, so the bot never sends video
  or audio.
- When a participant leaves, their source holds black for *grace* seconds (default 15)
  and is then removed.

## Requirements

- Windows 10/11 x64 (macOS/Linux should work but are untested)
- Node 22, Visual Studio 2022 Build Tools (C++)
- NDI 6 Runtime (runs the sources) and NDI 6 SDK (headers for building). Set `NDI_SDK_DIR`
  to the SDK folder.

## Run

```bash
npm install
npm run build        # native addon + TypeScript
npm start
```

1. Click **Google sign-in** and sign in with the bot account. The session is saved
   (`persist:meet` partition).
2. Paste a Meet link or code and click **Join**. "Join now" is clicked automatically
   (toggle in settings).
3. In the Meet window, choose **⋮ → Change layout → Tiled** and raise the max tiles.
   **Only tiles rendered on screen can be captured**, and bigger tiles get more resolution
   from Meet.
4. Pull the `GMEET - …` sources into vMix / OBS / TriCaster / Studio Monitor.

## Testing without a meeting

```bash
npm run mock          # loads static/mock-meet.html (fake Meet DOM with live canvas video)
npm run verify:ndi    # in another terminal: discovers GMEET sources, receives one frame each
```

The mock covers: three live feeds at different resolutions, a screen share, the bot's own
tile (excluded), a camera-off participant (black slate), and a participant who leaves at
20 s (removed after the grace period).

## Known limits / TODO

- **Meet DOM selectors are heuristics** (`src/meet/dom.ts`), and they haven't been run
  against a live Meet yet. If feeds aren't detected, press **Dump Meet DOM** in a real call
  (the output is also saved to the userData folder) and adjust `dom.ts`.
- Resolution is whatever Meet sends to that tile: usually ≤720p for cameras, higher for
  screen share. Output resolution follows the source; there's no fixed 1080p canvas yet.
- No audio yet. Meet's web client only receives the 3 loudest speakers, so true per-person
  audio isn't possible. A mixed program-audio feed is the next step.
- Google may block sign-in from the embedded browser. The app sends a plain Chrome user
  agent, which normally works.
- No installer yet (electron-builder with `asarUnpack` for `build/Release/*.node`).
