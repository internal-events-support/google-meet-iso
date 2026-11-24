# Phase 0 contract (shared foundation for the UI agents)

Read with `docs/zoomiso-v3-re-port.md`. Everything here is in place, typechecks and builds. **Don't edit the shared files**
(`src/shared/types.ts`, `src/main/*`, `src/control/kit.ts`, `src/control/preload.ts`, `static/css/tokens.css`); if you must,
add a clearly marked, minimal, additive section (port-spec rule 3).

Main-process changes (menu, commands, migration) take effect after the parent restarts Electron.

## 1. Data model (`src/shared/types.ts`)

All new fields are optional or defaulted. Old `settings.json` and show files still load: `main.ts` deep-merges the nested groups
with their defaults and migrates the legacy flat fields.

### OutputConfig (RE `ZISOStream`)
| Field | Type | Default | Notes |
|---|---|---|---|
| `isAutoAssign` | `boolean?` | `true` | slot can be filled by auto-assign |
| `useDefaultAudioMode` | `boolean?` | `false` | follow `settings.embeddedAudio.defaultMode` |
| `videoLoss` | `VideoLossSettings \| null` | `null` | per-output override, used only when `settings.videoLoss.perOutputVideoLossEnabled` |
| `autoCropEnabled`, `autoCropShowGuides`, `autoCropShowFaceGuides`, `autoCropShowTargetSizeGuide`, `autoCropShowOverscanHorizontalGuide`, `autoCropShowOverscanVerticalGuide`, `autoCropExtendHorizontal`, `autoCropExtendVertical`, `autoCropZoomOutOnLostFace` | `boolean?` | see `DEFAULT_AUTO_CROP` | |
| `autoCropTargetSize`, `autoCropTargetVertical`, `autoCropOverscanHorizontal`, `autoCropOverscanVertical` | `number?` (0..1) | 0.35 / 0.4 / 0.1 / 0.1 | |
| `autoCropResponsiveness` | `AutoCropResponsiveness` = `'low'\|'medium'\|'high'` | `'medium'` | |

`lossMode` / `lossImage` still drive the engine. `setVideoLoss` keeps them in step with the global or override settings.

### OutputEffects (RE `ProcAmpSettings`) — new fields
| Field | Type | Default |
|---|---|---|
| `whiteBalanceK` | number (K) | 6500 |
| `cropZoom`, `cropPanX`, `cropPanY`, `cropRotation` | number (zoom ≥1, pan −1..1, degrees) | 1, 0, 0, 0 |
| `nameTagFont` | `NameTagFont` = `'tahoma'\|'helvetica'\|'arial'\|'verdana'\|'georgia'\|'timesNewRoman'\|'courierNew'` | `'helvetica'` |
| `nameTagNameMode` | `NameTagNameMode` = `'auto'\|'manual'` | `'auto'` |
| `nameTagPlacement` | `NameTagPlacement` = `'left'\|'center'\|'right'` | `'left'` |
| `nameTagTextAlignment` | `NameTagTextAlignment` (same values) | `'left'` |
| `nameTagCornerRadius` | number (px @1080p) | 6 |
| `nameTagOffset` | number 0 (top)..1 (bottom): RE `nameTagPosition` (Double). The legacy corner enum stays in `nameTagPosition`. | 0.85 |
| `overlayLayerOrder` | `OverlayLayerRef[]`, bottom → top: `'nameTag'` or `` `image:${id}` `` | `['nameTag']` |
| `autoApply` | boolean | `true` |

`OverlayImage` gains `rotation?` (deg), `zIndex?`, `filename?`, `aspect?`.
Helpers: `NAME_TAG_FONT_CSS[font]` (CSS font stack) and `migrateNameTagFont(old)`. Old values are migrated on load:
system→helvetica, serif→timesNewRoman, mono→courierNew, rounded→verdana, condensed→tahoma.

### LossMode
`'black' | 'freeze' | 'transparent' | 'image' | 'testcard' | 'profilePicture'`. **TODO (engine):** `profilePicture` isn't rendered
yet. `src/meet/outputs.ts` currently falls through to its default branch.

### Settings: new groups (all required on `Settings`, defaults in `DEFAULT_SETTINGS`)
- `videoLoss: GlobalVideoLossSettings`: `mode`, `image`, `displayOutputNameOnImage`, `profilePictureSize` (fraction of height),
  `profilePictureForceInitials`, `profilePictureBackgroundColor`, `profilePictureOverrideInitialsBgColor`,
  `profilePictureInitialsBgColor`, `profilePictureInitialsColor`, `profilePictureShowName` (= `VideoLossSettings`) + `delay: VideoLossDelay`
  (`'low'|'medium'|'high'`, ms in `VIDEO_LOSS_DELAY_MS`) + `perOutputVideoLossEnabled`. Helper: `effectiveVideoLoss(settings, output)`.
