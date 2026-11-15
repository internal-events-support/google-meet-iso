# GMeet ISO

Zoom-ISO-style isolated feeds for Google Meet. A hidden, signed-in bot joins the meeting,
and GMeet ISO publishes a fixed set of **output slots** as NDI sources (`MACHINE (GMEET 1)`,
`MACHINE (GMEET Speaker)`, …). Each slot follows a participant, the active speaker, or the
screen share. The operator only ever sees the GMeet ISO control app; the Meet window is
never shown.

## What the operator sees

- **Header**: meeting link / live call bar with timer, **ISO engine** (Off / Standby / Live),
  **Rec** (record all enabled outputs), **Show** (open / merge / save show files), CPU / memory /
  downstream bandwidth.
- **Outputs tab**: one card per output slot (grid or list view):
  - live preview, output resolution and fps, tally (**ON AIR** red / **PREVIEW** green), audio
    meter, REC badge
  - editable name (= NDI source name) and on/off switch
  - **Source**: *Auto (next participant)*, *Active speaker*, *Screen share*, or a specific
    participant or screen share. A pinned participant who leaves and rejoins is found again
    by name.
  - **Format**: Native (passthrough) or a fixed 720p / 1080p / 2160p format at 25 / 29.97 / 30 /
    50 / 59.94 fps (scaled and letterboxed, constant frame rate)
  - **Loss mode** when there's no video: black, freeze, transparent (alpha), image, test card
  - **Embedded audio**: ISO (that participant), mix (whole meeting), or none
  - ⚙ drawer: failover to the active speaker, loss image, full-screen **display output** on
    a monitor, audio gain and delay, brightness / contrast / saturation / hue, zoom and pan,
    mirror, **name-tag lower third** (title, subtitle, corner), delete
  - ● record this output to MP4
- **Participants tab**: thumbnail, name, speaker / muted / hand-raised / screen flags, audio
  level, which outputs show them, **Send to…** output, **Mute** (host only).
- **Side panel**:
  - Bot output: camera source (any NDI source or local webcam) with preview, microphone,
    and camera / mic toggles.
  - Meeting: waiting-room banner with **Admit all**, chat to everyone, auto-admit, forced
    tiled layout with max tiles, and the output device for meeting audio.
  - Settings: general, recording folder, NDI network (groups, discovery server, NICs), and
    OSC / HTTP remote control.

## How it works

```
Control UI ─ IPC ─ main process ─┬─ OSC server (udp 9099)        ┐ all three call the
                                 ├─ HTTP + WebSocket API (8787)  ┘ same command dispatcher
                                 ├─ show files, NDI config, display-output windows
                                 └─ hidden Meet client (offscreen BrowserWindow)
                                     ├─ main world: media shim + RTC observer (inject.ts)
                                     └─ preload (Node + native NDI addon)
                                         dom.ts      tiles, names, join flow, layout, chat, admit, mute
                                         sources.ts  one SourceTap per tile: MediaStreamTrackProcessor
                                         outputs.ts  output slots: routing target → passthrough or
                                                     canvas render (scale/effects/name tag/loss) → NDI
                                         audio.ts    remote audio tracks → 48 kHz mix + per-track ISO
                                         speaker.ts  CSRC levels → active speaker, CSRC→participant
                                         recorder.ts WebCodecs H.264/AAC → fragmented MP4
                                         camsource.ts NDI/webcam → the bot's virtual camera
```

- **No official API.** The Meet Media API is closed to new signups, caps video at 3
  streams, and shuts down on 2027‑01‑15. So the app runs the real Meet web client, signed
  in with a dedicated Google account.
- **Offscreen rendering.** Frames are read straight from each tile's MediaStreamTrack, so
  capture doesn't depend on the paint rate. The hidden viewport is 2560×1440 by default:
  Meet sizes each stream to its tile, and a 1080p viewport drops the video to 640×360 with
  three tiles.
- **Tiled layout.** On join the bot sets More options → Adjust view → Tiled with the max
  tile count, so Meet renders (and sends video for) everyone.
