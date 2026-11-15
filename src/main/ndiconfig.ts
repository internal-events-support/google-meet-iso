// NDI network configuration (discovery server, NIC selection) via the official
// ndi-config.v1.json mechanism. Must run before the NDI library loads in any process, so it
// is applied at startup and child renderers inherit NDI_CONFIG_DIR.

import * as fs from 'fs';
import * as path from 'path';

export function applyNdiConfig(userData: string, discoveryServer: string, nicIps: string): string | null {
  const dir = path.join(userData, 'ndi');
  const ips = nicIps
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!discoveryServer.trim() && !ips.length) {
    delete process.env.NDI_CONFIG_DIR;
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const cfg: Record<string, unknown> = {
    ndi: {
      ...(discoveryServer.trim() ? { networks: { discovery: discoveryServer.trim(), ips: '' } } : {}),
      ...(ips.length ? { adapters: { allowed: ips } } : {}),
    },
  };
  fs.writeFileSync(path.join(dir, 'ndi-config.v1.json'), JSON.stringify(cfg, null, 2));
  process.env.NDI_CONFIG_DIR = dir;
  return dir;
}
