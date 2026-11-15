// Runs in the Meet page's MAIN world (injected via contextBridge.executeInMainWorld).
// Must be fully self-contained: it is serialized with Function.prototype.toString().
//
// It replaces navigator.mediaDevices.getUserMedia / enumerateDevices so Meet only ever
// sees one virtual camera and one virtual mic:
//   - camera = captureStream() of a hidden <canvas> that the isolated-world preload paints
//     from the chosen source (NDI receiver or local webcam). Switching sources therefore
//     never requires Meet to re-acquire the camera.
//   - mic = a WebAudio destination fed from the chosen local input device; switching
//     devices reconnects the graph live.
// Configuration arrives via data-* attributes on <html> (shared DOM between worlds).

export function installMediaShim(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__gmeetIsoShim) return;
  w.__gmeetIsoShim = true;

  const md = navigator.mediaDevices;
  if (!md) return;
  const origGUM = md.getUserMedia.bind(md);
  const origEnum = md.enumerateDevices.bind(md);
  const CANVAS_ID = '__gmeet_iso_cam';
  const CAM_ID = 'gmeet-iso-camera';
  const MIC_ID = 'gmeet-iso-mic';

  const root = () => document.documentElement;
  const micLabel = () => root()?.dataset.gmeetIsoMic ?? '';

  function getCanvas(): HTMLCanvasElement {
    let c = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
    if (!c) {
      c = document.createElement('canvas');
      c.id = CANVAS_ID;
      c.width = 1280;
      c.height = 720;
      c.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;pointer-events:none';
      (document.documentElement || document).appendChild(c);
    }
    return c;
  }

  let camStream: MediaStream | null = null;
  function camTrack(): MediaStreamTrack {
    if (!camStream || camStream.getVideoTracks()[0]?.readyState !== 'live') {
      camStream = (getCanvas() as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
    }
    const t = camStream.getVideoTracks()[0].clone();
    // Let the isolated world recognise the bot's own tile by track id.
    const ids = (root()?.dataset.gmeetIsoCamTracks ?? '').split(',').filter(Boolean).slice(-20);
    ids.push(t.id);
    root()?.setAttribute('data-gmeet-iso-cam-tracks', ids.join(','));
    // Make the track look like a camera to Meet.
    Object.defineProperty(t, 'label', { value: 'GMeet ISO Camera' });
    const origSettings = t.getSettings.bind(t);
    t.getSettings = () => ({ ...origSettings(), deviceId: CAM_ID, width: 1280, height: 720, frameRate: 30 });
    return t;
  }

  // ----- audio -----
  let ac: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let srcNode: MediaStreamAudioSourceNode | null = null;
  let srcStream: MediaStream | null = null;
  let currentMic = '__unset__';

  async function applyMic(): Promise<void> {
    const want = micLabel();
    if (want === currentMic) return;
    currentMic = want;
    srcNode?.disconnect();
    srcStream?.getTracks().forEach((t) => t.stop());
    srcNode = null;
    srcStream = null;
    if (!want || !ac || !dest) return;
    try {
      const devs = await origEnum();
      const dev = devs.find((d) => d.kind === 'audioinput' && d.label === want) ?? (want === 'default' ? devs.find((d) => d.kind === 'audioinput') : undefined);
      if (!dev) {
        console.warn('[gmeet-iso] mic not found:', want);
        return;
      }
      srcStream = await origGUM({
        audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
      });
      srcNode = ac.createMediaStreamSource(srcStream);
      srcNode.connect(dest);
      root()?.setAttribute('data-gmeet-iso-mic-active', dev.label);
    } catch (e) {
      console.warn('[gmeet-iso] mic open failed', e);
      root()?.setAttribute('data-gmeet-iso-mic-active', `error: ${(e as Error).message}`);
    }
  }

  async function micTrack(): Promise<MediaStreamTrack> {
    if (!ac) {
      ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      dest = ac.createMediaStreamDestination();
    }
    if (ac.state === 'suspended') void ac.resume();
    await applyMic();
    const t = dest!.stream.getAudioTracks()[0].clone();
    Object.defineProperty(t, 'label', { value: 'GMeet ISO Mic' });
    const origSettings = t.getSettings.bind(t);
    t.getSettings = () => ({ ...origSettings(), deviceId: MIC_ID });
    return t;
  }

  // Re-apply when the preload changes the selected mic.
  new MutationObserver(() => {
    if (ac) void applyMic();
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-gmeet-iso-mic'] });

  // Diagnostics: peak level at the raw device and at the track Meet receives.
  w.__gmeetIsoAudioDebug = async () => {
    if (!ac || !dest) return { ac: 'none' };
    const peak = async (stream: MediaStream | null) => {
      if (!stream || !stream.getAudioTracks().length) return null;
      const an = ac!.createAnalyser();
      const s = ac!.createMediaStreamSource(stream);
      s.connect(an);
      await new Promise((r) => setTimeout(r, 800));
      const d = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(d);
      s.disconnect();
      return d.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    };
    return {
      ac: ac.state,
      device: srcStream?.getAudioTracks()[0]?.label ?? null,
      deviceMuted: srcStream?.getAudioTracks()[0]?.muted ?? null,
      devicePeak: await peak(srcStream),
      outPeak: await peak(dest.stream),
    };
  };

  const wants = (c: unknown) => !!c && c !== false;

  md.getUserMedia = async function (constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const out = new MediaStream();
    const c = constraints ?? {};
    if (wants(c.video)) out.addTrack(camTrack());
    if (wants(c.audio)) out.addTrack(await micTrack());
    if (!out.getTracks().length) throw new DOMException('Requested device not found', 'NotFoundError');
    return out;
  };

  md.enumerateDevices = async function (): Promise<MediaDeviceInfo[]> {
    const real = await origEnum();
    const fake = (deviceId: string, kind: MediaDeviceKind, label: string) =>
      ({
        deviceId,
        groupId: 'gmeet-iso',
        kind,
        label,
        toJSON() {
          return { deviceId, groupId: 'gmeet-iso', kind, label };
        },
        getCapabilities: () => ({}),
      }) as unknown as MediaDeviceInfo;
    return [
      fake(CAM_ID, 'videoinput', 'GMeet ISO Camera'),
      fake(MIC_ID, 'audioinput', 'GMeet ISO Mic'),
      ...real.filter((d) => d.kind === 'audiooutput'),
    ];
  };
}
