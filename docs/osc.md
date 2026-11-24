# OSC and HTTP/WS control (ZoomOSC / ZoomISO v3 compatible)

Google Meet ISO implements the ZoomISO v3 OSC catalogue (`RE/data/allOscCommands.csv`, 278 rows) wherever Google Meet allows it.
**Coverage: 83/278 catalogue rows supported** (54/206 incoming commands, 29/72 outputs/responses).
The machine-readable list is `src/shared/oscSupport.ts` (`OSC_SUPPORT`, `OSC_SUPPORTED`, `oscSupportFor()`), which the Settings Command Browser imports. It's also served at `GET /api/osc/support`.

Code: `src/main/osc/router.ts` (parser, targets, commands, replies, subscriptions), `src/main/osc.ts` (UDP codec + baud-rate queue), `src/main/api.ts` (HTTP/WS bridge). The legacy `/gmeet/...` extras in `main.ts` `onOsc` (`saveShow`, `loadShow`, `applyLayout`, `setOutputLossMode`, …) still work: the router passes through anything it doesn't know.
Tests: `node scripts/test-osc.js` (codec, parser, targets, commands, replies, subscriptions; no network).

## Addresses

Incoming prefixes, all equivalent and case-insensitive: `/gmeet/…`, `/gmeetiso/…`, `/zoom/…`, `/zoomosc/…` (the last two are for Bitfocus Companion's ZoomOSC/ZoomISO modules).

```
/zoom/<command> args…                       global command
/zoom/<target>/<command> <targetValue> args… user command
```

Targets (RE `SimulatorTarget`):

| Target | Value | Meaning in Meet |
|---|---|---|
| `userName` | str | Display name, case-sensitive first, then case-insensitive |
| `galleryIndex` / `galIndex` / `galleryPosition` | int | 0-based position in the gallery order (camera feeds in roster order, self included) |
| `zoomID` / `targetID` | int or str | A synthetic int per Meet participant (stable while they stay in the call; starts at 16778241). The Meet participant id string is accepted too |
| `pID` / `participantID` | str | Meet participant id |
| `me` | – | The bot |
| `all`, `panelists`, `attendees` | – | Everyone (Meet has no webinar roles) |
| `allExcept/<type>`, `panelistsExcept/<type>`, `attendeesExcept/<type>`, `allExcept/me` | value | Everyone except the target |
| `users/<type>` | v1 v2 … | Several users (any trailing command args, e.g. `outputISO`'s output, come last) |

Examples: `/zoom/userName/pin "Alice"`, `/zoom/galIndex/outputISO 2 3`, `/zoom/users/zoomID/unPin 16778242 16778243`, `/zoom/me/raiseHand`, `/zoom/allExcept/userName/eject "Host"`, `/zoom/all/mute`.

## Outgoing messages

Header = Settings → OSC → "OSC address header" (`osc.prepend`, default `/gmeetosc`). While it is the default and a client has sent a `/zoom` or `/zoomosc` command, replies and events use **`/zoomosc`** so Companion's ZoomOSC module recognises them. A custom header always wins. `/gmeet` requests also get `<header>/ok <address>`; failures go to `<header>/oscErrors <message>`.

User events/replies use the ZoomOSC layout `<header>/user/<event>` (or `<header>/me/<event>` for the bot):
`{int targetIndex} {str userName} {int galleryIndex} {int zoomID} …extra`. Here targetIndex is the 1-based output showing that person, or -1.

| Reply / event | Args after the user block |
|---|---|
| `pong` (no user block) | `pingArg or 0, appVersion, subscribeMode, galTrackMode, inCall, outputCount, galleryCount, isPro=1` |
| `list` (after `listCleared`) | `targetCount, listCount, userRole (1 host, 2 co-host, 5 attendee), online=1, video, audio (1 = unmuted), handRaised` |
| `outputRouting` (no user block) | `numOutputs, outputNum, enabled, name, mode, selection (0 none, 1 auto, else zoomID), resolution, embeddedAudio, status` |
| `audioLevels` | `outputIndex, level 0–255` (the level of the person on that output) |
| `engineState` | `0 disabled, 1 standby, 2 enabled` (also sent on change) |
| `galleryCount`, `galleryOrder`, `spotOrder` | count; zoomIDs (or participant ids when `galTrackMode 0`); spotlit zoomIDs |
| `waitingRoomUserList` | `index, count, zoomID=0, name, name` |
| `meetingStatusChanged` | `status (0 idle, 1 connecting, 3 in meeting, 7 ended, 8 waiting room, 9 failed), 0, 0` |
| events | `online`, `offline`, `videoOn/Off`, `mute/unMute`, `handRaised/Lowered`, `isSpeaking/stoppedSpeaking`, `activeSpeaker`, `spotlightOn/Off`, `userNameChanged {oldName}`, `roleChanged {role}`, `joinedWaitingRoom/leftWaitingRoom` (name only) |

### Subscriptions and baud rate
Events come from diffing every Meet state push (about 2/s). `/zoom/subscribe <int>` sets Settings `osc.subscribeMode`: 0 none, 1 targetList (people on an output), 2 all, 3 panelists (= all), 4 gallery (people with video on). `list` honours the same filter. The baud rate (Settings `osc.baudRate`) spaces outgoing packets. Queued state events are coalesced per event+user, so slow rates deliver the latest state instead of a backlog (the queue is capped at 2000). Every outgoing message name can be switched off in the Command Browser (`disabledCommands`).

## ISO / output semantics
- `setOutputMode <out> <int|str>`: indices follow the ZoomISO picker without Gallery: 0 Participant, 1 Active Speaker, 2 Unique Speaker (→ Active Speaker), 3 Spotlight (rejected), 4 Screen Share and 5 Active Screenshare (→ screenshare), 6 Auto. Strings match the labels. *(The index order for 2–4 is inferred from the catalogue text.)*
- `setOutputSelection <out> <sel>`: 0 clears, 1 = Auto, 2…N+1 = gallery row (non-self), any other int = zoomID, string = name.
- `setOutputEmbeddedAudio`: 0 Off, 1 ISO, 2 Mix. `setVideoLossMode`: 0 Black, 1 Transparent, 2 Image, 3 Testcard, 4 Freeze, 5 Color Bars (= testcard), 6 Profile Picture.
- `<out>` = 1-based index, output name, or output id.

## HTTP / WebSocket
- `POST /api/osc` `{"address":"/zoom/userName/pin","args":["Alice"]}` → `{ok, handled, replies:[{address,args}]}`
- `GET /api/osc/support|list|gallery|routing|audioLevels|engine`
- WS `/ws`: send `{"type":"osc","address":…,"args":[…],"requestId":"1"}` → `{"type":"osc",requestId,handled,replies}`. Command JSON (`POST /api/command`) works as before.

## Gaps / dependencies
- `pin`, `spotlight`, `lowerHand`, `muteAll`, `removeParticipant` and the new `raiseHand` Command are forwarded to the Meet page (`src/meet/preload.ts` runCommand). Until that DOM automation lands, they return an error from the page.
- Meet can't unmute others, turn other people's cameras on or off, raise their hands, or send private chat. These return `oscErrors`.
- Not captured from Meet: incoming chat, reactions (`emojiChanged`), captions, and screen-share start/stop events.
- Not exposed yet: `audioISO` / `audioRouting` / `setAudioMode` (Audio Outputs), and bot device/view settings.

## Full catalogue

### App Info

| Message | Type | Supported | Note |
|---|---|---|---|
| `ping` | Incoming Command | ✅ | Replies /pong with ZoomISO fields. |

### App Info - Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `oscErrors` | Outgoing Command | ✅ | Emitted on parse/exec errors. |

### App Info - Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `pong` | Response to incoming message | ✅ |  |

### Breakout Room

| Message | Type | Supported | Note |
|---|---|---|---|
| `removeFromBreakout` | Incoming User Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `sendToBreakout` | Incoming User Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `assignToBreakout` | Incoming User Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `unassignFromBreakout` | Incoming User Command | ⛔ | Google Meet breakout rooms have no API/automation. |

### Breakout Rooms

| Message | Type | Supported | Note |
|---|---|---|---|
| `createBreakout` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `deleteBreakout` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `deleteAllBreakouts` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `openBreakouts` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `closeBreakouts` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `broadcastToBreakouts` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `joinBreakout` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `leaveBreakout` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `configureBreakouts` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `distributeBreakoutsOfSize` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |
| `spreadToBreakouts` | Incoming Command | ⛔ | Google Meet breakout rooms have no API/automation. |

### Breakout Rooms - Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `listBreakouts` | Incoming Command | ⛔ | No breakout rooms. |
| `listBreakouts` | Response to incoming message | ⛔ | No breakout rooms. |

### Chat

| Message | Type | Supported | Note |
|---|---|---|---|
| `chat` | Outgoing User Command | ⛔ | Meet has no private chat; incoming chat is not captured. |
| `chatAll` | Incoming Command | ✅ | Meet chat to everyone. |
| `chatWaitingRoom` | Incoming Command | ⛔ | No lobby chat in Meet. |
| `chatPanelists` | Incoming Command | ⛔ | No webinar roles. |
| `chat` | Incoming User Command | ⛔ | Meet has no private chat; incoming chat is not captured. |
| `chatAttendee` | Incoming User Command | ⛔ | No webinar roles. |

### Data Accessors

| Message | Type | Supported | Note |
|---|---|---|---|
| `getOutputRouting` | Incoming Command | ✅ |  |
| `getEngineState` | Incoming Command | ✅ |  |
| `getAudioLevels` | Incoming Command | ✅ | Per participant (Meet attributes the 3 loudest). |
| `getAudioRouting` | Incoming Command | ⛔ | Not implemented yet. |

### Gallery Tracking and Data Requests

| Message | Type | Supported | Note |
|---|---|---|---|
| `galTrackMode` | Incoming Command | ✅ |  |
| `getGalleryOrder` | Incoming Command | ✅ |  |

### Gallery Tracking and Data Requests - Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `subscribe` | Incoming Command | ✅ |  |

### Gallery Tracking and Data Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `galleryCount` | Incoming Command | ✅ |  |
| `galleryCount` | Response to incoming message | ✅ |  |
| `galleryOrder` | Outgoing Command | ✅ | Roster order (Meet has no stable gallery grid). |

### General

| Message | Type | Supported | Note |
|---|---|---|---|
| `returnToMainMeeting` | Incoming User Command | ⛔ | No breakout rooms. |

### General - Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `listCleared` | Outgoing Command | ✅ |  |

### Global

| Message | Type | Supported | Note |
|---|---|---|---|
| `joinMeeting` | Incoming Command | ✅ | meetingID = Meet code or URL; password/name ignored. |
| `startMeeting` | Incoming Command | ✅ | Joins meet.google.com/new (or the given code). |
| `leaveMeeting` | Incoming Command | ✅ |  |
| `endMeeting` | Incoming Command | ⛔ | Ending for all is not automated (use leaveMeeting). |
| `all/mute` | Incoming Command | ✅ | Mute everyone (host). |
| `all/unMute` | Incoming Command | ⛔ | Meet cannot unmute others. |
| `enableTranscription` | Incoming Command | ⛔ | Not automated. |
| `disableTranscription` | Incoming Command | ⛔ | Not automated. |

### Hand Raising

| Message | Type | Supported | Note |
|---|---|---|---|
| `raiseHand` | Incoming User Command | ✅ | Me only. |
| `lowerHand` | Incoming User Command | ✅ | Me or others (host). |
| `toggleHand` | Incoming User Command | ✅ | Me only. |
| `lowerAllHands` | Incoming Command | ✅ |  |

### Hidden

| Message | Type | Supported | Note |
|---|---|---|---|
| `exportAllMessages` | Incoming Command | ⛔ | Chat history is not captured. |
| `jmakjoin` | Incoming Command | ⛔ | Zoom-only. |

### ISO Routing

| Message | Type | Supported | Note |
|---|---|---|---|
| `audioISO` | Incoming User Command | ⛔ | Audio channel routing is configured in Audio Outputs, not via OSC yet. |

### Interpretation

| Message | Type | Supported | Note |
|---|---|---|---|
| `makeSignInterpreter` | Incoming User Command | ⛔ | No interpretation in Meet. |
| `removeSignInterpreter` | Incoming User Command | ⛔ | No interpretation in Meet. |
| `startSignInterpretation` | Incoming Command | ⛔ | No interpretation in Meet. |
| `stopSignInterpretation` | Incoming Command | ⛔ | No interpretation in Meet. |
| `getSignInterpretationList` | Incoming Command | ⛔ | No interpretation in Meet. |
| `getAllSignLanguageList` | Incoming Command | ⛔ | No interpretation in Meet. |
| `getSignIterpretationStatus` | Incoming Command | ⛔ | No interpretation in Meet. |

### Interpretation Info Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `signInterpreterList` | Outgoing Command | ⛔ | No interpretation in Meet. |
| `signLanguageList` | Outgoing Command | ⛔ | No interpretation in Meet. |
| `signInterpretationStatus` | Outgoing Command | ⛔ | No interpretation in Meet. |

### Meeting Info

| Message | Type | Supported | Note |
|---|---|---|---|
| `list` | Outgoing Command | ✅ |  |
| `list` | Incoming Command | ✅ |  |

### Meeting and Webinar Q&A

| Message | Type | Supported | Note |
|---|---|---|---|
| `answerQuestionLive` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `answerQuestionDone` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `answerQuestionText` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `dismissQuestion` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `deleteQuestion` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `reopenQuestion` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `getQuestionList` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `getQuestionInfo` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `getAnswerList` | Incoming Command | ⛔ | Meet Q&A is not automatable. |
| `getAnswerInfo` | Incoming Command | ⛔ | Meet Q&A is not automatable. |

### Meeting and Webinar Q&A - Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `questionInfo` | Response to incoming message | ⛔ | Meet Q&A is not automatable. |

### Meeting and Webinar Q&A User Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `questionAnsweredLive` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |
| `questionAnsweredDone` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |
| `questionDismissed` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |

### Output Settings Controls

| Message | Type | Supported | Note |
|---|---|---|---|
| `requestCapturePermission` | Incoming Command | ⛔ | macOS-only. |
| `setOutputCount` | Incoming Command | ✅ |  |
| `enableOutput` | Incoming Command | ✅ |  |
| `disableOutput` | Incoming Command | ✅ |  |
| `setOutputMode` | Incoming Command | ✅ | Spotlight/Unique Speaker map to the closest Meet mode. |
| `setOutputName` | Incoming Command | ✅ |  |
| `addOutput` | Incoming Command | ✅ |  |
| `deleteOutput` | Incoming Command | ✅ |  |
| `setVideoLossMode` | Incoming Command | ✅ | Image/Freeze/etc. Color Bars = testcard. |
| `setAudioMode` | Incoming Command | ⛔ | Not implemented yet. |
| `setAudioGainReduction` | Incoming Command | ⛔ | No talkback/ducking. |
| `setAudioChannelLanguage` | Incoming Command | ⛔ | No interpretation. |

### Outputs

| Message | Type | Supported | Note |
|---|---|---|---|
| `meetingStatusChanged` | Outgoing Command | ✅ |  |

### Pin

| Message | Type | Supported | Note |
|---|---|---|---|
| `pin` | Incoming User Command | ✅ | Meet pin (best effort). |
| `unPin` | Incoming User Command | ✅ |  |
| `addPin` | Incoming User Command | ✅ | Meet allows one pin; replaces. |
| `togglePin` | Incoming User Command | ✅ |  |
| `clearPin` | Incoming Command | ✅ |  |
| `pin2` | Incoming User Command | ⛔ | No second-screen pin in Meet. |
| `unPin2` | Incoming User Command | ⛔ | No second-screen pin. |
| `clearPin2` | Incoming Command | ⛔ | No second-screen pin. |
| `togglePin2` | Incoming User Command | ⛔ | No second-screen pin. |

### Polls

| Message | Type | Supported | Note |
|---|---|---|---|
| `startPoll` | Incoming Command | ⛔ | Meet polls are not automatable. |
| `relaunchPoll` | Incoming Command | ⛔ | Meet polls are not automatable. |
| `stopPoll` | Incoming Command | ⛔ | Meet polls are not automatable. |
| `getPollList` | Incoming Command | ⛔ | Meet polls are not automatable. |
| `getPollInfo` | Incoming Command | ⛔ | Meet polls are not automatable. |
| `getPollQuestions` | Incoming Command | ⛔ | Meet polls are not automatable. |
| `getPollAnswers` | Incoming Command | ⛔ | Meet polls are not automatable. |

### Polls Outputs

| Message | Type | Supported | Note |
|---|---|---|---|
| `polls` | Response to incoming message | ⛔ | Meet polls are not automatable. |
| `pollInfo` | Response to incoming message | ⛔ | Meet polls are not automatable. |
| `pollQuestions` | Response to incoming message | ⛔ | Meet polls are not automatable. |
| `pollAnswers` | Response to incoming message | ⛔ | Meet polls are not automatable. |

### Question Info Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `questionList` | Response to incoming message | ⛔ | Meet Q&A is not automatable. |
| `answerList` | Response to incoming message | ⛔ | Meet Q&A is not automatable. |
| `answerInfo` | Response to incoming message | ⛔ | Meet Q&A is not automatable. |
| `questionDone` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |
| `answeredQuestionText` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |
| `questionReopened` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |
| `askedQuestion` | Outgoing User Command | ⛔ | Meet Q&A is not automatable. |
| `deletedQuestion` | Outgoing Command | ⛔ | Meet Q&A is not automatable. |
| `deletedAnswer` | Outgoing Command | ⛔ | Meet Q&A is not automatable. |

### Recording

| Message | Type | Supported | Note |
|---|---|---|---|
| `startLocalRecording` | Incoming Command | ✅ | Starts ISO recording of the selected outputs. |
| `pauseLocalRecording` | Incoming Command | ⛔ | The ISO recorder has no pause/resume. |
| `resumeLocalRecording` | Incoming Command | ⛔ | The ISO recorder has no pause/resume. |
| `stopLocalRecording` | Incoming Command | ✅ | Stops ISO recording. |
| `startCloudRecording` | Incoming Command | ⛔ | Meet cloud recording is not automated. |
| `pauseCloudRecording` | Incoming Command | ⛔ | Meet cloud recording is not automated. |
| `resumeCloudRecording` | Incoming Command | ⛔ | Meet cloud recording is not automated. |
| `stopCloudRecording` | Incoming Command | ⛔ | Meet cloud recording is not automated. |
| `allowToRecord` | Incoming User Command | ⛔ | Meet cloud recording is not automated. |
| `disallowToRecord` | Incoming User Command | ⛔ | Meet cloud recording is not automated. |

### Return Information and Callbacks

| Message | Type | Supported | Note |
|---|---|---|---|
| `outputRouting` | Response to incoming message | ✅ |  |
| `audioLevels` | Response to incoming message | ✅ |  |
| `audioRouting` | Response to incoming message | ⛔ | Not implemented yet. |

### Return Information and Callbacks - Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `engineState` | Outgoing Command | ✅ |  |

### Screen Share

| Message | Type | Supported | Note |
|---|---|---|---|
| `startScreenshare` | Incoming Command | ⛔ | The bot does not screen share. |
| `startScreensharePrimary` | Incoming Command | ⛔ | The bot does not screen share. |
| `startWindowShare` | Incoming Command | ⛔ | The bot does not screen share. |
| `stopShare` | Incoming Command | ⛔ | The bot does not screen share. |
| `startAudioShare` | Incoming Command | ⛔ | The bot does not screen share. |
| `startCameraShare` | Incoming Command | ⛔ | The bot does not screen share. |
| `shareNextCamera` | Incoming Command | ⛔ | The bot does not screen share. |
| `listWindows` | Incoming Command | ⛔ | The bot does not screen share. |
| `listScreens` | Incoming Command | ⛔ | The bot does not screen share. |
| `enableComputerSoundWhenSharing` | Incoming Command | ⛔ | The bot does not screen share. |
| `disableComputerSoundWhenSharing` | Incoming Command | ⛔ | The bot does not screen share. |
| `enableOptimizeVideo` | Incoming Command | ⛔ | The bot does not screen share. |
| `disableOptimizeVideo` | Incoming Command | ⛔ | The bot does not screen share. |

### Settings

| Message | Type | Supported | Note |
|---|---|---|---|
| `listMicDevices` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `setMicDevice` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `getMicDevice` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `setMicVolume` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `getMicVolume` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `listSpeakerDevices` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `setSpeakerDevice` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `setSpeakerVolume` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `getSpeakerVolume` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `getSpeakerDevice` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `listCameraDevices` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `setCameraDevice` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `getCameraDevice` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `listBackgrounds` | Incoming Command | ⛔ | Meet backgrounds/filters are not automated. |
| `setBackground` | Incoming Command | ⛔ | Meet backgrounds/filters are not automated. |
| `getBackground` | Incoming Command | ⛔ | Meet backgrounds/filters are not automated. |
| `selectedBackground` | Response to incoming message | ⛔ | Meet backgrounds/filters are not automated. |
| `listFilters` | Incoming Command | ⛔ | Meet backgrounds/filters are not automated. |
| `setFilter` | Incoming Command | ⛔ | Meet backgrounds/filters are not automated. |
| `getFilter` | Incoming Command | ⛔ | Meet backgrounds/filters are not automated. |
| `enableUsernameLabels` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `disableUsernameLabels` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `enableOriginalSound` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `disableOriginalSound` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `enableMirrorVideo` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `disableMirrorVideo` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `enableHDVideo` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `disableHDVideo` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `showNonVideoParticipants` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `hideNonVideoParticipants` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `showUserNames` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `hideUserNames` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |

### Settings Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `micDevices` | Response to incoming message | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `micDevice` | Response to incoming message | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `speakerDevices` | Response to incoming message | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `cameraDevices` | Response to incoming message | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `backgrounds` | Response to incoming message | ⛔ | Meet backgrounds/filters are not automated. |
| `filters` | Response to incoming message | ⛔ | Meet backgrounds/filters are not automated. |
| `selectedFilter` | Response to incoming message | ⛔ | Meet backgrounds/filters are not automated. |

### Spotlight

| Message | Type | Supported | Note |
|---|---|---|---|
| `getSpotOrder` | Incoming Command | ✅ |  |
| `spot` | Incoming User Command | ✅ | Meet spotlight (host). |
| `unSpot` | Incoming User Command | ✅ |  |
| `addSpot` | Incoming User Command | ✅ | Meet has one spotlight; replaces. |
| `toggleSpot` | Incoming User Command | ✅ |  |
| `clearSpot` | Incoming Command | ✅ |  |

### Spotlight - Info

| Message | Type | Supported | Note |
|---|---|---|---|
| `spotlightOn` | Outgoing User Command | ✅ | Best effort (Meet DOM). |
| `spotlightOff` | Outgoing User Command | ✅ | Best effort (Meet DOM). |
| `spotOrder` | Outgoing Command | ✅ |  |

### Talkback

| Message | Type | Supported | Note |
|---|---|---|---|
| `enableTalkback` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `disableTalkback` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `getTalkbackStatus` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `talkbackStatus` | Response to incoming message | ⛔ | Talkback is not available in Google Meet ISO. |
| `latchTalkbackChannel` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `unLatchTalkbackChannel` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `getLatchTalkbackStatus` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `latchTalkbackStatus` | Response to incoming message | ⛔ | Talkback is not available in Google Meet ISO. |
| `setTalkbackChannelDucking` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `getTalkbackChannelDucking` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `talkbackChannelDucking` | Response to incoming message | ⛔ | Talkback is not available in Google Meet ISO. |
| `getTalkbackChannelStatus` | Incoming Command | ⛔ | Talkback is not available in Google Meet ISO. |
| `talkbackChannelStatus` | Response to incoming message | ⛔ | Talkback is not available in Google Meet ISO. |

### User Info

| Message | Type | Supported | Note |
|---|---|---|---|
| `isSpeaking` | Outgoing User Command | ✅ |  |
| `stoppedSpeaking` | Outgoing User Command | ✅ |  |
| `handRaised` | Outgoing User Command | ✅ |  |
| `handLowered` | Outgoing User Command | ✅ |  |
| `audioStatus` | Outgoing User Command | ⛔ | Not implemented. |
| `videoShareStarted` | Outgoing User Command | ⛔ | Screen shares appear as separate feeds; not emitted yet. |
| `videoShareStopped` | Outgoing User Command | ⛔ | Not emitted yet. |
| `audioShareStarted` | Outgoing User Command | ⛔ | Not in Meet. |
| `audioShareStopped` | Outgoing User Command | ⛔ | Not in Meet. |
| `emojiChanged` | Outgoing User Command | ⛔ | Meet reactions are not captured. |
| `userNameChanged` | Outgoing User Command | ✅ | Detected by participant id. |
| `online` | Outgoing User Command | ✅ |  |
| `offline` | Outgoing User Command | ✅ |  |
| `joinedWaitingRoom` | Outgoing User Command | ✅ | Lobby names only (no zoomID). |
| `leftWaitingRoom` | Outgoing User Command | ✅ | Lobby names only. |
| `roleChanged` | Outgoing User Command | ✅ | Host/co-host when Meet exposes it. |
| `transcriptMessage` | Outgoing User Command | ⛔ | Meet captions are not captured. |
| `activeSpeaker` | Outgoing User Command | ✅ |  |

### User Roles and Action

| Message | Type | Supported | Note |
|---|---|---|---|
| `rename` | Incoming User Command | ⛔ | Meet cannot rename others. |
| `makeHost` | Incoming User Command | ⛔ | Meet host transfer is not automatable. |
| `makeCoHost` | Incoming User Command | ⛔ | Co-host management is not automatable. |
| `makeAttendee` | Incoming User Command | ⛔ | No webinar roles. |
| `makePanelist` | Incoming User Command | ⛔ | No webinar roles. |
| `revokeCoHost` | Incoming User Command | ⛔ | Co-host management is not automatable. |
| `reclaimHost` | Incoming User Command | ⛔ | Not in Meet. |
| `eject` | Incoming User Command | ✅ | Remove from call (host). |

### User controls

| Message | Type | Supported | Note |
|---|---|---|---|
| `outputISO` | Incoming User Command | ✅ |  |
| `setGalleryView` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `setSpeakerView` | Incoming Command | ⛔ | Bot devices are chosen in Settings, not via OSC. |
| `stopIncomingAudio` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `startIncomingAudio` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `stopIncomingVideo` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `startIncomingVideo` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `allowToSpeak` | Incoming User Command | ⛔ | No webinar roles. |
| `disallowToSpeak` | Incoming User Command | ⛔ | No webinar roles. |
| `enableUsersUnmute` | Incoming Command | ⛔ | Not automated. |
| `disableUsersUnmute` | Incoming Command | ⛔ | Not automated. |

### Video/Mic

| Message | Type | Supported | Note |
|---|---|---|---|
| `videoOn` | Outgoing User Command | ✅ | In: me only (Meet cannot turn on others' cameras). Out: subscription event. |
| `videoOff` | Outgoing User Command | ✅ | In: me only. Out: subscription event. |
| `unMute` | Outgoing User Command | ✅ | In: me only (Meet cannot unmute others). Out: subscription event. |
| `mute` | Outgoing User Command | ✅ | In: me or others (host may need to allow). Out: subscription event. |
| `videoOn` | Incoming User Command | ✅ | In: me only (Meet cannot turn on others' cameras). Out: subscription event. |
| `videoOff` | Incoming User Command | ✅ | In: me only. Out: subscription event. |
| `toggleVideo` | Incoming User Command | ✅ | Me only. |
| `mute` | Incoming User Command | ✅ | In: me or others (host may need to allow). Out: subscription event. |
| `unMute` | Incoming User Command | ✅ | In: me only (Meet cannot unmute others). Out: subscription event. |
| `toggleMute` | Incoming User Command | ✅ | Me only for unmute; others are muted. |

### View

| Message | Type | Supported | Note |
|---|---|---|---|
| `galleryPageNext` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `galleryPagePrev` | Incoming Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `hideSelfView` | Incoming User Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |
| `showSelfView` | Incoming User Command | ⛔ | Google Meet ISO captures feeds independently of the Meet client view. |

### Waiting Rooms and ZAK Join

| Message | Type | Supported | Note |
|---|---|---|---|
| `enableWaitingRoom` | Incoming Command | ⛔ | Meet host controls not automated. |
| `disableWaitingRoom` | Incoming Command | ⛔ | Meet host controls not automated. |
| `admitAll` | Incoming Command | ✅ |  |
| `listWaitingRoomUsers` | Incoming Command | ✅ |  |
| `messageWaitingRoom` | Incoming Command | ⛔ | No lobby chat in Meet. |
| `admit` | Incoming User Command | ✅ | Lobby, by name. |
| `sendToWaitingRoom` | Incoming User Command | ⛔ | Meet cannot send people back to the lobby. |
| `zakJoin` | Incoming Command | ⛔ | Zoom-only. |
| `zakStart` | Incoming Command | ⛔ | Zoom-only. |

### Waiting Rooms and ZAK Join Output

| Message | Type | Supported | Note |
|---|---|---|---|
| `waitingRoomUserList` | Response to incoming message | ✅ | zoomID is 0; persistentID = name. |

### Webinar

| Message | Type | Supported | Note |
|---|---|---|---|
| `getWebinarReactionCounts` | Incoming Command | ⛔ | No webinar roles in Meet. |
| `resetWebinarReactionCounts` | Incoming Command | ⛔ | No webinar roles in Meet. |
| `ejectAttendees` | Incoming Command | ⛔ | No webinar roles in Meet. |

### Webinar - Response

| Message | Type | Supported | Note |
|---|---|---|---|
| `webinarReactionCounts` | Response to incoming message | ⛔ | No webinar roles in Meet. |

### ZoomISO Controls

| Message | Type | Supported | Note |
|---|---|---|---|
| `setOutputEmbeddedAudio` | Incoming Command | ✅ |  |
| `startISOEngine` | Incoming Command | ✅ |  |
| `stopISOEngine` | Incoming Command | ✅ |  |
| `setOutputSelection` | Incoming Command | ✅ |  |
