# ZoomISO v3 RE → GMeet ISO port spec

Every subagent reads this first. It maps the reverse-engineered ZoomISO v3.0.7 app onto this Electron/Google Meet project.

## Sources (read-only)
- RE kit: `C:\Users\nerif\Desktop\ZoomISO V3\RE\` (start with README.md)
  - `01-Screen-Map.md`: the true view tree for every window, tab, panel and control. **This is the layout contract.**
  - `02-Components.md`: the 329 views, with state, children and modifiers (grep for the view name)
  - `03-Enums-and-Options.md`: the exact option lists for pickers, tabs and modes
  - `04-ViewModels-and-State.md`: settings and view-model fields (use these as our data-model field list)
  - `05-UI-Strings.md`, `data/ui-labels.txt`, `data/ui-sentences.txt`: real labels, tooltips and alert text. **Use them verbatim**, swapping Zoom→Meet where needed.
  - `06-Design-Tokens.md`, `data/colors.css`: the exact colours (dark appearance)
  - `07-Menu-Bar.md`: the app menu
  - `08-OSC-Commands.md`, `data/allOscCommands.csv`: 278 OSC commands
  - `assets/icons-svg`, `assets/icons-png`, `assets/bundle-images`: real icons, test card, watermark and logos
- Screenshots: `C:\Users\nerif\Desktop\ZoomISO V3\pageNN_imgNN.png` (01-Screen-Map links each view to its screenshot). Layout metrics come ONLY from the screenshots.
- User-guide text: `C:\Users\nerif\AppData\Local\hermes\cache\scratch\zoomiso-v3-guide.txt`
- Earlier analysis: `docs/zoomiso-gap-analysis.md` (what Meet can and can't do)

## Project architecture (as of commit 5bf037a)
- `src/main/main.ts`: Electron main. Settings persistence, IPC, windows, OSC (`osc.ts`), HTTP/WS API (`api.ts`), perf history, and the dev CLI (`electron . --cmd=snap-ui:<name>:<tab>`, `snap-win:<kind>:<name>`, `eval:<js>`, `eval-win:<kind>:<js>`, `do:<Command json>`; results go to the userData folder).
- `src/meet/*`: the hidden Meet page preload. `outputs.ts` is the output engine (WebGL effects, loss modes, NDI send), plus `audio.ts`, `recorder.ts`, `speaker.ts`, `dom.ts` (Meet DOM automation).
- `src/shared/types.ts`: the Settings / OutputConfig / Command / state types and the IPC names. **Shared file: see Ownership.**
- `src/control/*`: the UI, bundled by esbuild (`scripts/build-ui.js`): `kit.ts` (control kit), `store.ts`, `shell.ts` (top bar + Return Feed), `tabs/*`, `video/*`, `windows/*` (settings / effects / perf entries), `recording.ts` (top-bar recording popover).
- `static/*.html` + `static/css/*.css` (`tokens.css` = design tokens).
- Build/check: `npm run typecheck && npm run build:ui`. The app reloads its UI windows from `dist/ui`. Main-process changes need a restart; the user restarts it, so don't kill the running Electron (it's in a live Meet call).

## Mapping (ZoomISO → GMeet ISO)
| ZoomISO | Ours | Feasibility |
|---|---|---|
| `ZISOStream` (output) | `OutputConfig` | ✅ Add RE fields: `isAutoAssign`, `useDefaultAudioMode`, `customImageOverlays` (+rotation, zIndex), `nameTagZIndex`, `overlayNameMode`, per-output `videoLoss`, `autoCrop*` |
| `ZISOStreamInputMode` / Mode picker | `OutputMode` | ✅ participant / activeSpeaker / screenshare / auto. Spotlight maps to Meet pin/spotlight (best effort) |
| `ZISOVideoLossMode` + `VideoLossSettings` (profile picture: size, initials, colours, show name) | `LossMode` + global loss settings | ✅ Add a `profilePicture` mode (Meet avatar/initials) + global vs per-output |
| `ProcAmpSettings` | `OutputEffects` | ✅ colour / tone curve / LGG done; add `whiteBalanceK`, `cropZoom/PanX/PanY/Rotation`, `nameTagFont` (PANameTagFont list), `nameTagPlacement`, `nameTagTextAlignment`, `nameTagCornerRadius`, `nameTagPosition` (double), layer order, `autoApply`. Auto-crop (face tracking) = optional (MediaPipe/FaceDetector in Chromium) |
| `RecordingSettings` | Settings.recording* | ✅ MP4 (mp4-muxer) H.264/HEVC via WebCodecs; MOV/MKV/MXF/ProRes greyed |
| `CaptureEngineController` + `ZISOStreamManagerState` | `EngineState` | ✅ |
| `AutoAssignSettings` | auto mode | ✅ includeHosts, includeNonVideo, includeSelfCamera, continuousEvaluation, offlineParticipantMatching |
| `InterfaceSettings` | Settings | ✅ showSystemPerformanceSummary, compactMode, customFramingGuidePath |
| Audio Outputs (`ZISOAudioDevice` / `ZISOAudioOutputNode`: channelName, audioMode, selection, pan, gain, delay) | Settings.audioOutputDevices | 🟡 Local output devices via setSinkId + per-channel routing in WebAudio; ISO audio only for the 3 loudest Meet streams |
| Audio Inputs / Talkback / Ducking / Interpretation / Sign language | none | ⛔ Show in place, in the same style, disabled, with a tooltip saying why |
| NDI settings (interfaces, discovery) | ndiconfig.ts | ✅ |
| SRT, Blackmagic SDI, AJA, Syphon | none | ⛔ greyed |
| OSC (`ZOSCManager`: host, rx/tx port, interface, allow-list, baud rate, prepend, subscribe mode, disabledCommands) + Command Browser | osc.ts | ✅ Implement the applicable `/zoom/...` commands as `/gmeet/...` AND accept the `/zoom/` prefix for Companion compatibility; Command Browser lists the catalogue with unsupported ones marked |
| Participant Management (filters hostOrCohost / videoOn / audioOn / handRaised; assignment matrix) | Participants tab | ✅ |
| Performance Details (OutputMetric ×6, SystemMetric ×6, timeline scrubber) | perf window | ✅ GPU/disk approximations allowed |
| Menu bar (07) | Electron app menu | ✅ Export/Load Configuration (= show files), Clear Cache, Show Logging, Help |
| Splash / sign-in (`AuthStatus`) | Google sign-in | ✅ Recolour the splash (keep the structure) |

## Rules
1. Visual target = screenshots + 06 tokens. Labels and tooltips = 05 strings. Option lists = 03 enums. Structure and order = 01/02.
2. Platform-impossible features keep their place in the layout but are disabled, each with a tooltip ("Not available in Google Meet").
3. Only edit the files you own. If you need a shared-type change that Phase 0 didn't add, put it in a clearly marked section of `types.ts` and keep your edit minimal and additive.
4. Before finishing: `npm run typecheck` and `npm run build:ui` are clean, you've taken a screenshot of your surface via the dev CLI and compared it to the reference screenshot, and you report which files you changed.
5. Don't commit, and don't restart or kill Electron. The parent does both.
