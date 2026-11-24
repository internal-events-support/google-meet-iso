# ZoomISO → Google Meet ISO: feature & UX gap analysis

Sources:
- ZoomISO v2.4 User Guide (PDF)
- liminalet.com/zoomiso
- liminalet.com/zoomiso-v3
- ZoomISO v3.0.4 documentation excerpt
- v3 product screenshots (Grid view, Audio Outputs, Output Effects)

## 1. How ZoomISO is built (mental model)

ZoomISO is **output-centric**. The operator creates N numbered outputs ("ZoomISO 1…8"). Each
output has a stable name, a *mode* (what to show) and a *selection* (who), and the operator
routes people into those slots. Downstream switchers bind to stable source names that never
change when guests come and go.

Google Meet ISO today is **participant-centric**: one NDI source appears per participant, named
after them, and disappears when they leave. That suits a quick ISO setup, but it isn't how a
broadcast operator works. A vMix input labelled "Guest 1" should stay "Guest 1" all show.

**This is the single biggest gap**, and most of the other features hang off it.

## 2. ZoomISO feature inventory vs Google Meet ISO

Legend: ✅ have · 🟡 partial · ❌ missing · ⛔ not possible on Google Meet (platform limit)

### Video outputs
| ZoomISO feature | Notes | Google Meet ISO |
|---|---|---|
| Number of outputs (+/−), stable output names, rename | Output slots | ❌ (auto per-participant only) |
| Per-output enable toggle | | 🟡 per-participant toggle |
| Output **modes**: Participant, Active Speaker, Spotlight index, Screenshare | v2 + v3 | 🟡 participant + screenshare only (implicit) |
| Selection dropdown per output (who) | | ❌ |
| **Video loss mode**: Black / Freeze / Transparent / Image / Testcard | When guest drops or camera off | 🟡 black only |
| Failover modes when a participant disconnects | | ❌ |
| **Fixed output format** (1080p/720p/…, 29.97/30/50/60) with scaling and frame repeat/drop | "Always outputs the requested resolution" | ❌ passes Meet's native size through |
| Output device per slot: NDI, Syphon, SRT, Blackmagic SDI/2110, AJA, displays/DisplayLink | | 🟡 NDI only |
| NDI Advanced: HX3, NIC selection, discovery server, groups | v3 | 🟡 groups only |
| Status per output: incoming res/fps from cloud | | ✅ |
| In-app previews (Grid / List / Previews views) | v3 has 3 view modes | 🟡 grid only |
| Embedded audio per output: Off / ISO / Mix | | ❌ no audio out at all |
| Audio meter strip on each preview | v3 | ❌ |
| Per-output quick actions: mute/unmute guest, video on/off request, chat to guest | v3 | ❌ |
| In-app recording per output (H.264/HEVC/ProRes, MOV/MP4/MXF, growing files, 10 s segments) | v3 | ❌ |
| Output Effects: exposure, contrast, saturation, sharpness, temperature, tint, highlights, shadows, vignette; crop/pan; overlays (auto name tags, images, reactions); scopes (histogram, vectorscope, waveform), guides, apply/auto-apply, save preset | v3 | ❌ |
| Rec.601/709/2020 colour settings; mouse-pointer rendering on screenshare | v3.0.6 | ❌ |

### Audio
| ZoomISO feature | Google Meet ISO |
|---|---|
| Embedded ISO / mix audio in NDI | ❌ |
| Advanced Audio: any multichannel device (Dante VSC, Loopback, BlackHole); multiple devices at once | ❌ |
| Per-channel mode (Participant / Mix / Output / Interpretation), selection, pan, gain reduction, **delay (ms)**, meters | ❌ |
| Interpretation language channels | ⛔ Meet has no interpretation channels |
| Talkback / IFB: private audio to one guest, with ducking | ⛔ Meet can't send audio to a single participant |
| True per-participant ISO audio for everyone | ⛔ partial: the Meet web client only receives the **3 loudest** streams |

