// Local HTTP + WebSocket control API.
//
//   GET  /api/state            → { meet, outputs, settings }
//   GET  /api/outputs          → configured outputs + live status
//   GET  /api/participants     → roster
//   POST /api/command          → body: Command JSON (see shared/types.ts), returns result
//   WS   /ws                   → pushes {type:"state", ...} every 500 ms; send Command JSON to act
//   GET  /api/osc/support      → OSC command catalogue with supported flags (src/shared/oscSupport.ts)
//   POST /api/osc              → body {address, args[]}: run any ZoomOSC/ZoomISO OSC command, returns its OSC replies
//   GET  /api/osc/{list,gallery,routing,audioLevels,engine} → the same data as the OSC list/reply messages
//   WS   send {type:"osc", address, args, requestId?} → {type:"osc", requestId, handled, replies}

import * as http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Command } from '../shared/types';
import { OSC_SUPPORT } from '../shared/oscSupport';
import { runOscCollect, type OscArg } from './osc/router';

export class ApiServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(
    private handle: (c: Command) => Promise<unknown>,
    private snapshot: () => Record<string, unknown>,
    private log: (s: string) => void,
  ) {}

  start(port: number, host = '127.0.0.1'): void {
    this.stop();
    const server = http.createServer((req, res) => void this.route(req, res));
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/ws')) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
    server.on('error', (e) => this.log(`API error: ${e.message}`));
    server.listen(port, host, () => this.log(`API listening on http://${host}:${port} (WebSocket /ws)`));
    this.server = server;
    this.wss = wss;
    this.pushTimer = setInterval(() => {
      if (!wss.clients.size) return;
      const msg = JSON.stringify({ type: 'state', ...this.snapshot() });
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    }, 500);
  }

  private onSocket(ws: WebSocket): void {
    ws.send(JSON.stringify({ type: 'state', ...this.snapshot() }));
    ws.on('message', async (data) => {
      let reply: unknown;
      try {
        const c = JSON.parse(String(data)) as Command & { requestId?: string; type?: string; address?: string; args?: OscArg[] };
        if (c.type === 'osc' && c.address) {
          const r = await runOscCollect(c.address, c.args ?? []);
          ws.send(JSON.stringify({ type: 'osc', requestId: c.requestId ?? null, ...r }));
          return;
        }
        const result = await this.handle(c);
        reply = { type: 'result', requestId: c.requestId ?? null, ok: true, result };
      } catch (e) {
        reply = { type: 'result', ok: false, error: (e as Error).message };
      }
      ws.send(JSON.stringify(reply));
    });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
        return void res.end();
      }
      const snap = this.snapshot();
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, snap);
      if (req.method === 'GET' && url.pathname === '/api/outputs') return send(200, snap.outputs ?? []);
      if (req.method === 'GET' && url.pathname === '/api/participants') return send(200, (snap.meet as { participants?: unknown[] } | null)?.participants ?? []);
      if (req.method === 'GET' && url.pathname === '/api/osc/support') return send(200, OSC_SUPPORT);
      const OSC_GETS: Record<string, string> = {
        '/api/osc/list': '/gmeet/list',
        '/api/osc/gallery': '/gmeet/getGalleryOrder',
        '/api/osc/routing': '/gmeet/getOutputRouting',
        '/api/osc/audioLevels': '/gmeet/getAudioLevels',
        '/api/osc/engine': '/gmeet/getEngineState',
      };
      if (req.method === 'GET' && OSC_GETS[url.pathname]) return send(200, (await runOscCollect(OSC_GETS[url.pathname], [])).replies);
      if (req.method === 'POST' && url.pathname === '/api/osc') {
        const b = JSON.parse((await readBody(req)) || '{}') as { address?: string; args?: OscArg[] };
        if (!b.address) return send(400, { ok: false, error: 'address required' });
        const r = await runOscCollect(b.address, b.args ?? []);
        const err = r.replies.find((x) => x.address.endsWith('/oscErrors'));
        return send(err ? 400 : r.handled ? 200 : 404, { ok: !err && r.handled, ...r });
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const body = await new Promise<string>((resolve, reject) => {
          let b = '';
          req.on('data', (c) => (b += c));
          req.on('end', () => resolve(b));
          req.on('error', reject);
        });
        const c = JSON.parse(body || '{}') as Command;
        const result = await this.handle(c);
        return send(200, { ok: true, result });
      }
      send(404, { ok: false, error: 'not found' });
    } catch (e) {
      send(400, { ok: false, error: (e as Error).message });
    }
  }

  stop(): void {
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.pushTimer = null;
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