- **Fixed-format outputs** render on a drift-corrected clock. When nothing changed (the source
  is slower than the output rate, or the loss content is static), the last frame is re-sent
  without another GPU readback. Measured at a receiver: a steady 30.0 fps from 20–28 fps
  sources.
- **Audio.** Meet's web client receives 3 virtual audio streams carrying the loudest
  speakers. The mix is their sum. The bot's own mic is never included, because Meet doesn't
  send you your own audio. **ISO audio** follows the RTP contributing source (CSRC) of each
  stream. CSRC→participant is learned by correlating who's talking with tile
  speaking-indicator animations, and is trivial when there's one remote participant.
  Unattributed ISO outputs carry silence.

## Remote control

**OSC** (UDP, default listen 9099, replies to the sender on 9098). Prefix `/gmeet/` or
ZoomOSC-style `/zoom/`:

| address | args |
|---|---|
| `startISOEngine` / `standbyISOEngine` / `stopISOEngine` | |
| `setOutputCount` · `addOutput` · `deleteOutput` | n · [name] · out |
| `enableOutput` / `disableOutput` | out |
| `setOutputMode` | out, `participant`/`activeSpeaker`/`screenshare`/`auto` |
| `setOutputName` · `setOutputAudio` · `setOutputLossMode` | out, value |
| `setVideoLossMode` | mode (all outputs) |
| `setOutputSelection` · `userName/outputISO` · `galIndex/outputISO` | out, name / name, out / index, out |
| `joinMeeting` · `leaveMeeting` · `chat` · `admitAll` · `admit` · `userName/mute` · `applyLayout` | |
| `startRecording` / `stopRecording` | [out] |
| `saveShow` / `loadShow` | path |
| `getEngineState` · `getOutputRouting` · `getParticipants` · `getAudioLevels` · `getActiveSpeaker` · `ping` | → `/gmeetosc/…` replies |

`out` is a 1-based index, an output id, or an output name.

**HTTP / WebSocket** (127.0.0.1:8787): `GET /api/state`, `/api/outputs`, `/api/participants`;
`POST /api/command` with a command JSON, e.g.
`{"cmd":"route","output":1,"participant":"Alice"}`, `{"cmd":"engine","state":"standby"}`.
`ws://127.0.0.1:8787/ws` pushes state every 500 ms and accepts the same command JSON. The
full command list is `Command` in `src/shared/types.ts`.

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
4. Pull the `GMEET …` outputs into vMix / OBS / TriCaster.

Recordings go to `Videos\GMeet ISO\<output>_<date-time>.mp4` (fragmented MP4, readable
while recording). They run at the source's real frame rate (variable).

## Testing without a meeting

```bash
npm run mock          # fake Meet DOM (static/mock-meet.html) in the hidden window
npm run verify:ndi    # discovers GMEET sources and receives one frame from each
```

## Dev / automation commands

With the app running, launch a second instance with `--cmd=`. Output goes to `%APPDATA%/gmeet-iso/`:

| command | effect |
|---|---|
| `--cmd=join:<url>` / `--cmd=leave` / `--cmd=quit` | join / leave / quit (leaves the call cleanly) |
| `--cmd=do:<command json>` | run any command → `cmd-result.txt` |
| `--cmd=snap` / `--cmd=snap-ui` | screenshot of the hidden Meet page / control UI |
| `--cmd=dump` | Meet DOM diagnostics → `meet-dom-*.txt` |
| `--cmd=eval:<js>` / `--cmd=eval-ui:<js>` | run JS in the Meet page / control UI → `eval-result.txt` |
| `--cmd=set:<json>` | patch settings |

The app also writes `state.json` (live state) and `devices.json` there.

## Known limits

- Meet DOM heuristics live in `src/meet/dom.ts`, validated on live Meet (Nov 2026). Google
  UI changes can break them.
- ISO audio attribution and the active speaker need someone to actually talk. They're
  implemented, but not yet confirmed in a call with unmuted speakers. Only the 3 loudest
  speakers are ever available, a Meet web-client limit.
- Host tools (mute others, admit) only work if the bot account is a host / co-host.
- NDI network changes (discovery server / NICs) apply after restarting the app.
- No installer yet (electron-builder with `asarUnpack` for `build/Release/*.node`).