- `recording: RecordingSettings`: `format: RecordingFormat` (`mov|mp4|mkv|mxf`), `videoCodec: RecordingVideoCodec` (`h264|hevc|proRes422LT`),
  `videoBitrateMbps`, `fileNamePrefix`, `fileNameSuffix`, `fileNameDateFormat: RecordingDateFormat`, `selectedOutputIds: string[]`,
  `lowDiskWarningPercent`, `selectNewOutputsByDefault`. The folder is still `settings.recordDir`. Helper: `formatRecordingDate(date, fmt)`.
- `autoAssign: AutoAssignSettings`: `includeHostsAndCoHosts`, `includeNonVideoParticipants`, `includeSelfCamera`,
  `continuouslyEvaluateEligibility`, `offlineParticipantMatching: 'off'|'matchByID'|'matchByIDOrName'`.
- `interface: InterfaceSettings`: `showSystemPerformanceSummary`, `compactMode`, `customFramingGuidePath`.
- `advancedAudio: AdvancedAudioSettings`: `defaultChannelMode: AudioChannelMode`, `defaultPanPattern: PanPattern` (`mono|stereo`),
  `defaultGainDb`, `defaultDelaySeconds`.
- `embeddedAudio: EmbeddedAudioSettings`: `defaultMode: EmbeddedAudio`, `defaultDelayMs`.
- `osc: OscSettings` (RE `ZOSCManager`): `enabled`, `host`, `rxPort`, `txPort`, `interface` (bind IP, '' = all), `enableAllowList`,
  `allowList: string[]`, `allowListPath`, `baudRate: OscBaudRate` (ms in `OSC_BAUD_MS`), `prepend` (reply address header, default
  `/gmeetosc`), `subscribeMode: OscSubscribeMode`, `disabledCommands: string[]`.

**Legacy mirroring:** main keeps these pairs in sync, so a patch to either side works:
`osc.{enabled,rxPort,host,txPort}` ↔ `oscEnabled/oscListenPort/oscReplyHost/oscReplyPort`;
`embeddedAudio` ↔ `defaultAudio/defaultDelayMs`; `videoLoss.{mode,image}` ↔ `defaultLossMode/defaultLossImage`;
`recording.selectNewOutputsByDefault` ↔ `recordNewOutputs`; `autoAssign.includeNonVideoParticipants` ↔ `autoAssignCamerasOff`.
New UI should use the groups. Patch a group with the whole merged object or a partial one; both work, because `setSettings` deep-merges one level.

Already live in main: OSC honours `interface`, `baudRate` (send queue), `prepend`, `enableAllowList`/`allowList` and `disabledCommands`.

