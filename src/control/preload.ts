import { contextBridge, ipcRenderer } from 'electron';
import type { ControlApi, DeviceLists, MeetState, Settings } from '../shared/types';

// Channel names duplicated here: sandboxed preloads can't require local modules.
const api: ControlApi = {
  getSettings: () => ipcRenderer.invoke('ctl:getSettings'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('ctl:setSettings', patch),
  join: (url: string) => ipcRenderer.invoke('ctl:join', url),
  leave: () => ipcRenderer.invoke('ctl:leave'),
  signIn: () => ipcRenderer.invoke('ctl:signIn'),
  setFeedEnabled: (key: string, enabled: boolean) => ipcRenderer.invoke('ctl:setFeedEnabled', key, enabled),
  setMeetCamera: (on: boolean) => ipcRenderer.invoke('ctl:setMeetCamera', on),
  setMeetMic: (on: boolean) => ipcRenderer.invoke('ctl:setMeetMic', on),
  ndiSources: () => ipcRenderer.invoke('ctl:ndiSources'),
  devices: () => ipcRenderer.invoke('ctl:devices'),
  dumpDom: () => ipcRenderer.invoke('ctl:dumpDom'),
  onState: (cb: (s: MeetState) => void) => {
    ipcRenderer.on('ctl:state', (_e, s: MeetState) => cb(s));
  },
  onLog: (cb: (l: string) => void) => {
    ipcRenderer.on('ctl:log', (_e, l: string) => cb(l));
  },
  onPreview: (cb: (key: string, jpeg: ArrayBuffer) => void) => {
    ipcRenderer.on('ctl:preview', (_e, key: string, jpeg: Uint8Array) => cb(key, jpeg as unknown as ArrayBuffer));
  },
  onDevices: (cb: (d: DeviceLists) => void) => {
    ipcRenderer.on('ctl:devicesChanged', (_e, d: DeviceLists) => cb(d));
  },
};

contextBridge.exposeInMainWorld('gmeetIso', api);