### Meeting / participants
| ZoomISO feature | Google Meet ISO |
|---|---|
| Sign in with platform account | ✅ Google sign-in |
| Join / leave meeting | ✅ |
| Participants view: full searchable list | ❌ only participants whose tile is rendered |
| Filters: video, audio, hand raised, panelist/attendee, host/co-host, online | ❌ |
| Assignment **matrix** (participants × outputs; one participant per output, many outputs per participant) | ❌ |
| Spotlight / pin awareness | ❌ |
| Return feed (what the bot sends): audio + video source pickers | ✅ Bot output (NDI or webcam camera, local mic) |
| Chat to group | ❌ |
| Capture consent (Live Stream / Recording permission, petition host) | n/a. Meet has no raw-media consent API. See the ethics note in §5. |

### Engine, control, ops
| ZoomISO feature | Google Meet ISO |
|---|---|
| Master **Capture Enabled** toggle | ❌ |
| Engine states **Disabled / Standing By / Enabled**: outputs published but on loss mode while standing by | ❌ always on |
| Auto-start pipeline on join | ✅ (implicit) |
| Save / Load / **Merge** configuration files (show files) | ❌ |
| **OSC API** (`/zoom/userName/outputISO "Name" 2`, engine control, output count/mode/name, loss mode, routing queries, audio levels) | ❌ |
| Bitfocus Companion module, Stream Deck, Isadora, Universe | ❌ |
| Log with levels (None/Errors/Warnings/Info/Verbose) | 🟡 log drawer, no levels |
| Performance Details: incoming vs target res/fps, engine cycle time, latency, CPU/GPU/RAM/disk/net graphs, CSV export | 🟡 fps + res only |
| System utilisation warning (CPU > 80%, bandwidth cap) | ❌ |
| Licensing / trial card | n/a |

### Things Google Meet ISO has that ZoomISO doesn't
- **NDI source as the bot's camera**, switchable live. ZoomISO's return feed is a device picker.
- Runs on Windows (ZoomISO is macOS / Apple Silicon only).
- No platform licence or Workspace add-on needed.

## 3. UI / UX observations

**v3 (current design):**
- **Top bar**:
  - left: a green **Capture Enabled** pill toggle and the app name
  - centre: icon tabs (**Meeting · Video Outputs · Audio Outputs · Participants**)
  - right: a red **Stop Recording + timecode** button, **Settings**, and the account avatar
- **Output card** (Grid view):
  - header: title, red **REC** badge, enable toggle, Output Effects button, ⋯ menu (duplicate/delete/rename)
  - 16:9 preview with a vertical **audio meter** strip on the right
  - row 1: Mode (icon + "Participant") ▸ Selection (name)
  - status line: green ✓ `1920×1080 60fps`, or "No incoming video"
  - quick actions: mic, camera, chat
  - bottom row: **Output Device / Format / Embedded Audio** dropdowns, each with a small caption underneath
  - empty card: a green branded placeholder silhouette, not black
- **Toolbar** above the grid: "Number of Outputs [8] − +" and a **Grid | List** segmented toggle.
- **Bottom dock**: **Return Feed** with a preview and Audio/Video source pickers, plus **Chat to group (n)** and the version.
- **Audio Outputs**: a collapsible section per device or output, each a channel table with
  Mode, Selection, Pan, Gain reduction, Delay slider + ms, and Meters. "+ Update Audio Devices" at the top.
- **Output Effects**: a separate window with an output picker, preview, Histogram, Vectorscope
  and Waveform. On the right are Color / Cropping / Overlays tabs with slider groups (Adjustments,
  Advanced). Along the bottom: guide toggles, import/export preset, and **Apply**.

**v2 (older):**
- A dense settings-style window with tabs: Outputs, Advanced Audio, Participant Management, OSC, Log, Licensing.
- Spreadsheet-like tables.
- The footer always shows the engine segmented control **Disabled | Standing By | Enabled** with a
  status line ("You can now capture" / "Join a meeting to enable").

**Takeaways for us:**
1. The always-visible engine/capture state and the always-visible return feed are good. We already
   have the bot output panel; it could move to a bottom dock like theirs to free horizontal space for the grid.
2. Output cards put **source → status → destination** in one top-to-bottom flow. Our tiles show the
   source only; there's no "where does this go / what format" row.
