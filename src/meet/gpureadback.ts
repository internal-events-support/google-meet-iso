// Async GPU readback for NDI outputs.
//
// Uploads a composed frame (the output's 2D canvas) into a WebGL2 texture, converts it on
// the GPU into an NDI-native packed format and reads it back through a pixel-pack buffer
// (PBO) guarded by a fence, so the renderer's main thread never stalls on the GPU:
//   - UYVY (4:2:2, 2 bytes/px): a W/2 × H RGBA8 target where each texel = U Y0 V Y1.
//     BT.709 limited range (what the NDI runtime assumes for UYVY, SD included).
//   - BGRA (4 bytes/px): for outputs that need alpha (transparent loss mode).
// Usage: start() then poll() from later tasks (fences only signal across task boundaries).

export type PackFormat = 'UYVY' | 'BGRA';

export interface ReadbackResult {
  buf: ArrayBuffer;
  fmt: PackFormat;
  width: number;
  height: number;
  stride: number;
  /** Main-thread ms spent on this frame (upload/convert/issue + final copy). */
  cpuMs: number;
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// texelFetch with an unflipped upload: texel row 0 = top source row = framebuffer row 0 =
// first row returned by readPixels, so the readback is top-down with no flips.
const FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_mode;   // 0 = UYVY, 1 = BGRA
uniform vec3 u_k;     // Kr, Kg, Kb
uniform vec2 u_den;   // 2(1-Kb), 2(1-Kr)
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_mode == 1) {
    vec4 c = texelFetch(u_tex, p, 0);
    o = vec4(c.b, c.g, c.r, c.a);
    return;
  }
  vec3 a = texelFetch(u_tex, ivec2(p.x * 2, p.y), 0).rgb;
  vec3 b = texelFetch(u_tex, ivec2(p.x * 2 + 1, p.y), 0).rgb;
  float ya = dot(a, u_k);
  float yb = dot(b, u_k);
  vec3 m = (a + b) * 0.5;
  float ym = dot(m, u_k);
  float cb = (m.b - ym) / u_den.x;
  float cr = (m.r - ym) / u_den.y;
  o = clamp(vec4(128.0 + 224.0 * cb, 16.0 + 219.0 * ya, 128.0 + 224.0 * cr, 16.0 + 219.0 * yb) / 255.0, 0.0, 1.0);
}`;

interface Slot {
  pbo: WebGLBuffer;
  size: number;
  sync: WebGLSync | null;
  fmt: PackFormat;
  width: number;
  height: number;
  stride: number;
  cpuMs: number;
}

export class GpuReadback {
  private canvas = new OffscreenCanvas(2, 2);
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private src: WebGLTexture;
  private dst: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private dstW = 0;
  private dstH = 0;
  private slots: Slot[] = [];
  private queue: Slot[] = [];
  private u: { mode: WebGLUniformLocation | null; k: WebGLUniformLocation | null; den: WebGLUniformLocation | null };
  private out: ArrayBuffer | null = null;
  lost = false;

  /** Returns null when WebGL2 is unavailable (callers fall back to VideoFrame.copyTo). */
  static create(): GpuReadback | null {
    try {
      return new GpuReadback();
    } catch {
      return null;
    }
  }

  private constructor() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('no webgl2');
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
    this.prog = prog;
    this.u = { mode: gl.getUniformLocation(prog, 'u_mode'), k: gl.getUniformLocation(prog, 'u_k'), den: gl.getUniformLocation(prog, 'u_den') };
    const tex = (): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.src = tex();
    this.dst = tex();
    this.fbo = gl.createFramebuffer()!;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    this.canvas.addEventListener?.('webglcontextlost', () => (this.lost = true));
    for (let i = 0; i < 2; i++) this.slots.push({ pbo: gl.createBuffer()!, size: 0, sync: null, fmt: 'UYVY', width: 0, height: 0, stride: 0, cpuMs: 0 });
  }

  /** Frames converted but not yet collected. */
  get pending(): number {
    return this.queue.length;
  }

  /** Upload + convert `src` (W×H) and start an async readback. False if both slots are busy. */
  start(src: TexImageSource, W: number, H: number, fmt: PackFormat): boolean {
    if (this.lost || this.gl.isContextLost()) {
      this.lost = true;
      return false;
    }
    const slot = this.slots.find((s) => !s.sync);
    if (!slot) return false;
    const t0 = performance.now();
    const gl = this.gl;
    if (fmt === 'UYVY' && W % 2) fmt = 'BGRA';
    const tw = fmt === 'UYVY' ? W / 2 : W;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (this.dstW !== tw || this.dstH !== H) {
      gl.bindTexture(gl.TEXTURE_2D, this.dst);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dst, 0);
      this.dstW = tw;
      this.dstH = H;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, tw, H);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(this.u.mode, fmt === 'UYVY' ? 0 : 1);
    // BT.709 limited range at every size: the NDI 6 runtime decodes UYVY as BT.709 even
    // for SD (verified at 640x480 and 720x576 — BT.601 there turned 75% green into 162).
    const kr = 0.2126;
    const kb = 0.0722;
    gl.uniform3f(this.u.k, kr, 1 - kr - kb, kb);
    gl.uniform2f(this.u.den, 2 * (1 - kb), 2 * (1 - kr));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const size = tw * 4 * H;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    if (slot.size !== size) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      slot.size = size;
    }
    gl.readPixels(0, 0, tw, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    slot.fmt = fmt;
    slot.width = W;
    slot.height = H;
    slot.stride = tw * 4;
    slot.cpuMs = performance.now() - t0;
    this.queue.push(slot);
    return true;
  }

  /**
   * Oldest finished readback, or null if it isn't ready yet. The returned buffer is
   * reused by the next poll() — consume (e.g. sendVideo, which copies) before then.
   */
  poll(): ReadbackResult | null {
    const slot = this.queue[0];
    if (!slot?.sync) return null;
    const gl = this.gl;
    const st = gl.clientWaitSync(slot.sync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return null;
    const t0 = performance.now();
    this.queue.shift();
    gl.deleteSync(slot.sync);
    slot.sync = null;
    if (st === gl.WAIT_FAILED) return null;
    if (!this.out || this.out.byteLength !== slot.size) this.out = new ArrayBuffer(slot.size);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, new Uint8Array(this.out));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { buf: this.out, fmt: slot.fmt, width: slot.width, height: slot.height, stride: slot.stride, cpuMs: slot.cpuMs + performance.now() - t0 };
  }

  dispose(): void {
    for (const s of this.slots) if (s.sync) this.gl.deleteSync(s.sync);
    this.queue = [];
    (this.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  }
}
