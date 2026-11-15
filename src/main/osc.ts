// Minimal OSC 1.0 over UDP (no dependencies): decode messages/bundles, encode replies.

import * as dgram from 'dgram';

export type OscArg = number | string | boolean | null;
export interface OscMessage {
  address: string;
  args: OscArg[];
}

function readString(buf: Buffer, off: number): [string, number] {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString('utf8', off, end);
  return [s, (end + 4) & ~3];
}

function decodeMessage(buf: Buffer): OscMessage | null {
  let [address, off] = readString(buf, 0);
  if (!address.startsWith('/')) return null;
  if (off >= buf.length) return { address, args: [] };
  let tags: string;
  [tags, off] = readString(buf, off);
  const args: OscArg[] = [];
  for (const t of tags.slice(1)) {
    switch (t) {
      case 'i':
        args.push(buf.readInt32BE(off));
        off += 4;
        break;
      case 'f':
        args.push(buf.readFloatBE(off));
        off += 4;
        break;
      case 'd':
        args.push(buf.readDoubleBE(off));
        off += 8;
        break;
      case 'h':
        args.push(Number(buf.readBigInt64BE(off)));
        off += 8;
        break;
      case 's':
      case 'S': {
        let s: string;
        [s, off] = readString(buf, off);
        args.push(s);
        break;
      }
      case 'T':
        args.push(true);
        break;
      case 'F':
        args.push(false);
        break;
      case 'N':
        args.push(null);
        break;
      case 'b': {
        const n = buf.readInt32BE(off);
        off += 4 + ((n + 3) & ~3);
        args.push(null);
        break;
      }
      default:
        return { address, args };
    }
  }
  return { address, args };
}

export function decode(buf: Buffer): OscMessage[] {
  if (buf.toString('utf8', 0, 7) === '#bundle') {
    const out: OscMessage[] = [];
    let off = 16; // "#bundle\0" + 8-byte timetag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      out.push(...decode(buf.subarray(off, off + size)));
      off += size;
    }
    return out;
  }
  const m = decodeMessage(buf);
  return m ? [m] : [];
}

function padString(s: string): Buffer {
  const b = Buffer.from(s + '\0', 'utf8');
  const pad = (4 - (b.length % 4)) % 4;
  return Buffer.concat([b, Buffer.alloc(pad)]);
}

export function encode(address: string, args: OscArg[]): Buffer {
  let tags = ',';
  const parts: Buffer[] = [];
  for (const a of args) {
    if (typeof a === 'number' && Number.isInteger(a)) {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a);
      parts.push(b);
    } else if (typeof a === 'number') {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      parts.push(b);
    } else if (typeof a === 'boolean') {
      tags += a ? 'T' : 'F';
    } else if (a === null) {
      tags += 'N';
    } else {
      tags += 's';
      parts.push(padString(String(a)));
    }
  }
  return Buffer.concat([padString(address), padString(tags), ...parts]);
}

export class OscServer {
  private sock: dgram.Socket | null = null;
  constructor(
    private onMessage: (m: OscMessage, reply: (address: string, args: OscArg[]) => void, from: dgram.RemoteInfo) => void,
    private replyTarget: () => { host: string; port: number },
    private log: (s: string) => void,
  ) {}

  /** `address` = local interface IP to bind ('' = all interfaces). */
  start(port: number, address = ''): void {
    this.stop();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => this.log(`OSC error: ${e.message}`));
    sock.on('message', (buf, rinfo) => {
      let msgs: OscMessage[] = [];
      try {
        msgs = decode(buf);
      } catch (e) {
        this.log(`OSC decode error: ${(e as Error).message}`);
      }
      for (const m of msgs) {
        this.onMessage(m, (address, args) => this.send(address, args), rinfo);
      }
    });
    const onBound = () => this.log(`OSC listening on udp/${address || '*'}:${port}`);
    if (address) sock.bind(port, address, onBound);
    else sock.bind(port, onBound);
    this.sock = sock;
  }

  /** Minimum gap between outgoing messages (OSC baud rate). 0 = send immediately. */
  minGapMs = 0;
  private queue: { address: string; args: OscArg[]; key?: string }[] = [];
  private lastSend = 0;
  private timer: NodeJS.Timeout | null = null;

  /**
   * Queue (baud rate) or send. With a coalesceKey, a still-queued message with the same key is
   * replaced so slow baud rates deliver the latest state instead of a growing backlog.
   */
  send(address: string, args: OscArg[], coalesceKey?: string): void {
    if (this.minGapMs <= 0) return this.sendNow(address, args);
    if (coalesceKey) {
      const i = this.queue.findIndex((q) => q.key === coalesceKey);
      if (i >= 0) {
        this.queue[i] = { address, args, key: coalesceKey };
        return;
      }
    }
    if (this.queue.length >= 2000) this.queue.shift();
    this.queue.push({ address, args, key: coalesceKey });
    this.pump();
  }

  private pump(): void {
    if (this.timer || !this.queue.length) return;
    const wait = Math.max(0, this.lastSend + this.minGapMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const m = this.queue.shift();
      if (m) this.sendNow(m.address, m.args);
      this.pump();
    }, wait);
  }

  private sendNow(address: string, args: OscArg[]): void {
    const { host, port } = this.replyTarget();
    if (!this.sock || !host || !port) return;
    this.lastSend = Date.now();
    const b = encode(address, args);
    this.sock.send(b, port, host);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    try {
      this.sock?.close();
    } catch {
      /* already closed */
    }
    this.sock = null;
  }
}