3. Empty or no-video states look intentional (branded placeholder), and a lost signal is obvious.
4. Two density modes (Grid with previews, List without) matter at 16+ outputs, for CPU and for scanning.
5. Advanced features (effects, scopes) live in separate windows, so the main view stays operational.

## 4. Recommended roadmap

### P0 — broadcast-correct core
1. **Output slots** ("GMEET 1…N", renameable, stable NDI names).
   - Mode per slot: Participant · Active speaker · Screen share · Auto (next free participant).
   - Keep today's "one per participant" behaviour as an *Auto-assign* option.
2. **Video loss modes**: Black / Freeze / Transparent / Image / Testcard, plus a failover
   choice (hold loss mode vs fall back to active speaker).
3. **Fixed output format**: per-slot resolution and frame rate. Letterbox/scale on the GPU and
   repeat/drop frames to hold a constant cadence. Switchers hate size changes.
4. **Meet layout automation** in the hidden client. This is a hard dependency for 1 and 7,
   because Meet only sends video for rendered tiles and sizes the stream to the tile.
   - Force Tiled view and the max tile count, and hide the self tile.
   - Make sure every assigned participant is on screen; pin when needed.
   - Use a large hidden viewport so tiles request their highest resolution.
5. **Audio out**:
   - meeting **mix** embedded in every NDI output
   - **active-speaker ISO** audio per slot, best effort with ≤3 concurrent speakers
   - meters on cards
   - mix to a selectable local output device (VB-Cable/Dante VSC)

### P1 — operator control
6. **Engine states**: Capture master toggle plus Disabled / Standing by / Enabled in the top bar.
7. **Participants view**: the full roster from Meet's People panel (including camera-off and
   off-screen people), search, filters (camera, mic, hand raised, host, presenting) and an
   assignment matrix.
8. **Control API**: OSC (ZoomISO-compatible verbs such as `/gmeet/userName/outputISO "Name" 2`,
   engine start/standby/stop, output mode/name/count, loss mode, routing/level queries), plus
   HTTP/WebSocket, then a Bitfocus Companion module.
9. **Show files**: save / load / merge configuration.
10. **Host tools**, when the bot is host:
    - **admit / deny** people in the waiting room from our UI (optional auto-admit)
    - mute a participant
    - chat to everyone
    - optional "this meeting is being broadcast" notice sent on join
11. **Log levels**, and a status bar with CPU and network utilisation and a warning threshold.

### P2 — production polish
12. **Output Effects** (WebGL, per slot): colour, crop/pan, **auto name tags** from the Meet
    display name, image overlays, scopes.
13. **Per-output recording**: WebCodecs H.264/HEVC → fragmented MP4/MKV in segments (growing
    files). ProRes would need ffmpeg.
14. **More destinations**: fullscreen display output, then SRT (ffmpeg). NDI NIC selection and
    discovery server via NDI config.
15. **List view** and a scale-to-fit **Previews / multiview** view.
16. **Performance panel**: per-slot latency and cycle time, CSV export.

### Meet-specific extras
- Live **captions** → NDI metadata or a burned-in lower-third.
- Hand-raise and reactions as tally or overlays.
- Bring the **presenter's camera + screen share** out as a linked pair.
- The meeting timer / participant count on the dashboard.

### Out of scope (platform limits)
- Talkback/IFB to one guest
- interpretation channels
- private chat to one guest
- per-participant ISO audio beyond the 3 loudest streams
- Zoom's raw 1080p60 high-bandwidth feeds (Meet cameras are usually ≤720p)

## 5. Notes
- **Consent**: ZoomISO forces a recording/live-stream consent notice on every participant. Meet has no
  equivalent for a bot client, so we should offer (default on) an automatic chat notice on join that the
  meeting is being broadcast. It's good practice and keeps the bot transparent.
- **Resolution ceiling**: ZoomISO's main quality lever is high-bandwidth raw data (1080p, up to
  60 fps in v3). On Meet the lever is layout: big rendered tiles request higher layers. Item 4 above
  is how we close as much of that gap as Meet allows.