### ParticipantState
Adds `isHost?`, `isCohost?`, `avatarUrl?`, `spotlit?`, `pinned?` (the Meet preload doesn't populate them yet: **TODO (meet)**).
`ParticipantFilter` = `'hostOrCohost'|'videoOn'|'audioOn'|'handRaised'`. Helper: `participantMatches(p, filters)`.

### Other types
`AudioChannelMode` (`none|participant|output|activeSpeaker|screenshare|mixAll|mixOutputs|mixUnassigned|interpretation`),
`AudioPan` (`both|left|right`), `SettingsTab`, `OverlayLayerRef`, `OptionItem<T>`, the `NOT_IN_MEET` tooltip string,
and `NESTED_SETTINGS_KEYS`.

## 2. Option lists (`OptionItem<T> = { value, label, disabled?, title? }`)
They map 1:1 onto `kit.popup()`/`segmented()` options. Disabled entries carry a `title` tooltip (rule 2).

| Const | Values → labels |
|---|---|
| `APP_SCREEN_OPTIONS` | Meeting, Video, Audio, Participants, OSC |
| `SETTINGS_TAB_OPTIONS` | General Settings, In Meeting, Output Effects, Video loss settings, Audio Inputs and Talkback, NDI and SRT, OSC settings, Recording Settings, Logs |
| `OUTPUT_MODE_OPTIONS` | Participant, Speaker, Active Screenshare, Auto |
| `LOSS_MODE_OPTIONS` | Black, Freeze, Transparent, Image, Color Bars, Profile Picture |
| `VIDEO_LOSS_DELAY_OPTIONS` | Low, Medium, High |
| `EMBEDDED_AUDIO_OPTIONS` | None, Isolated Participant, Mix of all outputs |
| `AUDIO_CHANNEL_MODE_OPTIONS` | None, Participant, Output, Speaker, Shared screen, All participants, Mix of all outputs, Mix of all unassigned participants, Language (disabled) |
| `PAN_PATTERN_OPTIONS` / `AUDIO_PAN_OPTIONS` | Mono, Stereo / L+R, L-only, R-only |
| `GAIN_REDUCTION_OPTIONS` | 0 … −24 dB (values are numeric strings) |
| `RECORDING_FORMAT_OPTIONS` | QuickTime (.mov) ⛔, MPEG-4 (.mp4), Matroska (.mkv) ⛔, MXF (.mxf) ⛔ |
| `RECORDING_CODEC_OPTIONS` | H.264, H.265 (HEVC), ProRes 422 LT ⛔ |
| `RECORDING_DATE_FORMAT_OPTIONS` | each has `pattern`; label = the pattern (e.g. `yyyy-MM-dd HH-mm-ss`), plus None |
| `OFFLINE_MATCHING_OPTIONS` | Off, Match by ID, Match by ID or name |
| `OSC_BAUD_RATE_OPTIONS` | Fastest possible, 500 ms, 1 second … 25 seconds |
| `OSC_SUBSCRIBE_MODE_OPTIONS` | None, Target List, All participants, Panelists ⛔, Gallery |
| `NAME_TAG_FONT_OPTIONS` | Tahoma, Helvetica, Arial, Verdana, Georgia, Times New Roman, Courier New |
| `NAME_TAG_NAME_MODE_OPTIONS` | Auto, Manual |
| `NAME_TAG_PLACEMENT_OPTIONS` / `NAME_TAG_ALIGNMENT_OPTIONS` | Left, Center, Right |
| `AUTO_CROP_RESPONSIVENESS_OPTIONS` | Low, Medium, High |
| `EFFECTS_TAB_OPTIONS` | Color, Cropping, Overlays |
| `CROP_PREVIEW_MODE_OPTIONS` | Cropped Output, Full View |
| `GUIDE_OVERLAY_OPTIONS` | Thirds Grid, Center Lines, Crosshair, Person Silhouette, Safe Areas |
| `ASPECT_OVERLAY_OPTIONS` | None, 4:3, 1:1, 9:16 |
| `SCOPE_OPTIONS` | Histogram, Vectorscope, Waveform |
| `OUTPUT_ARRANGEMENT_OPTIONS` | Previews (`multiview`), Grid, List |
| `PARTICIPANT_FILTER_OPTIONS` | HOST / CO-HOST, Video On, Audio On, Raised Hand |
| `PERF_SECTION_OPTIONS`, `OUTPUT_METRIC_OPTIONS`, `SYSTEM_METRIC_OPTIONS` | Outputs/System; the six metric names |
| `LOG_LEVEL_OPTIONS` | Error, Warning, Info, Verbose |

**Inferred labels** (the RE dump has the enum cases but not their display text): Black/Freeze/Image/Color Bars,
Participant/Auto (mode), Off/Match by ID, the baud seconds, the subscribe modes (ZoomOSC semantics: case names guessed),
the audio channel-mode list, the guide/aspect/crop-preview labels, the metric labels and the date-format labels. Check them against the screenshots and fix them in place.

## 3. Commands (`Command` union; all handled in `main.ts executeCommand`)
Existing commands are unchanged. New ones:
| Command | Behaviour |
|---|---|
| `{cmd:'setVideoLoss', output?, patch}` | No `output` sets the global `videoLoss` and mirrors mode/image onto outputs without an active override. With `output`, `patch` sets that output's override (`null` clears it). |
| `{cmd:'startRecording', outputs?}` | Arms `record` on the listed outputs (default `recording.selectedOutputIds`) and disarms the rest. Also saves the selection. |
| `{cmd:'stopRecording', outputs?}` | Disarms the listed outputs (default: all). |
| `{cmd:'assignParticipant', participant, output}` | Same as `route` (null = clear). |
| `{cmd:'unassignParticipant', participant}` | Clears the participant from every output. Returns the affected ids. |
| `{cmd:'setAutoAssign', output, on}` | Sets `isAutoAssign`. |
| `{cmd:'resetEffects', output, section?}` | `section`: `'color'|'crop'|'overlays'|'all'`. Resets to `DEFAULT_EFFECTS`. |
| `{cmd:'copyEffects', from, to[]}` | Copies the effects. |
| `{cmd:'spotlight'|'pin', participant, on}`, `{cmd:'lowerHand', participant?}`, `{cmd:'muteAll'}`, `{cmd:'removeParticipant', participant}` | Forwarded to the Meet page. **TODO (meet):** not implemented in `src/meet/preload.ts` yet. |
| `{cmd:'setOscCommandEnabled', address, enabled}` | Edits `osc.disabledCommands`. |
| `{cmd:'signOut'}` | Leaves the call, clears the Meet session's cookies and storage, and reloads Meet. |
| `{cmd:'clearCache', confirm?}` | Asks for confirmation, deletes settings.json, clears the Meet HTTP cache, then **quits**. |

OSC: `/…/startRecording [out…]` and `/…/stopRecording [out…]` now map to the new commands, `/…/setVideoLossMode` maps to
`setVideoLoss`, and the loss names also accept `profilePicture` and `colorBars`.

## 4. Main process / API
- **Application menu** (RE 07, adapted for Windows):
  - **Google Meet ISO:** About, Settings… (Ctrl+,), Sign in with embedded browser, Sign Out, Quit (Ctrl+Q)
  - **File:** Export Configuration (Ctrl+S) → `saveShow`; Load Configuration (Ctrl+O) → `loadShow`; Clear Cache (app will close)
  - **Edit:** standard roles
  - **Window:** Minimize, Zoom, Show Logging (opens Settings with `arg=logs`)
  - **Help:** Google Meet ISO Help (F1); Check for Updates (disabled)

  The control window keeps the menu attached but hidden, so the accelerators work. The UI can show it with
  **`gmeetIso.popupAppMenu(x?, y?)`** (new `ControlApi` method, IPC `ctl:popupAppMenu`), e.g. from a top-bar button.
- **Opening Settings on a tab:** `openWindow('settings', <SettingsTab>)` now reloads an already-open Settings window with the new `arg`.
  The settings window should read `?arg=` and select that tab (`'logs'` is used by Show Logging). No `'logs'` WindowKind was added.
- Show files now include `videoLoss, recording, autoAssign, interface, advancedAudio, embeddedAudio, osc`.
- `OscServer.start(port, bindAddress)`. `OscServer.minGapMs` sets the baud-rate queue.

## 5. Icons (`src/control/kit.ts`)
`icon(name)` accepts the old glyph names and these RE names. They render as a CSS mask, take `currentColor`, and are sized with `font-size` (`.ico.re-ico` in tokens.css):

`mic.outline`, `mic.slash.outline`, `camera.outline`, `camera.slash.outline`, `chat.outline`, `speaker.outline`, `audio`, `osc`,
`slash.commands` (SVG), and `speaker.fill`, `spotlight.fill`, `record.large.fill`, `screenshare.fill`, `profile.small.fill`,
`headset.fill`, `events.fill`, `video.fill` (@2x PNG; the `.fill` SVGs render solid).

The old hand-drawn `osc` glyph is now `oscGlyph`.
Exports: `RE_ICON_FILES`, `reIconUrl(name)`, `RE_ASSET_BASE` (`'re-assets'`, relative to `static/*.html`), and
`RE_IMAGES = { testcard, colourbars, watermark, profilePlaceholder, videoLoss, frameGuide }` (full-colour `<img src>` paths).
Files: `static/re-assets/icons/*.svg|@2x.png`, `static/re-assets/images/*.png`.

## 6. Design tokens (`static/css/tokens.css`)
All 28 RE colours exist under their RE names, with the exact dark values: `--button-bg`, `--button-bg-disabled`, `--button-bg2`,
`--button-bottom-bevel(-disabled)`, `--button-top-bevel(-disabled)`, `--capture-engine-disabled`, `--fill-global-error|success|warning`,
`--fill-primary`, `--meter-bg`, `--meter-border`, `--output-card-bg`, `--output-card-shadow`, `--picker-bg`, `--picker-selected-bg`,
`--selected-tab-color(-unfocused)`, `--splash-screen-{top,bottom}-{iso,osc}`, `--table-bg`, `--table-header-bg`, `--table-row-bg`, `--window-bg`.
There's one more, `--toolbar-bg: #383838`, measured from the screenshots.

Legacy aliases still work:
| Legacy | Now |
|---|---|
| `--win` | window-bg |
| `--bar` | toolbar-bg |
| `--panel` | output-card-bg |
| `--panel-2` | table-header-bg |
| `--panel-hover` | table-row-bg |
| `--control` | button-bg |
| `--control-hover` | button-bg2 |
| `--control-active` | picker-selected-bg |
| `--blue` | fill-primary |
| `--green-ui`, `--green-pill` | fill-global-success |
| `--red-btn` | fill-global-error |

New shorthands: `--primary`, `--success`, `--warning`, `--error`. The text greys and the system hues (`--green`, `--red`, `--orange`, …) have no RE asset and are unchanged.
