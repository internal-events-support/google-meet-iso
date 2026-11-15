# GMeet ISO

Zoom-ISO-style isolated feeds for Google Meet: every participant (and every screen share)
becomes its own **NDI source**, e.g. `MACHINE (GMEET - Alice Anderson)`. The Meet client
runs hidden; the operator only ever sees the GMeet ISO control app.

## What the operator sees

- **Participant grid**: a live preview per participant / screen share, with NDI source name,
  resolution, fps, live / camera-off / left status, a red **ON AIR** border when a receiver
  is connected, and a per-feed publish toggle.
- **Bot output**: what the bot sends into the meeting:
  - **Camera source**: any NDI source on the network, or any local webcam (incl. virtual
    cams like OBS/vMix). It can be switched live mid-call, and a preview is shown.
  - **Microphone**: any local audio input, also switchable live.
  - Camera / Mic toggles that drive Meet's own buttons.
- Meeting status: signed out / ready / joining / waiting to be admitted / in call /
  denied / ended. Google sign-in opens in a small dedicated window.

## How it works

```
Control window (UI)  ◄── IPC: state, JPEG previews, devices ──┐
                                                               │
Hidden Meet client (offscreen BrowserWindow, never shown)      │
 ├─ main world:  media shim (src/meet/inject.ts)               │
 │     getUserMedia → virtual "GMeet ISO Camera" = canvas.captureStream()
 │                    virtual "GMeet ISO Mic"    = WebAudio dest ← chosen input device
 └─ isolated world: preload (Node + native addon) ─────────────┘
       dom.ts       tiles, names, join phase, cam/mic toggles
       capture.ts   tile <video> track → MediaStreamTrackProcessor → VideoFrame
                    → copyTo(I420/NV12/BGRA) → NDI Sender (one per participant)
       camsource.ts NDI Receiver / webcam → paints the virtual-camera canvas
```

- **No official API.** The Meet Media API is closed to new signups, caps video at 3
  streams, and shuts down on 2027‑01‑15. So the app runs the real Meet web client, signed
  in with a dedicated Google account.
- **Offscreen rendering.** The Meet page is rendered offscreen (`document.visibilityState`
  is still `visible`, so Meet doesn't throttle). Frames are read straight from each tile's
  MediaStreamTrack, so capture doesn't depend on the paint rate.
- **Feeds follow tiles, not tracks.** Meet's SFU remaps a fixed set of virtual streams
  between participants. Binding to the tile (`data-participant-id`) keeps the right person
  on the right source.
- **Native addon** (`native/ndi_addon.cc`, N‑API, dynamically loads the NDI 6 runtime):
  - `Sender`: worker thread per source, latest-frame-wins, black slate after 1 s without
    frames.
  - `Receiver`: BGRA frames for the bot camera.
  - `Finder`: source discovery.

## Requirements

- Windows 10/11 x64, Node 22, Visual Studio 2022 Build Tools (C++)
- NDI 6 Runtime (and NDI 6 SDK headers to build; set `NDI_SDK_DIR`)

## Run

```bash
npm install
npm run build        # native addon + TypeScript
npm start
```

1. Click **Sign in to Google** (only shown when signed out) and sign in with the bot account.
2. Paste a Meet link and click **Join**. Camera/mic prompts and "Join now" are handled
   automatically. If the meeting needs admitting, a host must let the bot in.
3. Pick the bot's **Camera source** and **Microphone** on the right.
4. Pull the `GMEET - …` sources into vMix / OBS / TriCaster.

Test meeting: `https://meet.google.com/ioe-pjbh-yjs`.

## Testing without a meeting

```bash
npm run mock          # fake Meet DOM (static/mock-meet.html) in the hidden window
npm run verify:ndi    # discovers GMEET sources and receives one frame from each
```

## Dev / automation commands

With the app running, launch a second instance with `--cmd=`. Output goes to `%APPDATA%/gmeet-iso/`:

| command | effect |
|---|---|
| `--cmd=join:<url>` / `--cmd=leave` | join / leave |
| `--cmd=snap` / `--cmd=snap-ui` | screenshot of hidden Meet page / control UI |
| `--cmd=dump` | Meet DOM diagnostics → `meet-dom-*.txt` |
| `--cmd=eval:<js>` | run JS in the Meet main world → `eval-result.txt` |
| `--cmd=set:<json>` | patch settings |

The app also writes `state.json` (live state) and `devices.json` there.

## Known limits / TODO

- Meet DOM heuristics live in `src/meet/dom.ts`. Joining, waiting-room detection and the
  camera/mic toggles are validated on live Meet. Participant-tile detection is still only
  validated against the mock until the first admitted call.
- Only tiles Meet renders can be captured. Meet's layout (Auto/Tiled, tile count) isn't
  automated yet.
- Camera ISO resolution is whatever Meet sends (usually ≤720p); the bot's own camera is
  sent at 1280×720.
- No NDI audio out yet. Meet's web client only receives the 3 loudest speakers, so true
  per-person audio isn't possible; a mixed program-audio feed is the next step.
- No installer yet (electron-builder with `asarUnpack` for `build/Release/*.node`).
