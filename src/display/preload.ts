// Full-screen display output: shows one of our own NDI outputs on a monitor (for a confidence
// monitor or a projector), received back through NDI so it shows exactly what's on the wire.
//
// Frames arrive as UYVY (NDI's native 4:2:2: half the bytes of BGRA and no colour conversion in
// the NDI decoder), are copied once into a reused buffer (readInto), uploaded as a W/2×H RGBA
// texture and converted to RGB in a WebGL2 shader. BGRA (sources with alpha) is drawn directly.

import * as path from 'path';

interface ReadInfo {
  width: number;
  height: number;
  format: 'UYVY' | 'BGRA' | 'BGRX';
  bytes: number;
  needed?: number;
}
interface Rx {
  readInto(buf: ArrayBuffer): ReadInfo | null;
  destroy(): void;
}
interface Mod {
  load(): { ok: boolean };
  Receiver: new (name: string, opts?: { lowBandwidth?: boolean; format?: 'BGRA' | 'UYVY' }) => Rx;
  Finder: new () => { sources(): string[]; destroy(): void };
}

const params = new URLSearchParams(location.search);
const wanted = params.get('source') ?? '';

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// u_mode 0: UYVY packed as RGBA (U Y0 V Y1) at W/2×H, BT.709 limited range. 1: BGRA/BGRX.
const FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_mode;
uniform ivec2 u_size;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = u_size.y - 1 - p.y;
  if (u_mode == 1) {
    vec4 c = texelFetch(u_tex, p, 0);
    o = vec4(c.b, c.g, c.r, 1.0);
    return;
  }
  vec4 t = texelFetch(u_tex, ivec2(p.x >> 1, p.y), 0);
  float y = ((p.x & 1) == 1 ? t.a : t.g) * 255.0 - 16.0;
  float u = t.r * 255.0 - 128.0;
  float v = t.b * 255.0 - 128.0;
  vec3 rgb = vec3(1.164384 * y + 1.792741 * v, 1.164384 * y - 0.213249 * u - 0.532909 * v, 1.164384 * y + 2.112402 * u) / 255.0;
  o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

class Renderer {
  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture;
  private uMode: WebGLUniformLocation | null;
  private uSize: WebGLUniformLocation | null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, desynchronized: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());
    this.uMode = gl.getUniformLocation(prog, 'u_mode');
    this.uSize = gl.getUniformLocation(prog, 'u_size');
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  draw(data: Uint8Array, info: ReadInfo): void {
    const gl = this.gl;
    const { width: w, height: h } = info;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const uyvy = info.format === 'UYVY';
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, uyvy ? w / 2 : w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.uniform1i(this.uMode, uyvy ? 0 : 1);
    gl.uniform2i(this.uSize, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const label = document.getElementById('label') as HTMLDivElement;
  let mod: Mod;
  let renderer: Renderer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(path.join(__dirname, '..', '..', 'build', 'Release', 'gmeet_iso_ndi.node')) as Mod;
    mod.load();
    renderer = new Renderer(canvas);
  } catch (e) {
    label.textContent = `Display unavailable: ${(e as Error).message}`;
    return;
  }
  const finder = new mod.Finder();
  let rx: Rx | null = null;
  let lastFrame = performance.now();
  let buf = new ArrayBuffer(1920 * 1080 * 2);
  let view = new Uint8Array(buf);
  label.textContent = `Waiting for ${wanted}…`;

  const connect = () => {
    const full = finder.sources().find((s) => s.endsWith(`(${wanted})`));
    if (full) rx = new mod.Receiver(full, { format: 'UYVY' });
  };

  const draw = () => {
    if (!rx) connect();
    let f = rx?.readInto(buf) ?? null;
    if (f && !f.bytes && f.needed) {
      buf = new ArrayBuffer(f.needed);
      view = new Uint8Array(buf);
      f = rx!.readInto(buf);
    }
    if (f && f.bytes) {
      lastFrame = performance.now();
      label.textContent = '';
      renderer.draw(view.subarray(0, f.bytes), f);
    } else if (performance.now() - lastFrame > 3000) {
      label.textContent = `No signal: ${wanted}`;
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  window.addEventListener('beforeunload', () => {
    rx?.destroy();
    finder.destroy();
  });
});
