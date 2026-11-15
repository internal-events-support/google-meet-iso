// GENERATED from the ZoomISO v3 RE catalogue (allOscCommands.csv): GMeet ISO OSC support per command.
// Imported by the Settings Command Browser and by src/main/osc/router.ts. Edit notes here; keep `address` verbatim.

export interface OscSupportEntry {
  /** Catalogue message name (path after /gmeet, /zoom or /zoomosc, minus the target). */
  address: string;
  /** Catalogue type, e.g. "Incoming Command", "Incoming User Command", "Outgoing User Command", "Response to incoming message". */
  type: string;
  category: string;
  title: string;
  syntax: string;
  supported: boolean;
  note: string;
}

export const OSC_SUPPORT: OscSupportEntry[] = [
  {
    "address": "ping",
    "type": "Incoming Command",
    "category": "App Info",
    "title": "Ping ZoomOSC",
    "syntax": "{optional any argument to reply}",
    "supported": true,
    "note": "Replies /pong with ZoomISO fields."
  },
  {
    "address": "pong",
    "type": "Response to incoming message",
    "category": "App Info - Response",
    "title": "Ping Reply (Pong)",
    "syntax": "{any pingArg (zero if none sent)} {str appversion} {int subscribeMode} {int galTrackMode} {int inCallStatus 0 or 1} {int number of targets} {int number of users in call} {int isPro (1=true, 0=false)}",
    "supported": true,
    "note": ""
  },
  {
    "address": "exportAllMessages",
    "type": "Incoming Command",
    "category": "Hidden",
    "title": "Export All Messages",
    "syntax": "",
    "supported": false,
    "note": "Chat history is not captured."
  },
  {
    "address": "oscErrors",
    "type": "Outgoing Command",
    "category": "App Info - Output",
    "title": "Output of OSC errors",
    "syntax": "(str OSC_error}",
    "supported": true,
    "note": "Emitted on parse/exec errors."
  },
  {
    "address": "videoOn",
    "type": "Outgoing User Command",
    "category": "Video/Mic",
    "title": "Request Video On",
    "syntax": ",",
    "supported": true,
    "note": "In: me only (Meet cannot turn on others' cameras). Out: subscription event."
  },
  {
    "address": "videoOff",
    "type": "Outgoing User Command",
    "category": "Video/Mic",
    "title": "Set Video Off",
    "syntax": ",",
    "supported": true,
    "note": "In: me only. Out: subscription event."
  },
  {
    "address": "isSpeaking",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "Is Speaking",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "stoppedSpeaking",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "Stopped Speaking",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "handRaised",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User's Hand Raised",
    "syntax": "{str message},",
    "supported": true,
    "note": ""
  },
  {
    "address": "handLowered",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User's Hand Lowered",
    "syntax": "{str message},",
    "supported": true,
    "note": ""
  },
  {
    "address": "unMute",
    "type": "Outgoing User Command",
    "category": "Video/Mic",
    "title": "Unmute Mic",
    "syntax": ",",
    "supported": true,
    "note": "In: me only (Meet cannot unmute others). Out: subscription event."
  },
  {
    "address": "mute",
    "type": "Outgoing User Command",
    "category": "Video/Mic",
    "title": "Mute Mic",
    "syntax": ",",
    "supported": true,
    "note": "In: me or others (host may need to allow). Out: subscription event."
  },
  {
    "address": "audioStatus",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "Output with the status of a user's audio",
    "syntax": "",
    "supported": false,
    "note": "Not implemented."
  },
  {
    "address": "videoShareStarted",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Started Sharing Video",
    "syntax": ",",
    "supported": false,
    "note": "Screen shares appear as separate feeds; not emitted yet."
  },
  {
    "address": "videoShareStopped",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Stopped Sharing Video",
    "syntax": ",",
    "supported": false,
    "note": "Not emitted yet."
  },
  {
    "address": "audioShareStarted",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Started Sharing Audio",
    "syntax": ",",
    "supported": false,
    "note": "Not in Meet."
  },
  {
    "address": "audioShareStopped",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Stopped Sharing Audio",
    "syntax": ",",
    "supported": false,
    "note": "Not in Meet."
  },
  {
    "address": "emojiChanged",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Emoji Changed",
    "syntax": "{int emojiID}",
    "supported": false,
    "note": "Meet reactions are not captured."
  },
  {
    "address": "userNameChanged",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Rename Event",
    "syntax": "{str oldUserName}",
    "supported": true,
    "note": "Detected by participant id."
  },
  {
    "address": "online",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Online",
    "syntax": ",",
    "supported": true,
    "note": ""
  },
  {
    "address": "offline",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Offline",
    "syntax": ",",
    "supported": true,
    "note": ""
  },
  {
    "address": "chat",
    "type": "Outgoing User Command",
    "category": "Chat",
    "title": "Send Chat",
    "syntax": "{str message} {str message_id} {int message_type}",
    "supported": false,
    "note": "Meet has no private chat; incoming chat is not captured."
  },
  {
    "address": "joinedWaitingRoom",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Joined Waiting Room, User Leaves Waiting Room",
    "syntax": ",",
    "supported": true,
    "note": "Lobby names only (no zoomID)."
  },
  {
    "address": "leftWaitingRoom",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "Left Waiting Room",
    "syntax": ",",
    "supported": true,
    "note": "Lobby names only."
  },
  {
    "address": "spotlightOn",
    "type": "Outgoing User Command",
    "category": "Spotlight - Info",
    "title": "Spotlight On",
    "syntax": "",
    "supported": true,
    "note": "Best effort (Meet DOM)."
  },
  {
    "address": "spotlightOff",
    "type": "Outgoing User Command",
    "category": "Spotlight - Info",
    "title": "Spotlight Off",
    "syntax": "",
    "supported": true,
    "note": "Best effort (Meet DOM)."
  },
  {
    "address": "roleChanged",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "User Role Updates",
    "syntax": "{int role}",
    "supported": true,
    "note": "Host/co-host when Meet exposes it."
  },
  {
    "address": "transcriptMessage",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "Live Transcription Data",
    "syntax": "for SPEAKER {str transcribed_text} {int operation_type} {str enum_language}",
    "supported": false,
    "note": "Meet captions are not captured."
  },
  {
    "address": "list",
    "type": "Outgoing Command",
    "category": "Meeting Info",
    "title": "List Output",
    "syntax": "{int targetCount} {int listCount} {int userRole} {int onlineStatus} {int videoStatus} {int audioStatus} {int handRaised}",
    "supported": true,
    "note": ""
  },
  {
    "address": "list",
    "type": "Incoming Command",
    "category": "Meeting Info",
    "title": "Request list",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "listCleared",
    "type": "Outgoing Command",
    "category": "General - Output",
    "title": "List Cleared indicator",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "galTrackMode",
    "type": "Incoming Command",
    "category": "Gallery Tracking and Data Requests",
    "title": "Gallery Track Mode",
    "syntax": "{int participantID = 0, zoomID = 1}",
    "supported": true,
    "note": ""
  },
  {
    "address": "galleryCount",
    "type": "Incoming Command",
    "category": "Gallery Tracking and Data Response",
    "title": "Response to Gallery Count Request",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "galleryCount",
    "type": "Response to incoming message",
    "category": "Gallery Tracking and Data Response",
    "title": "Response to Gallery Count Request",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "galleryOrder",
    "type": "Outgoing Command",
    "category": "Gallery Tracking and Data Response",
    "title": "Gallery order data output",
    "syntax": "",
    "supported": true,
    "note": "Roster order (Meet has no stable gallery grid)."
  },
  {
    "address": "getGalleryOrder",
    "type": "Incoming Command",
    "category": "Gallery Tracking and Data Requests",
    "title": "Request Order of Gallery View",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "spotOrder",
    "type": "Outgoing Command",
    "category": "Spotlight - Info",
    "title": "Spotlight Order Output",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "getSpotOrder",
    "type": "Incoming Command",
    "category": "Spotlight",
    "title": "Get Spot Order",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "subscribe",
    "type": "Incoming Command",
    "category": "Gallery Tracking and Data Requests - Output",
    "title": "Subscription Level",
    "syntax": "{int mode}",
    "supported": true,
    "note": ""
  },
  {
    "address": "chatAll",
    "type": "Incoming Command",
    "category": "Chat",
    "title": "Send Chat to Everyone",
    "syntax": "{str message}",
    "supported": true,
    "note": "Meet chat to everyone."
  },
  {
    "address": "chatWaitingRoom",
    "type": "Incoming Command",
    "category": "Chat",
    "title": "Chat to participants in the waiting room",
    "syntax": "{str message}",
    "supported": false,
    "note": "No lobby chat in Meet."
  },
  {
    "address": "chatPanelists",
    "type": "Incoming Command",
    "category": "Chat",
    "title": "Chat to all panelists",
    "syntax": "{str message}",
    "supported": false,
    "note": "No webinar roles."
  },
  {
    "address": "chat",
    "type": "Incoming User Command",
    "category": "Chat",
    "title": "Send Chat",
    "syntax": "{str chat message}",
    "supported": false,
    "note": "Meet has no private chat; incoming chat is not captured."
  },
  {
    "address": "chatAttendee",
    "type": "Incoming User Command",
    "category": "Chat",
    "title": "Attendee chat",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles."
  },
  {
    "address": "listBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms - Response",
    "title": "List of Breakout Rooms Output",
    "syntax": "",
    "supported": false,
    "note": "No breakout rooms."
  },
  {
    "address": "listBreakouts",
    "type": "Response to incoming message",
    "category": "Breakout Rooms - Response",
    "title": "List of Breakout Rooms Output",
    "syntax": "{int index} {str bo_name}",
    "supported": false,
    "note": "No breakout rooms."
  },
  {
    "address": "createBreakout",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Create Breakout Room",
    "syntax": "{string breakoutName | int bo_index}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "deleteBreakout",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Delete Breakout Room",
    "syntax": "{string breakoutName | int bo_index}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "deleteAllBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Delete All Breakout Rooms",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "openBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Open Breakout Rooms",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "closeBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Close Breakout Rooms",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "broadcastToBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Broadcast Message to Breakout Rooms",
    "syntax": "{string message}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "joinBreakout",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Join a Breakout",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "leaveBreakout",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Leave a breakout",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "configureBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "Configure Breakout Rooms",
    "syntax": "{int postCloseSeconds} {int allowChooseBreakout (0=false, 1=true)} {int allowReturnAtWill} {int autoMoveParticipants} {int useTimer} {int closeWithTimer} {int breakoutDurationSeconds}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "distributeBreakoutsOfSize",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "spreadToBreakouts",
    "type": "Incoming Command",
    "category": "Breakout Rooms",
    "title": "",
    "syntax": "",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "removeFromBreakout",
    "type": "Incoming User Command",
    "category": "Breakout Room",
    "title": "Remove User from Breakout Room",
    "syntax": "{str breakout name | int breakout index}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "sendToBreakout",
    "type": "Incoming User Command",
    "category": "Breakout Room",
    "title": "Send User to Breakout Room",
    "syntax": "{str breakout name | int breakout index}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "assignToBreakout",
    "type": "Incoming User Command",
    "category": "Breakout Room",
    "title": "Assign User to Breakout Room",
    "syntax": "{str breakout name | int breakout index}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "unassignFromBreakout",
    "type": "Incoming User Command",
    "category": "Breakout Room",
    "title": "Unassign User from Breakout Room",
    "syntax": "{str breakout name | int breakout index}",
    "supported": false,
    "note": "Google Meet breakout rooms have no API/automation."
  },
  {
    "address": "returnToMainMeeting",
    "type": "Incoming User Command",
    "category": "General",
    "title": "Return to main meeting",
    "syntax": "",
    "supported": false,
    "note": "No breakout rooms."
  },
  {
    "address": "enableWaitingRoom",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Enable Waiting Room",
    "syntax": "",
    "supported": false,
    "note": "Meet host controls not automated."
  },
  {
    "address": "disableWaitingRoom",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Disable Waiting Room",
    "syntax": "",
    "supported": false,
    "note": "Meet host controls not automated."
  },
  {
    "address": "admitAll",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Admit All from Waiting Room",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "listWaitingRoomUsers",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Request Waiting Room User List",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "waitingRoomUserList",
    "type": "Response to incoming message",
    "category": "Waiting Rooms and ZAK Join Output",
    "title": "Waiting Room User List",
    "syntax": "{int index} {int count} {int zoomID} {str userName} {str persistentID}",
    "supported": true,
    "note": "zoomID is 0; persistentID = name."
  },
  {
    "address": "messageWaitingRoom",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Message Waiting Room",
    "syntax": "{str message}",
    "supported": false,
    "note": "No lobby chat in Meet."
  },
  {
    "address": "admit",
    "type": "Incoming User Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Admit User from Waiting Room",
    "syntax": "",
    "supported": true,
    "note": "Lobby, by name."
  },
  {
    "address": "sendToWaitingRoom",
    "type": "Incoming User Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "Send User to Waiting Room",
    "syntax": "",
    "supported": false,
    "note": "Meet cannot send people back to the lobby."
  },
  {
    "address": "startLocalRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Start Local Recording",
    "syntax": "",
    "supported": true,
    "note": "Starts ISO recording of the selected outputs."
  },
  {
    "address": "pauseLocalRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Pause Local Recording",
    "syntax": "",
    "supported": false,
    "note": "The ISO recorder has no pause/resume."
  },
  {
    "address": "resumeLocalRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Resume Local Recording",
    "syntax": "",
    "supported": false,
    "note": "The ISO recorder has no pause/resume."
  },
  {
    "address": "stopLocalRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Stop Local Recording",
    "syntax": "",
    "supported": true,
    "note": "Stops ISO recording."
  },
  {
    "address": "requestCapturePermission",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Request Capture Permission",
    "syntax": "",
    "supported": false,
    "note": "macOS-only."
  },
  {
    "address": "startCloudRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Start Cloud Recording",
    "syntax": "",
    "supported": false,
    "note": "Meet cloud recording is not automated."
  },
  {
    "address": "pauseCloudRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Pause Cloud Recording",
    "syntax": "",
    "supported": false,
    "note": "Meet cloud recording is not automated."
  },
  {
    "address": "resumeCloudRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Resume Cloud Recording",
    "syntax": "",
    "supported": false,
    "note": "Meet cloud recording is not automated."
  },
  {
    "address": "stopCloudRecording",
    "type": "Incoming Command",
    "category": "Recording",
    "title": "Stop Cloud Recording",
    "syntax": "",
    "supported": false,
    "note": "Meet cloud recording is not automated."
  },
  {
    "address": "allowToRecord",
    "type": "Incoming User Command",
    "category": "Recording",
    "title": "Allow to Record",
    "syntax": "",
    "supported": false,
    "note": "Meet cloud recording is not automated."
  },
  {
    "address": "disallowToRecord",
    "type": "Incoming User Command",
    "category": "Recording",
    "title": "Disallow to Record",
    "syntax": "",
    "supported": false,
    "note": "Meet cloud recording is not automated."
  },
  {
    "address": "getWebinarReactionCounts",
    "type": "Incoming Command",
    "category": "Webinar",
    "title": "Get Webinar Reaction Count",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles in Meet."
  },
  {
    "address": "webinarReactionCounts",
    "type": "Response to incoming message",
    "category": "Webinar - Response",
    "title": "Webinar Emoji Reaction Count",
    "syntax": "{int clapping} {int thumbsup} {int heart} {int joy} {int openmouth} {int tada}",
    "supported": false,
    "note": "No webinar roles in Meet."
  },
  {
    "address": "resetWebinarReactionCounts",
    "type": "Incoming Command",
    "category": "Webinar",
    "title": "Reset Webinar Reaction Counters",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles in Meet."
  },
  {
    "address": "answerQuestionLive",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Mark Question as Answering Live",
    "syntax": "{string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "answerQuestionDone",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Finish Answering Question",
    "syntax": "{string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "answerQuestionText",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Answer Question with Text",
    "syntax": "{string answer} {string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "dismissQuestion",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Dismiss Question",
    "syntax": "{string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "deleteQuestion",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Delete Question",
    "syntax": "{string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "reopenQuestion",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Reopen Question",
    "syntax": "{string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "getQuestionList",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Get Question List",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionList",
    "type": "Response to incoming message",
    "category": "Question Info Response",
    "title": "Lists the Questions-Response",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "getQuestionInfo",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Get Question Info",
    "syntax": "{string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionInfo",
    "type": "Response to incoming message",
    "category": "Meeting and Webinar Q&A - Response",
    "title": "Question Information",
    "syntax": "{str q_id} {str sender_name} {str q_content} {int isSenderMyself (1=true",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "getAnswerList",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Get Answer List",
    "syntax": "{(optional) string question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "answerList",
    "type": "Response to incoming message",
    "category": "Question Info Response",
    "title": "Lists the answers-response",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "getAnswerInfo",
    "type": "Incoming Command",
    "category": "Meeting and Webinar Q&A",
    "title": "Get Answer Info",
    "syntax": "{string answer_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "answerInfo",
    "type": "Response to incoming message",
    "category": "Question Info Response",
    "title": "Answer Information",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionAnsweredLive",
    "type": "Outgoing User Command",
    "category": "Meeting and Webinar Q&A User Output",
    "title": "Question Answered Live",
    "syntax": "for ASKER {str question} {int votes} {str question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionAnsweredDone",
    "type": "Outgoing User Command",
    "category": "Meeting and Webinar Q&A User Output",
    "title": "Completed Live Answer to Question",
    "syntax": "for ASKER {str question} {int votes} {str question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionDismissed",
    "type": "Outgoing User Command",
    "category": "Meeting and Webinar Q&A User Output",
    "title": "Question Dismissed",
    "syntax": "for ASKER {str question} {int votes} {str question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionDone",
    "type": "Outgoing User Command",
    "category": "Question Info Response",
    "title": "Question Done",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "answeredQuestionText",
    "type": "Outgoing User Command",
    "category": "Question Info Response",
    "title": "Answered Questions-output",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "questionReopened",
    "type": "Outgoing User Command",
    "category": "Question Info Response",
    "title": "Question Reopened",
    "syntax": "for ASKER {str question} {int votes} {str question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "askedQuestion",
    "type": "Outgoing User Command",
    "category": "Question Info Response",
    "title": "Webinar Question Asked",
    "syntax": "for ASKER {str question} {str question_id}",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "deletedQuestion",
    "type": "Outgoing Command",
    "category": "Question Info Response",
    "title": "Deleted Question",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "deletedAnswer",
    "type": "Outgoing Command",
    "category": "Question Info Response",
    "title": "Deleted Answer",
    "syntax": "",
    "supported": false,
    "note": "Meet Q&A is not automatable."
  },
  {
    "address": "makeSignInterpreter",
    "type": "Incoming User Command",
    "category": "Interpretation",
    "title": "Make sign interpreter",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "removeSignInterpreter",
    "type": "Incoming User Command",
    "category": "Interpretation",
    "title": "Remove Sign interpreter",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "startSignInterpretation",
    "type": "Incoming Command",
    "category": "Interpretation",
    "title": "Start Sign Interpretation",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "stopSignInterpretation",
    "type": "Incoming Command",
    "category": "Interpretation",
    "title": "Stop Sign Interpretation",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "signInterpreterList",
    "type": "Outgoing Command",
    "category": "Interpretation Info Output",
    "title": "Get Sign Interpretation Status",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "getSignInterpretationList",
    "type": "Incoming Command",
    "category": "Interpretation",
    "title": "Get Sign Interpretation List",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "signLanguageList",
    "type": "Outgoing Command",
    "category": "Interpretation Info Output",
    "title": "Sign Language List",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "getAllSignLanguageList",
    "type": "Incoming Command",
    "category": "Interpretation",
    "title": "Get Sign Language List",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "signInterpretationStatus",
    "type": "Outgoing Command",
    "category": "Interpretation Info Output",
    "title": "Sign interpretation Status",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "getSignIterpretationStatus",
    "type": "Incoming Command",
    "category": "Interpretation",
    "title": "Get Sign Interpretation Status",
    "syntax": "",
    "supported": false,
    "note": "No interpretation in Meet."
  },
  {
    "address": "startPoll",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Start Poll",
    "syntax": "{string poll_ID}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "relaunchPoll",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Relaunch Poll",
    "syntax": "{string poll_ID}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "stopPoll",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Stop Poll",
    "syntax": "{string poll_ID}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "getPollList",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Get List of Polls",
    "syntax": "",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "polls",
    "type": "Response to incoming message",
    "category": "Polls Outputs",
    "title": "List of Polls",
    "syntax": "{int list_index} {int list_size} {str poll_id} {str poll_name} {int pollStatus} {int pollType} {int isPollLibrary} {int numQuestions}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "getPollInfo",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Get Poll Info",
    "syntax": "{string poll_ID}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "pollInfo",
    "type": "Response to incoming message",
    "category": "Polls Outputs",
    "title": "Poll Metadata Info",
    "syntax": "{str poll_id} {str poll_name} {int pollStatus} {int pollType} {int isPollLibrary} {int numQuestions}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "getPollQuestions",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Get Poll Questions",
    "syntax": "{string poll_ID}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "pollQuestions",
    "type": "Response to incoming message",
    "category": "Polls Outputs",
    "title": "List of Poll Question Info",
    "syntax": "{int list_index} {int list_size} {str poll_id} {str poll_question_id} {str poll_question_name} {int question_type}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "getPollAnswers",
    "type": "Incoming Command",
    "category": "Polls",
    "title": "Get Poll Answers",
    "syntax": "{string poll_ID}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "pollAnswers",
    "type": "Response to incoming message",
    "category": "Polls Outputs",
    "title": "List of Poll Answers",
    "syntax": "{int list_index} {int list_size} {str poll_id} {str poll_question_id} {str poll_sub_question_id} {str poll_answer_id} {str poll_answer_name} {int numChosen}",
    "supported": false,
    "note": "Meet polls are not automatable."
  },
  {
    "address": "startScreenshare",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Start Screenshare",
    "syntax": "{int screenID | str screenName}",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "startScreensharePrimary",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Start Window Share Primary",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "startWindowShare",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Start Window Share",
    "syntax": "{int windowID | str windowName}",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "stopShare",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Stop share",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "startAudioShare",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Start Audio Share",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "startCameraShare",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Start Camera share",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "shareNextCamera",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Share Next Camera",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "listWindows",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "List Windows",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "listScreens",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "List Screens",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "enableComputerSoundWhenSharing",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Enable Computer Sound When Sharing",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "disableComputerSoundWhenSharing",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Disable Computer Sound When Sharing",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "enableOptimizeVideo",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Enable Optimize Video",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "disableOptimizeVideo",
    "type": "Incoming Command",
    "category": "Screen Share",
    "title": "Disable Optimize Video",
    "syntax": "",
    "supported": false,
    "note": "The bot does not screen share."
  },
  {
    "address": "listMicDevices",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "List Microphone Devices",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "micDevices",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Microphone List Response",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "setMicDevice",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set the Microphone Device",
    "syntax": "{string deviceID | int index}",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "getMicDevice",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get Microphone Device",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "micDevice",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Microphone Device Response",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "setMicVolume",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set Microphone Volume",
    "syntax": "{int 0> 100}",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "getMicVolume",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get Microphone Volume",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "listSpeakerDevices",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "List Speaker Devices",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "speakerDevices",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Speaker Devices List Response",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "setSpeakerDevice",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set Speaker Device",
    "syntax": "{string deviceID | int index}",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "setSpeakerVolume",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set Speaker Volume",
    "syntax": "{int 0> 100}",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "getSpeakerVolume",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get Speaker Volume",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "getSpeakerDevice",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get Speaker Device",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "listCameraDevices",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "List Camera Devices",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "cameraDevices",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Camera Device List Response",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "setCameraDevice",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set Camera Device",
    "syntax": "{string deviceID | int index}",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "getCameraDevice",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get Camera Device",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "listBackgrounds",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "List Backgrounds",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "backgrounds",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Backgrounds List Response",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "setBackground",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set Background",
    "syntax": "{int index | str bgName}",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "getBackground",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Disable HD Video",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "selectedBackground",
    "type": "Response to incoming message",
    "category": "Settings",
    "title": "Selected Background Response",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "listFilters",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get a List of Filters",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "filters",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Filter List Response",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "setFilter",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Set Filter",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "getFilter",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Get Selected Filter",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "selectedFilter",
    "type": "Response to incoming message",
    "category": "Settings Response",
    "title": "Selected Filter Response",
    "syntax": "",
    "supported": false,
    "note": "Meet backgrounds/filters are not automated."
  },
  {
    "address": "enableUsernameLabels",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Enable Username Labels",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "disableUsernameLabels",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Disable Username Labels",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "enableOriginalSound",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Enable Original Sound",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "disableOriginalSound",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Disable Original Sound",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "enableMirrorVideo",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Enable Mirror Video",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "disableMirrorVideo",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Disable Mirror Video",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "enableHDVideo",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Enable HD Video",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "disableHDVideo",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Disable HD Video",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "joinMeeting",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Join a Meeting",
    "syntax": "{str meetingID} {str meetingPass} {str userName}",
    "supported": true,
    "note": "meetingID = Meet code or URL; password/name ignored."
  },
  {
    "address": "jmakjoin",
    "type": "Incoming Command",
    "category": "Hidden",
    "title": "JMAKJOIN",
    "syntax": "",
    "supported": false,
    "note": "Zoom-only."
  },
  {
    "address": "zakJoin",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "ZAK Join Meeting",
    "syntax": "{str zak} {str meetingID} {str name} [optional] {str password}",
    "supported": false,
    "note": "Zoom-only."
  },
  {
    "address": "startMeeting",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Start a Meeting",
    "syntax": "{str meetingID} {str meetingPass} {str userName}",
    "supported": true,
    "note": "Joins meet.google.com/new (or the given code)."
  },
  {
    "address": "zakStart",
    "type": "Incoming Command",
    "category": "Waiting Rooms and ZAK Join",
    "title": "ZAK Start Meeting",
    "syntax": "{str zak} {str meetingID} {str name} [optional] {str password}",
    "supported": false,
    "note": "Zoom-only."
  },
  {
    "address": "setOutputCount",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Output Count",
    "syntax": "{int count (1 through 16)}",
    "supported": true,
    "note": ""
  },
  {
    "address": "outputISO",
    "type": "Incoming User Command",
    "category": "User controls",
    "title": "Output ISO",
    "syntax": "{int outputID}",
    "supported": true,
    "note": ""
  },
  {
    "address": "enableOutput",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Enable Output",
    "syntax": "{int output_index OR string output_name}",
    "supported": true,
    "note": ""
  },
  {
    "address": "disableOutput",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Disable Output",
    "syntax": "{int output_index OR string output_name}",
    "supported": true,
    "note": ""
  },
  {
    "address": "setOutputMode",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Output Mode",
    "syntax": "{int output_index OR string output_name} {int mode_index OR string mode_name}",
    "supported": true,
    "note": "Spotlight/Unique Speaker map to the closest Meet mode."
  },
  {
    "address": "setOutputEmbeddedAudio",
    "type": "Incoming Command",
    "category": "ZoomISO Controls",
    "title": "Set Output Embedded Audio",
    "syntax": "{int output_index OR string output_name} {int audio_mode_index OR string audio_mode_name}",
    "supported": true,
    "note": ""
  },
  {
    "address": "setOutputName",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Output Name",
    "syntax": "{int output_index OR string output_name} {string new_output_name}",
    "supported": true,
    "note": ""
  },
  {
    "address": "startISOEngine",
    "type": "Incoming Command",
    "category": "ZoomISO Controls",
    "title": "Start Capture Engine",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "stopISOEngine",
    "type": "Incoming Command",
    "category": "ZoomISO Controls",
    "title": "Stop Capture Engine",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "getOutputRouting",
    "type": "Incoming Command",
    "category": "Data Accessors",
    "title": "Get Output Routing",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "outputRouting",
    "type": "Response to incoming message",
    "category": "Return Information and Callbacks",
    "title": "Output Routing",
    "syntax": "{int num_outputs} {int this_output_num} {int enabled} {string output_name} {string mode} {int selection} {string resolution} {string embedded_audio_info} {string status}",
    "supported": true,
    "note": ""
  },
  {
    "address": "addOutput",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Add Output",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "deleteOutput",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Delete Output",
    "syntax": "{int output_index OR string output_name}",
    "supported": true,
    "note": ""
  },
  {
    "address": "setOutputSelection",
    "type": "Incoming Command",
    "category": "ZoomISO Controls",
    "title": "Set Output Selection",
    "syntax": "{int output_index OR string output_name} {int selection_index OR string selection_name}",
    "supported": true,
    "note": ""
  },
  {
    "address": "setVideoLossMode",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Video Loss Mode",
    "syntax": "{int loss_mode_index OR string loss_mode_name}",
    "supported": true,
    "note": "Image/Freeze/etc. Color Bars = testcard."
  },
  {
    "address": "engineState",
    "type": "Outgoing Command",
    "category": "Return Information and Callbacks - Output",
    "title": "Engine State",
    "syntax": "{int 0 (disabled) OR 1 (standing by) OR 2 (enabled)}",
    "supported": true,
    "note": ""
  },
  {
    "address": "getEngineState",
    "type": "Incoming Command",
    "category": "Data Accessors",
    "title": "Get Engine State",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "audioISO",
    "type": "Incoming User Command",
    "category": "ISO Routing",
    "title": "Audio ISO",
    "syntax": "{int channelID}",
    "supported": false,
    "note": "Audio channel routing is configured in Audio Outputs, not via OSC yet."
  },
  {
    "address": "getAudioLevels",
    "type": "Incoming Command",
    "category": "Data Accessors",
    "title": "Get Audio Levels",
    "syntax": "",
    "supported": true,
    "note": "Per participant (Meet attributes the 3 loudest)."
  },
  {
    "address": "audioLevels",
    "type": "Response to incoming message",
    "category": "Return Information and Callbacks",
    "title": "Audio Levels",
    "syntax": "{int channel_index} {int level (0 to 255)}",
    "supported": true,
    "note": ""
  },
  {
    "address": "getAudioRouting",
    "type": "Incoming Command",
    "category": "Data Accessors",
    "title": "Get Audio Routing",
    "syntax": "",
    "supported": false,
    "note": "Not implemented yet."
  },
  {
    "address": "audioRouting",
    "type": "Response to incoming message",
    "category": "Return Information and Callbacks",
    "title": "Audio Routing",
    "syntax": "{string audio_device_name} {int num_channels} {int this_channel} {string mode} {int gain_reduction} {string selection} {int audio_level}",
    "supported": false,
    "note": "Not implemented yet."
  },
  {
    "address": "setAudioMode",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Audio Mode",
    "syntax": "{int output_index OR string output_name}",
    "supported": false,
    "note": "Not implemented yet."
  },
  {
    "address": "setAudioGainReduction",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Audio Gain Reduction",
    "syntax": "",
    "supported": false,
    "note": "No talkback/ducking."
  },
  {
    "address": "setAudioChannelLanguage",
    "type": "Incoming Command",
    "category": "Output Settings Controls",
    "title": "Set Channel Language",
    "syntax": "",
    "supported": false,
    "note": "No interpretation."
  },
  {
    "address": "meetingStatusChanged",
    "type": "Outgoing Command",
    "category": "Outputs",
    "title": "Meeting Status Changed",
    "syntax": "{int status_code} {int error_code} {int exit_code}",
    "supported": true,
    "note": ""
  },
  {
    "address": "activeSpeaker",
    "type": "Outgoing User Command",
    "category": "User Info",
    "title": "Active Speaker",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "pin",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Pin Participant",
    "syntax": "",
    "supported": true,
    "note": "Meet pin (best effort)."
  },
  {
    "address": "unPin",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Unpin Participant",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "addPin",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Add Pin",
    "syntax": "",
    "supported": true,
    "note": "Meet allows one pin; replaces."
  },
  {
    "address": "togglePin",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Toggle Pin First Screen",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "clearPin",
    "type": "Incoming Command",
    "category": "Pin",
    "title": "Clear all Pins",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "pin2",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Pin to Second Screen",
    "syntax": "",
    "supported": false,
    "note": "No second-screen pin in Meet."
  },
  {
    "address": "unPin2",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Unpin from the Second Screen",
    "syntax": "",
    "supported": false,
    "note": "No second-screen pin."
  },
  {
    "address": "clearPin2",
    "type": "Incoming Command",
    "category": "Pin",
    "title": "Clear the Pin from the Second Screen",
    "syntax": "",
    "supported": false,
    "note": "No second-screen pin."
  },
  {
    "address": "togglePin2",
    "type": "Incoming User Command",
    "category": "Pin",
    "title": "Toggle Pin Second Screen",
    "syntax": "",
    "supported": false,
    "note": "No second-screen pin."
  },
  {
    "address": "spot",
    "type": "Incoming User Command",
    "category": "Spotlight",
    "title": "Spotlight",
    "syntax": "",
    "supported": true,
    "note": "Meet spotlight (host)."
  },
  {
    "address": "unSpot",
    "type": "Incoming User Command",
    "category": "Spotlight",
    "title": "Unspotlight",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "addSpot",
    "type": "Incoming User Command",
    "category": "Spotlight",
    "title": "Add Spotlight",
    "syntax": "",
    "supported": true,
    "note": "Meet has one spotlight; replaces."
  },
  {
    "address": "toggleSpot",
    "type": "Incoming User Command",
    "category": "Spotlight",
    "title": "Toggle Spotlight",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "videoOn",
    "type": "Incoming User Command",
    "category": "Video/Mic",
    "title": "Request Video On",
    "syntax": "",
    "supported": true,
    "note": "In: me only (Meet cannot turn on others' cameras). Out: subscription event."
  },
  {
    "address": "videoOff",
    "type": "Incoming User Command",
    "category": "Video/Mic",
    "title": "Set Video Off",
    "syntax": "",
    "supported": true,
    "note": "In: me only. Out: subscription event."
  },
  {
    "address": "toggleVideo",
    "type": "Incoming User Command",
    "category": "Video/Mic",
    "title": "Toggle Video",
    "syntax": "",
    "supported": true,
    "note": "Me only."
  },
  {
    "address": "mute",
    "type": "Incoming User Command",
    "category": "Video/Mic",
    "title": "Mute Mic",
    "syntax": "",
    "supported": true,
    "note": "In: me or others (host may need to allow). Out: subscription event."
  },
  {
    "address": "unMute",
    "type": "Incoming User Command",
    "category": "Video/Mic",
    "title": "Unmute Mic",
    "syntax": "",
    "supported": true,
    "note": "In: me only (Meet cannot unmute others). Out: subscription event."
  },
  {
    "address": "toggleMute",
    "type": "Incoming User Command",
    "category": "Video/Mic",
    "title": "Toggle Mic",
    "syntax": "",
    "supported": true,
    "note": "Me only for unmute; others are muted."
  },
  {
    "address": "raiseHand",
    "type": "Incoming User Command",
    "category": "Hand Raising",
    "title": "Raise Hand",
    "syntax": "",
    "supported": true,
    "note": "Me only."
  },
  {
    "address": "lowerHand",
    "type": "Incoming User Command",
    "category": "Hand Raising",
    "title": "Lower Hand",
    "syntax": "",
    "supported": true,
    "note": "Me or others (host)."
  },
  {
    "address": "toggleHand",
    "type": "Incoming User Command",
    "category": "Hand Raising",
    "title": "Toggle Hand",
    "syntax": "",
    "supported": true,
    "note": "Me only."
  },
  {
    "address": "rename",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Rename",
    "syntax": "",
    "supported": false,
    "note": "Meet cannot rename others."
  },
  {
    "address": "makeHost",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Make Host",
    "syntax": "",
    "supported": false,
    "note": "Meet host transfer is not automatable."
  },
  {
    "address": "makeCoHost",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Make Co-Host",
    "syntax": "",
    "supported": false,
    "note": "Co-host management is not automatable."
  },
  {
    "address": "makeAttendee",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Make Attendee",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles."
  },
  {
    "address": "makePanelist",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Make Panelist",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles."
  },
  {
    "address": "revokeCoHost",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Revoke Co-Host",
    "syntax": "",
    "supported": false,
    "note": "Co-host management is not automatable."
  },
  {
    "address": "reclaimHost",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Reclaim Host",
    "syntax": "",
    "supported": false,
    "note": "Not in Meet."
  },
  {
    "address": "eject",
    "type": "Incoming User Command",
    "category": "User Roles and Action",
    "title": "Eject from Meeting",
    "syntax": "",
    "supported": true,
    "note": "Remove from call (host)."
  },
  {
    "address": "setGalleryView",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Set Gallery View",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "setSpeakerView",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Set Speaker View",
    "syntax": "",
    "supported": false,
    "note": "Bot devices are chosen in Settings, not via OSC."
  },
  {
    "address": "showNonVideoParticipants",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Show Non-Video Participants",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "hideNonVideoParticipants",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Hide Non-Video Participants",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "showUserNames",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Display Usernames on Videos",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "hideUserNames",
    "type": "Incoming Command",
    "category": "Settings",
    "title": "Hide Usernames on Videos",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "galleryPageNext",
    "type": "Incoming Command",
    "category": "View",
    "title": "Next Gallery Page",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "galleryPagePrev",
    "type": "Incoming Command",
    "category": "View",
    "title": "Previous Gallery Page",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "hideSelfView",
    "type": "Incoming User Command",
    "category": "View",
    "title": "Hide Self View",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "showSelfView",
    "type": "Incoming User Command",
    "category": "View",
    "title": "Show Self View",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "stopIncomingAudio",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Stop Incoming Audio",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "startIncomingAudio",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Start Incoming Audio",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "stopIncomingVideo",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Stop Incoming Video",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "startIncomingVideo",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Start Incoming Video",
    "syntax": "",
    "supported": false,
    "note": "GMeet ISO captures feeds independently of the Meet client view."
  },
  {
    "address": "allowToSpeak",
    "type": "Incoming User Command",
    "category": "User controls",
    "title": "Allow Attendee to Speak",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles."
  },
  {
    "address": "disallowToSpeak",
    "type": "Incoming User Command",
    "category": "User controls",
    "title": "Disallow Attendee to Speak",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles."
  },
  {
    "address": "clearSpot",
    "type": "Incoming Command",
    "category": "Spotlight",
    "title": "Clear Spotlight",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "enableUsersUnmute",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Enable Users Unmuting",
    "syntax": "",
    "supported": false,
    "note": "Not automated."
  },
  {
    "address": "disableUsersUnmute",
    "type": "Incoming Command",
    "category": "User controls",
    "title": "Disable User Unmuting",
    "syntax": "",
    "supported": false,
    "note": "Not automated."
  },
  {
    "address": "leaveMeeting",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Leave Meeting",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "endMeeting",
    "type": "Incoming Command",
    "category": "Global",
    "title": "End Meeting",
    "syntax": "",
    "supported": false,
    "note": "Ending for all is not automated (use leaveMeeting)."
  },
  {
    "address": "all/mute",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Mute All",
    "syntax": "",
    "supported": true,
    "note": "Mute everyone (host)."
  },
  {
    "address": "all/unMute",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Unmute All",
    "syntax": "",
    "supported": false,
    "note": "Meet cannot unmute others."
  },
  {
    "address": "lowerAllHands",
    "type": "Incoming Command",
    "category": "Hand Raising",
    "title": "Lower All Raised Hands",
    "syntax": "",
    "supported": true,
    "note": ""
  },
  {
    "address": "ejectAttendees",
    "type": "Incoming Command",
    "category": "Webinar",
    "title": "Eject All Webinar Attendees",
    "syntax": "",
    "supported": false,
    "note": "No webinar roles in Meet."
  },
  {
    "address": "enableTranscription",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Enable Meeting Transcription",
    "syntax": "",
    "supported": false,
    "note": "Not automated."
  },
  {
    "address": "disableTranscription",
    "type": "Incoming Command",
    "category": "Global",
    "title": "Disable Meeting Transcription",
    "syntax": "",
    "supported": false,
    "note": "Not automated."
  },
  {
    "address": "enableTalkback",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Enables Talkback",
    "syntax": "",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "disableTalkback",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Disable Talkback",
    "syntax": "",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "getTalkbackStatus",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Request Talkback Enablement Status",
    "syntax": "",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "talkbackStatus",
    "type": "Response to incoming message",
    "category": "Talkback",
    "title": "Talkback Enablement Status",
    "syntax": "{int status}",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "latchTalkbackChannel",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Latch Talkback Channel",
    "syntax": "{int channelIndex}",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "unLatchTalkbackChannel",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Un-Latch Talkback Channel",
    "syntax": "{int channelIndex}",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "getLatchTalkbackStatus",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Request All Talkback Channel Latch Status",
    "syntax": "",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "latchTalkbackStatus",
    "type": "Response to incoming message",
    "category": "Talkback",
    "title": "All Talkback Channels Latch Status",
    "syntax": "array of 0 (unlatched) or 1 (latched) corresponding to each talkback channel",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "setTalkbackChannelDucking",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Set Talkback Channel Ducking",
    "syntax": "{int channelIndex} {int level (0-100)}",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "getTalkbackChannelDucking",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Request All Talkback Channel Ducking",
    "syntax": "",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "talkbackChannelDucking",
    "type": "Response to incoming message",
    "category": "Talkback",
    "title": "All Talkback Channels Ducking",
    "syntax": "array of ints 0-100 corresponding to each talkback channel",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "getTalkbackChannelStatus",
    "type": "Incoming Command",
    "category": "Talkback",
    "title": "Request Talkback Channel Status",
    "syntax": "",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  },
  {
    "address": "talkbackChannelStatus",
    "type": "Response to incoming message",
    "category": "Talkback",
    "title": "Talkback Channel Status",
    "syntax": "{int channelIndex} {int numChannels} {int isRouted} {int isLatched} {int isDuckingNow} {int duckingLevel 0-100} {int hasParticipant} {str pID} {str userName} {int galleryIndex} {int zoomID}",
    "supported": false,
    "note": "Talkback is not available in GMeet ISO."
  }
];

/** address (lower-case) → supported, true if any catalogue row with that address is supported. */
export const OSC_SUPPORTED: Record<string, boolean> = Object.fromEntries(
  [...new Set(OSC_SUPPORT.map((e) => e.address.toLowerCase()))].map((a) => [a, OSC_SUPPORT.some((e) => e.address.toLowerCase() === a && e.supported)]),
);

export function oscSupportFor(address: string): OscSupportEntry | undefined {
  const a = address.toLowerCase().replace(/^\/(gmeetiso|gmeetosc|gmeet|zoomosc|zoom)\//, '');
  return OSC_SUPPORT.find((e) => e.address.toLowerCase() === a);
}
