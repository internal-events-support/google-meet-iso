// First run after the rename from GMeet ISO: copy the old settings and Google sign-in into the new userData folder.
// The old folder is left as it was. No Electron imports, so scripts/test-carryover.js can run it on temp folders.

import * as fs from 'fs';
import * as path from 'path';

/** Old userData folder names under %APPDATA%, newest first. */
const OLD_NAMES = ['GMeet ISO', 'gmeet-iso'];
/** Rebuilt by Chromium, or only valid while the old app runs. */
const SKIP = new Set([
  'lockfile',
  'blob_storage',
  'Cache',
  'Code Cache',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GPUPersistentCache',
  'GrShaderCache',
  'ShaderCache',
]);

export class OldAppRunning extends Error {}

/** Chromium holds `lockfile` open (no write sharing) for as long as the app runs. */
function inUse(dir: string): boolean {
  try {
    fs.closeSync(fs.openSync(path.join(dir, 'lockfile'), 'r+'));
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Must run before anything opens the profile. Returns the folder copied from, or null if there was nothing to do.
 * `.copying` becomes `.copied` once complete, so an interrupted run either starts the copy again or finishes it.
 */
export function carryOver(appData: string, userData: string, oldRecordDir: string): string | null {
  const copying = path.join(userData, '.copying');
  const copied = path.join(userData, '.copied');
  let from: string | null = null;

  if (!fs.existsSync(copied)) {
    if (['settings.json', 'Local State'].some((f) => fs.existsSync(path.join(userData, f)))) return null;
    const old = OLD_NAMES.map((n) => path.join(appData, n)).find(
      (d) => path.resolve(d) !== path.resolve(userData) && ['settings.json', 'Local State'].some((f) => fs.existsSync(path.join(d, f))),
    );
    if (!old) return null;
    if (inUse(old)) throw new OldAppRunning(old);
    from = old;
    fs.rmSync(copying, { recursive: true, force: true });
    fs.cpSync(old, copying, { recursive: true, preserveTimestamps: true, filter: (src) => src === old || !SKIP.has(path.basename(src)) });
    keepRecordDir(path.join(copying, 'settings.json'), oldRecordDir);
    fs.renameSync(copying, copied);
  }

  for (const name of fs.readdirSync(copied)) {
    const to = path.join(userData, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(path.join(copied, name), to);
  }
  fs.rmSync(copied, { recursive: true, force: true });
  return from;
}

/** Setups on the old default recording folder keep recording there. */
function keepRecordDir(settingsFile: string, oldRecordDir: string): void {
  try {
    if (!fs.existsSync(oldRecordDir)) return;
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { recordDir?: string };
    if (s.recordDir) return;
    fs.writeFileSync(settingsFile, JSON.stringify({ ...s, recordDir: oldRecordDir }, null, 2));
  } catch {
    /* no settings, or unreadable: the app falls back to defaults as before */
  }
}
