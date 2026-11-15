import { contextBridge, ipcRenderer } from 'electron';
import type { ControlApi, MeetState, Settings } from '../shared/types';

// Channel names duplicated here: sandboxed preloads can't require local modules.
const api: ControlApi = {
  getSettings: () => ipcRenderer.invoke('ctl:getSettings'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('ctl:setSettings', patch),
  join: (url: string) => ipcRenderer.invoke('ctl:join', url),
  leave: () => ipcRenderer.invoke('ctl:leave'),
  signIn: () => ipcRenderer.invoke('ctl:signIn'),
  showMeetWindow: () => ipcRenderer.invoke('ctl:showMeet'),
  setFeedEnabled: (key: string, enabled: boolean) => ipcRenderer.invoke('ctl:setFeedEnabled', key, enabled),
  dumpDom: () => ipcRenderer.invoke('ctl:dumpDom'),
  onState: (cb: (s: MeetState) => void) => {
    ipcRenderer.on('ctl:state', (_e, s: MeetState) => cb(s));
  },
  onLog: (cb: (l: string) => void) => {
    ipcRenderer.on('ctl:log', (_e, l: string) => cb(l));
  },
};

contextBridge.exposeInMainWorld('gmeetIso', api);
