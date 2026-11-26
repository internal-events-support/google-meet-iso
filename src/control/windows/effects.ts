// Output Effects window — replica of ZoomISO v3 ProcAmpAdjustmentView.
// Left: stream picker + live preview (guides, crop region, overlay handles) and the scopes
// (histogram / vectorscope / waveform) with the floating preview toolbar.
// Right: ProcAmpControlsPanel (Color / Cropping / Overlays) + Save/Load preset + Apply.
// The preview renders through the same WebGL pipeline as the NDI output (effects/fxgl.ts).

import { api, bindPreview, initStore, on, outputState, store, updateOutput, windowArg } from '../store';
import { installWindowChrome } from '../chrome';
import { confirmSheet, h, menu, popup, RE_IMAGES } from '../kit';
import type { AutoCropResponsiveness, NameTagFont, OutputConfig, OutputEffects, OverlayImage, OverlayLayerRef } from '../../shared/types';
import {
  ASPECT_OVERLAY_OPTIONS,
  AUTO_CROP_RESPONSIVENESS_OPTIONS,
  CROP_PREVIEW_MODE_OPTIONS,
  DEFAULT_AUTO_CROP,
  DEFAULT_EFFECTS,
  GUIDE_OVERLAY_OPTIONS,
  NAME_TAG_ALIGNMENT_OPTIONS,
  NAME_TAG_FONT_OPTIONS,
  NAME_TAG_NAME_MODE_OPTIONS,
  NAME_TAG_PLACEMENT_OPTIONS,
  migrateNameTagFont,
} from '../../shared/types';
import { FxRenderer, fullEffects, fullViewGeometry, fxGeometry, outToSrc, srcToOut, toneLut, WB_MAX_K, WB_MIN_K } from '../effects/fxgl';
import type { FxGeometry } from '../effects/fxgl';
import { drawOverlays, imageRect, layerOrder, nameTagLayout, nameTagTitle } from '../effects/overlays';
import { drawScope, samplePixels } from '../effects/scopes';
import type { ScopeType } from '../effects/scopes';
import { AUTO_CROP_UNSUPPORTED, AutoCropTracker, autoCropSupported } from '../effects/autocrop';
import { svgIcon } from '../effects/icons';

type Tab = 'color' | 'cropping' | 'overlays';
type Guide = 'thirdsGrid' | 'centerLines' | 'crosshair' | 'personSilhouette' | 'safeAreas';
type Aspect = 'none' | 'fourThree' | 'oneOne' | 'nineSixteen';
type PreviewMode = 'croppedOutput' | 'fullView';

const AUTO_KEYS = [
  'autoCropEnabled',
  'autoCropShowGuides',
  'autoCropShowFaceGuides',
  'autoCropShowTargetSizeGuide',
  'autoCropShowOverscanHorizontalGuide',
  'autoCropShowOverscanVerticalGuide',
  'autoCropTargetSize',
  'autoCropTargetVertical',
  'autoCropResponsiveness',
  'autoCropExtendHorizontal',
  'autoCropExtendVertical',
  'autoCropOverscanHorizontal',
  'autoCropOverscanVertical',
  'autoCropZoomOutOnLostFace',
] as const;
type AutoKey = (typeof AUTO_KEYS)[number];
type AutoFields = Required<Pick<OutputConfig, AutoKey>>;

const COLOR_KEYS: (keyof OutputEffects)[] = [
  'exposure', 'contrast', 'vibrance', 'sharpness', 'whiteBalanceK', 'temperature', 'tint', 'saturation', 'highlights', 'shadows', 'vignette', 'toneCurve',
  'liftR', 'liftG', 'liftB', 'gammaR', 'gammaG', 'gammaB', 'gainR', 'gainG', 'gainB', 'brightness', 'hue',
];
const CROP_KEYS: (keyof OutputEffects)[] = ['cropZoom', 'cropPanX', 'cropPanY', 'cropRotation', 'zoom', 'panX', 'panY', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'mirror'];
const NAME_TAG_KEYS: (keyof OutputEffects)[] = [
  'nameTag', 'nameTagText', 'nameTagSubtitle', 'nameTagNameMode', 'nameTagFont', 'nameTagSize', 'nameTagOffset', 'nameTagPlacement', 'nameTagTextAlignment',
  'nameTagColor', 'nameTagBg', 'nameTagBgOpacity', 'nameTagCornerRadius',
];
const OVERLAY_KEYS: (keyof OutputEffects)[] = [...NAME_TAG_KEYS, 'images', 'overlayLayerOrder'];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const LS = 'gmeetIso.effects.ui';
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
})();

const ui = {
  id: '',
  draft: fullEffects(null),
  auto: { ...(DEFAULT_AUTO_CROP as AutoFields) },
  applied: '',
  tab: ((saved.tab as Tab) ?? 'color') as Tab,
  previewMode: 'croppedOutput' as PreviewMode,
  guides: new Set<Guide>((saved.guides as Guide[]) ?? ['thirdsGrid']),
  aspect: ((saved.aspect as Aspect) ?? 'none') as Aspect,
  scopes: new Set<ScopeType>((saved.scopes as ScopeType[]) ?? ['histogram', 'vectorscope', 'waveform']),
  bypass: false,
  collapsed: new Set<string>((saved.collapsed as string[]) ?? []),
  editing: null as string | null,
  dirtyRender: true,
};

function persistUi(): void {
  localStorage.setItem(LS, JSON.stringify({ tab: ui.tab, guides: [...ui.guides], aspect: ui.aspect, scopes: [...ui.scopes], collapsed: [...ui.collapsed] }));
}

const cfg = (): OutputConfig | undefined => store.settings?.outputs.find((o) => o.id === ui.id);
const snapshot = () => JSON.stringify({ e: ui.draft, a: ui.auto });
const dirty = () => snapshot() !== ui.applied;

function autoFrom(o: OutputConfig | undefined): AutoFields {
  const a = { ...(DEFAULT_AUTO_CROP as AutoFields) };
  if (o) for (const k of AUTO_KEYS) if (o[k] !== undefined) (a as Record<string, unknown>)[k] = o[k];
  return a;
}

function seedFrom(o: OutputConfig | undefined): void {
  ui.draft = fullEffects(o?.effects);
  ui.draft.nameTagFont = migrateNameTagFont(ui.draft.nameTagFont);
  ui.auto = autoFrom(o);
  ui.applied = snapshot();
  ui.editing = null;
  tracker = null;
}

let applyTimer = 0;
function apply(): void {
  window.clearTimeout(applyTimer);
  if (!ui.id) return;
  const patch: Partial<OutputConfig> = { effects: { ...ui.draft }, ...ui.auto };
  ui.applied = snapshot();
  void updateOutput(ui.id, patch);
  renderFooter();
}

function changed(rebuild = false): void {
  ui.dirtyRender = true;
  if (ui.draft.autoApply) {
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(apply, 90);
  }
  if (rebuild) renderPanel();
  renderFooter();
}

function setE(patch: Partial<OutputEffects>, rebuild = false): void {
  ui.draft = { ...ui.draft, ...patch };
  changed(rebuild);
}
function setA(patch: Partial<AutoFields>, rebuild = false): void {
  ui.auto = { ...ui.auto, ...patch };
  changed(rebuild);
}

function resetKeys(keys: (keyof OutputEffects)[]): void {
  const p: Partial<OutputEffects> = {};
  for (const k of keys) (p as Record<string, unknown>)[k] = structuredClone((DEFAULT_EFFECTS as unknown as Record<string, unknown>)[k]);
  setE(p, true);
}

// ---------------------------------------------------------------------------
// DOM skeleton
// ---------------------------------------------------------------------------
const els = {
  root: h('div.fx-root'),
  views: h('div.fx-views'),
  previewTile: h('div.fx-tile.fx-preview-tile'),
  previewBox: h('div.fx-preview-box'),
  canvas: h('canvas.fx-canvas') as HTMLCanvasElement,
  guides: h('canvas.fx-guides') as HTMLCanvasElement,
  label: h('div.fx-preview-label'),
  pickerWrap: h('div.fx-stream-picker'),
  scopeTiles: new Map<ScopeType, { tile: HTMLElement; canvas: HTMLCanvasElement }>(),
  toolbar: h('div.fx-toolbar'),
  panel: h('div.fx-panel'),
  tabs: h('div.fx-tabs'),
  scroll: h('div.fx-scroll'),
  footer: h('div.fx-footer'),
};

const SCOPE_LABEL: Record<ScopeType, string> = { histogram: 'Histogram', vectorscope: 'Vectorscope', waveform: 'Waveform' };

function buildSkeleton(): void {
  els.previewBox.append(els.canvas, els.guides, els.label);
  els.previewTile.append(els.previewBox, els.pickerWrap);
  els.views.append(els.previewTile);
  for (const t of ['histogram', 'vectorscope', 'waveform'] as ScopeType[]) {
    const canvas = h('canvas.fx-scope') as HTMLCanvasElement;
    const tile = h('div.fx-tile.fx-scope-tile', { dataset: { scope: t } }, h('div.fx-scope-label', SCOPE_LABEL[t]), canvas);
    els.scopeTiles.set(t, { tile, canvas });
    els.views.append(tile);
  }
  const stage = h('div.fx-stage', els.views, els.toolbar);
  els.panel.append(els.tabs, els.scroll, els.footer);
  els.root.append(stage, els.panel);
  document.getElementById('app')!.append(els.root);
  new ResizeObserver(() => layoutPreview()).observe(els.previewTile);
  wireInteraction();
}

function layoutViews(): void {
  const active = (['histogram', 'vectorscope', 'waveform'] as ScopeType[]).filter((s) => ui.scopes.has(s));
  els.views.dataset.count = String(active.length + 1);
  for (const [t, { tile }] of els.scopeTiles) {
    const i = active.indexOf(t);
    tile.hidden = i < 0;
    tile.style.order = String(i + 1);
  }
  layoutPreview();
}

// ---------------------------------------------------------------------------
// stream picker (ProcAmpStreamPicker)
// ---------------------------------------------------------------------------
let picker: ReturnType<typeof popup> | null = null;
const pickerOpts = () => (store.settings?.outputs ?? []).map((o) => ({ value: o.id, label: o.name }));
function renderPicker(): void {
  if (!picker) {
    picker = popup(pickerOpts(), ui.id, (v) => void switchTo(v), { cls: 'fx-picker', title: 'Select output' });
    els.pickerWrap.append(picker.el);
  } else picker.set(pickerOpts(), ui.id);
}

async function switchTo(id: string): Promise<void> {
  if (id === ui.id) return;
  if (dirty() && !ui.draft.autoApply) {
    const ok = await confirmSheet('Unapplied changes', 'You have unapplied output effects that will be lost if you switch outputs.', 'Proceed', true);
    if (!ok) {
      picker?.set(pickerOpts(), ui.id);
      return;
    }
  }
  ui.id = id;
  history.replaceState(null, '', `?arg=${encodeURIComponent(id)}`);
  seedFrom(cfg());
  bindSources();
  renderAll();
}

// ---------------------------------------------------------------------------
// preview sources: raw:<id> (unprocessed, from the engine) → src:<key> thumb → <id> (processed)
// ---------------------------------------------------------------------------
type Img = { el: HTMLImageElement; at: number };
const srcImgs: Record<'raw' | 'src' | 'out', Img | null> = { raw: null, src: null, out: null };
let unsubs: (() => void)[] = [];
let boundSrcKey = '';

function feed(kind: 'raw' | 'src' | 'out') {
  return (url: string) => {
    const el = new Image();
    el.onload = () => {
      srcImgs[kind] = { el, at: performance.now() };
      ui.dirtyRender = true;
    };
    el.src = url;
  };
}

function bindSources(): void {
  for (const u of unsubs) u();
  unsubs = [];
  srcImgs.raw = srcImgs.src = srcImgs.out = null;
  boundSrcKey = '';
  srcUnsub?.();
  srcUnsub = null;
  if (!ui.id) return;
  unsubs.push(bindPreview(`raw:${ui.id}`, feed('raw')), bindPreview(ui.id, feed('out')));
  rebindSrcThumb();
}

let srcUnsub: (() => void) | null = null;
function rebindSrcThumb(): void {
  const key = outputState(ui.id)?.sourceKey ?? '';
  if (key === boundSrcKey) return;
  boundSrcKey = key;
  srcUnsub?.();
  srcUnsub = null;
  srcImgs.src = null;
  if (key) srcUnsub = bindPreview(`src:${key}`, feed('src'));
}

/** Pick the best preview input. `processed` = already has the applied effects baked in. */
function pickSource(): { img: HTMLImageElement; processed: boolean } | null {
  const st = outputState(ui.id);
  const now = performance.now();
  const fresh = (i: Img | null, ms = 2500) => !!i && now - i.at < ms;
  if (st?.status === 'live') {
    if (fresh(srcImgs.raw)) return { img: srcImgs.raw!.el, processed: false };
    if (fresh(srcImgs.src)) return { img: srcImgs.src!.el, processed: false };
  }
  if (srcImgs.out) return { img: srcImgs.out.el, processed: true };
  return null;
}

// ---------------------------------------------------------------------------
// preview render
// ---------------------------------------------------------------------------
let fx: FxRenderer | null = null;
let tracker: AutoCropTracker | null = null;
let curGeom: FxGeometry | null = null;
let fullGeom: FxGeometry | null = null;
let lastSource: { img: HTMLImageElement; processed: boolean } | null = null;
const overlayImgs = new Map<string, HTMLImageElement>();

function fileUrl(p: string): string {
  if (/^(https?|file|data|blob):/i.test(p)) return p;
  return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function overlayImage(img: OverlayImage): HTMLImageElement | null {
  let el = overlayImgs.get(img.path);
  if (!el) {
    el = new Image();
    el.onload = () => (ui.dirtyRender = true);
    el.src = fileUrl(img.path);
    overlayImgs.set(img.path, el);
  }
  return el.complete && el.naturalWidth ? el : null;
}

function outSize(): { W: number; H: number } {
  const f = cfg()?.format;
  let aspect = 16 / 9;
  if (f) aspect = f.width / f.height;
  else {
    const st = outputState(ui.id);
    if (st && st.outWidth && st.outHeight) aspect = st.outWidth / st.outHeight;
  }
  const W = 1280;
  return { W, H: Math.round(W / aspect) };
}

function layoutPreview(): void {
  const { W, H } = outSize();
  const tile = els.previewTile.getBoundingClientRect();
  const s = Math.min(Math.max(10, tile.width) / W, Math.max(10, tile.height) / H);
  const w = Math.floor(W * s);
  const hh = Math.floor(H * s);
  Object.assign(els.previewBox.style, { width: `${w}px`, height: `${hh}px` });
  const dpr = window.devicePixelRatio || 1;
  els.guides.width = Math.max(1, Math.round(w * dpr));
  els.guides.height = Math.max(1, Math.round(hh * dpr));
  ui.dirtyRender = true;
}

function participantName(): string {
  return outputState(ui.id)?.sourceName || 'Participant name';
}

function renderPreview(): void {
  const { W, H } = outSize();
  const c = els.canvas;
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
    layoutPreview();
  }
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const src = pickSource();
  lastSource = src;
  curGeom = fullGeom = null;
  const st = outputState(ui.id);
  if (!src) {
    setLabel(!ui.id ? 'No outputs' : st?.status === 'off' ? 'Preview off' : 'No incoming video');
    drawGuides();
    return;
  }
  const iw = src.img.naturalWidth;
  const ih = src.img.naturalHeight;
  if (src.processed) {
    // Only the processed output (or loss content) is available: show it as-is.
    const s = Math.min(W / iw, H / ih);
    ctx.drawImage(src.img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
    setLabel(st?.status === 'live' ? 'Preview: applied output' : st?.status === 'loss' ? 'No incoming video' : '');
    drawGuides();
    return;
  }
  setLabel(ui.bypass ? 'Bypass' : '');
  fx ??= new FxRenderer(document.createElement('canvas'));
  const e = ui.draft;
  const full = ui.tab === 'cropping' && ui.previewMode === 'fullView';
  const useAuto = ui.auto.autoCropEnabled && autoCropSupported();
  if (useAuto) tracker ??= new AutoCropTracker();
  else tracker = null;
  const auto = tracker?.supported ? tracker.update(src.img, iw, ih, W / H, ui.auto) : null;
  curGeom = fxGeometry(e, iw, ih, W, H, auto);
  fullGeom = fullViewGeometry(iw, ih, W, H);
  const geometry = ui.bypass || full ? fullGeom : curGeom;
  const ok = !fx.failed && fx.render(src.img, iw, ih, W, H, e, { color: !ui.bypass, geometry });
  if (ok) ctx.drawImage(fx.canvas, 0, 0);
  else ctx.drawImage(src.img, geometry.W / 2 - geometry.cx * geometry.scale, geometry.H / 2 - geometry.cy * geometry.scale, iw * geometry.scale, ih * geometry.scale);
  if (!ui.bypass && !full) drawOverlays(ctx, W, H, e, participantName(), (img) => overlayImage(img));
  drawGuides();
}

function setLabel(t: string): void {
  els.label.textContent = t;
  els.label.hidden = !t;
}

// ---------------------------------------------------------------------------
// guides + interaction overlay (ProcAmpGuidesOverlayView / CropRegion / ImageOverlayInteraction)
// ---------------------------------------------------------------------------
let silhouette: HTMLImageElement | null = null;
let silhouettePath = '';
function silhouetteImg(): HTMLImageElement | null {
  const custom = store.settings?.interface?.customFramingGuidePath ?? '';
  const want = custom ? fileUrl(custom) : RE_IMAGES.frameGuide;
  if (want !== silhouettePath) {
    silhouettePath = want;
    silhouette = new Image();
    silhouette.onload = () => (ui.dirtyRender = true);
    silhouette.src = want;
  }
  return silhouette && silhouette.complete && silhouette.naturalWidth ? silhouette : null;
}

function cropPolygon(): [number, number][] | null {
  if (!curGeom || !fullGeom) return null;
  const { W, H } = curGeom;
  return ([[0, 0], [W, 0], [W, H], [0, H]] as [number, number][]).map(([x, y]) => {
    const [sx, sy] = outToSrc(curGeom!, x, y);
    return srcToOut(fullGeom!, sx, sy);
  });
}

function drawGuides(): void {
  const g = els.guides;
  const ctx = g.getContext('2d')!;
  ctx.clearRect(0, 0, g.width, g.height);
  const { W, H } = outSize();
  const k = g.width / W;
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(k, k);
  const lw = dpr / k;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  // Aspect-ratio overlay.
  if (ui.aspect !== 'none') {
    const ar = ui.aspect === 'fourThree' ? 4 / 3 : ui.aspect === 'oneOne' ? 1 : 9 / 16;
    const w = Math.min(W, H * ar);
    const hh = Math.min(H, W / ar);
    const x = (W - w) / 2;
    const y = (H - hh) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y + hh, W, H - y - hh);
    ctx.fillRect(0, y, x, hh);
    ctx.fillRect(x + w, y, W - x - w, hh);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = lw;
    ctx.strokeRect(x, y, w, hh);
  }
  if (ui.guides.has('thirdsGrid')) {
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = lw * 1.4;
    for (const f of [1 / 3, 2 / 3]) {
      line(W * f, 0, W * f, H);
      line(0, H * f, W, H * f);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = lw;
  if (ui.guides.has('centerLines')) {
    line(W / 2, 0, W / 2, H);
    line(0, H / 2, W, H / 2);
  }
  if (ui.guides.has('crosshair')) {
    const s = H * 0.04;
    line(W / 2 - s, H / 2, W / 2 + s, H / 2);
    line(W / 2, H / 2 - s, W / 2, H / 2 + s);
  }
  if (ui.guides.has('safeAreas')) {
    ctx.setLineDash([6 / k, 4 / k]);
    for (const f of [0.9, 0.8]) ctx.strokeRect((W * (1 - f)) / 2, (H * (1 - f)) / 2, W * f, H * f);
    ctx.setLineDash([]);
  }
  if (ui.guides.has('personSilhouette')) {
    const img = silhouetteImg();
    if (img) {
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
      ctx.globalAlpha = 1;
    }
  }
  const live = !!lastSource && !lastSource.processed && !ui.bypass;
  const full = ui.tab === 'cropping' && ui.previewMode === 'fullView';
  // Crop region (Full View).
  if (live && full) {
    const poly = cropPolygon();
    if (poly) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 3; i >= 1; i--) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.strokeStyle = '#4793F1';
      ctx.lineWidth = 2 * lw;
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const [x, y] of poly) {
        ctx.beginPath();
        ctx.arc(x, y, 6 * lw, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Auto-crop guides (ProcAmpFaceROIOverlay).
  if (live && ui.auto.autoCropEnabled && ui.auto.autoCropShowGuides && tracker && curGeom) {
    const geo = full ? fullGeom! : curGeom;
    const f = tracker.face;
    if (f && ui.auto.autoCropShowFaceGuides) {
      const pts = [
        [f.x, f.y],
        [f.x + f.w, f.y],
        [f.x + f.w, f.y + f.h],
        [f.x, f.y + f.h],
      ].map(([x, y]) => srcToOut(geo, x * geo.sw, y * geo.sh));
      ctx.strokeStyle = '#30d158';
      ctx.lineWidth = 2 * lw;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
    if (!full && ui.auto.autoCropShowTargetSizeGuide) {
      const th = H * ui.auto.autoCropTargetSize;
      const cy = H * ui.auto.autoCropTargetVertical;
      ctx.strokeStyle = 'rgba(255,214,10,0.9)';
      ctx.setLineDash([5 / k, 4 / k]);
      line(W * 0.4, cy - th / 2, W * 0.6, cy - th / 2);
      line(W * 0.4, cy + th / 2, W * 0.6, cy + th / 2);
      ctx.setLineDash([]);
    }
    if (!full && (ui.auto.autoCropShowOverscanHorizontalGuide || ui.auto.autoCropShowOverscanVerticalGuide)) {
      ctx.strokeStyle = 'rgba(255,159,10,0.8)';
      ctx.setLineDash([3 / k, 3 / k]);
      const [x0, y0] = srcToOut(curGeom, 0, 0);
      const [x1, y1] = srcToOut(curGeom, curGeom.sw, curGeom.sh);
      const oh = ui.auto.autoCropShowOverscanHorizontalGuide ? ui.auto.autoCropOverscanHorizontal * (x1 - x0) : 0;
      const ov = ui.auto.autoCropShowOverscanVerticalGuide ? ui.auto.autoCropOverscanVertical * (y1 - y0) : 0;
      ctx.strokeRect(x0 - oh, y0 - ov, x1 - x0 + oh * 2, y1 - y0 + ov * 2);
      ctx.setLineDash([]);
    }
  }
  // Overlay handles (Overlays tab).
  if (live && ui.tab === 'overlays') {
    const sel = ui.editing;
    for (const img of ui.draft.images ?? []) {
      if (!img.visible) continue;
      const el = overlayImage(img);
      const r = imageRect(img, W, H, el ? el.naturalWidth / el.naturalHeight : img.aspect || 1);
      ctx.save();
      ctx.translate(r.cx, r.cy);
      ctx.rotate(r.rot);
      ctx.strokeStyle = img.id === sel ? '#4793F1' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = (img.id === sel ? 2 : 1) * lw;
      ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
      if (img.id === sel) {
        ctx.fillStyle = '#fff';
        for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.beginPath();
          ctx.arc((x * r.w) / 2, (y * r.h) / 2, 6 * lw, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = '#4793F1';
        line(0, -r.h / 2, 0, -r.h / 2 - 24 * lw);
        ctx.beginPath();
        ctx.arc(0, -r.h / 2 - 24 * lw, 6 * lw, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (ui.draft.nameTag) {
      const L = nameTagLayout(els.canvas.getContext('2d')!, W, H, ui.draft, nameTagTitle(ui.draft, participantName()) || ' ');
      ctx.strokeStyle = sel === 'nameTag' ? '#4793F1' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = (sel === 'nameTag' ? 2 : 1) * lw;
      ctx.strokeRect(L.x, L.y, L.w, L.h);
    }
  }
  ctx.restore();
}

type Drag =
  | { kind: 'pan'; x: number; y: number; px: number; py: number }
  | { kind: 'fullMove'; x: number; y: number; px: number; py: number }
  | { kind: 'fullZoom'; z: number; d0: number; cx: number; cy: number }
  | { kind: 'imgMove'; id: string; x: number; y: number; ix: number; iy: number }
  | { kind: 'imgScale'; id: string; s0: number; d0: number; cx: number; cy: number }
  | { kind: 'imgRotate'; id: string; cx: number; cy: number }
  | { kind: 'tagMove'; y: number; o0: number; span: number };

function toOut(ev: PointerEvent | WheelEvent): [number, number] {
  const r = els.guides.getBoundingClientRect();
  const { W, H } = outSize();
  return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
}

function hitImage(x: number, y: number): { img: OverlayImage; part: 'body' | 'corner' | 'rotate'; r: ReturnType<typeof imageRect> } | null {
  const { W, H } = outSize();
  const tol = (10 * W) / Math.max(1, els.guides.getBoundingClientRect().width);
  const byId = new Map((ui.draft.images ?? []).map((i) => [`image:${i.id}`, i]));
  for (const ref of layerOrder(ui.draft).slice().reverse()) {
    const img = byId.get(ref);
    if (!img || !img.visible) continue;
    const el = overlayImage(img);
    const r = imageRect(img, W, H, el ? el.naturalWidth / el.naturalHeight : img.aspect || 1);
    const c = Math.cos(-r.rot);
    const s = Math.sin(-r.rot);
    const lx = c * (x - r.cx) - s * (y - r.cy);
    const ly = s * (x - r.cx) + c * (y - r.cy);
    if (img.id === ui.editing) {
      if (Math.hypot(lx, ly + r.h / 2 + 2.4 * tol) < tol * 1.2) return { img, part: 'rotate', r };
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) if (Math.hypot(lx - (cx * r.w) / 2, ly - (cy * r.h) / 2) < tol * 1.2) return { img, part: 'corner', r };
    }
    if (Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2) return { img, part: 'body', r };
  }
  return null;
}

function updImage(id: string, patch: Partial<OverlayImage>, rebuild = false): void {
  setE({ images: (ui.draft.images ?? []).map((i) => (i.id === id ? { ...i, ...patch } : i)) }, rebuild);
}

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
let wheelTimer = 0;

function wireInteraction(): void {
  const g = els.guides;
  let drag: Drag | null = null;
  g.addEventListener('pointerdown', (ev) => {
    if (!lastSource || lastSource.processed || ui.bypass || !curGeom) return;
    const [x, y] = toOut(ev);
    const { W, H } = outSize();
    const tol = (10 * W) / g.getBoundingClientRect().width;
    if (ui.tab === 'overlays') {
      const hit = hitImage(x, y);
      if (hit) {
        if (ui.editing !== hit.img.id) {
          ui.editing = hit.img.id;
          renderPanel();
        }
        if (hit.part === 'corner') drag = { kind: 'imgScale', id: hit.img.id, s0: hit.img.scale, d0: Math.hypot(x - hit.r.cx, y - hit.r.cy), cx: hit.r.cx, cy: hit.r.cy };
        else if (hit.part === 'rotate') drag = { kind: 'imgRotate', id: hit.img.id, cx: hit.r.cx, cy: hit.r.cy };
        else drag = { kind: 'imgMove', id: hit.img.id, x, y, ix: hit.img.x, iy: hit.img.y };
      } else if (ui.draft.nameTag) {
        const L = nameTagLayout(els.canvas.getContext('2d')!, W, H, ui.draft, nameTagTitle(ui.draft, participantName()) || ' ');
        if (x >= L.x && x <= L.x + L.w && y >= L.y && y <= L.y + L.h) {
          ui.editing = 'nameTag';
          drag = { kind: 'tagMove', y, o0: ui.draft.nameTagOffset ?? 0.85, span: Math.max(1, H - 2 * Math.round(H * 0.05) - L.h) };
          renderPanel();
        }
      }
      if (!drag && ui.editing) {
        ui.editing = null;
        renderPanel();
      }
    } else if (ui.tab === 'cropping' && !(ui.auto.autoCropEnabled && autoCropSupported())) {
      if (ui.previewMode === 'fullView') {
        const poly = cropPolygon();
        if (!poly) return;
        const corner = poly.find(([px, py]) => Math.hypot(px - x, py - y) < tol * 1.4);
        const cx = poly.reduce((a, p) => a + p[0], 0) / 4;
        const cy = poly.reduce((a, p) => a + p[1], 0) / 4;
        if (corner) drag = { kind: 'fullZoom', z: ui.draft.cropZoom ?? 1, d0: Math.hypot(corner[0] - cx, corner[1] - cy), cx, cy };
        else drag = { kind: 'fullMove', x, y, px: ui.draft.cropPanX ?? 0, py: ui.draft.cropPanY ?? 0 };
      } else drag = { kind: 'pan', x, y, px: ui.draft.cropPanX ?? 0, py: ui.draft.cropPanY ?? 0 };
    }
    if (drag) {
      g.setPointerCapture(ev.pointerId);
      ui.dirtyRender = true;
    }
  });
  g.addEventListener('pointermove', (ev) => {
    const [x, y] = toOut(ev);
    const { W, H } = outSize();
    if (!drag) {
      let cur = '';
      const live = lastSource && !lastSource.processed && !ui.bypass;
      if (live && ui.tab === 'overlays') {
        const hit = hitImage(x, y);
        cur = hit ? (hit.part === 'body' ? 'move' : hit.part === 'rotate' ? 'grab' : 'nwse-resize') : '';
      } else if (live && ui.tab === 'cropping' && !(ui.auto.autoCropEnabled && autoCropSupported())) cur = 'grab';
      g.style.cursor = cur;
      return;
    }
    const geo = curGeom;
    if (!geo) return;
    const rect = geo.rect;
    switch (drag.kind) {
      case 'pan': {
        // Drag the picture: the view centre moves opposite to the pointer.
        const dx = ((geo.mirror ? -1 : 1) * (x - drag.x)) / geo.scale;
        const dy = (y - drag.y) / geo.scale;
        const c = Math.cos(geo.rot);
        const s = Math.sin(geo.rot);
        const sdx = c * dx + s * dy;
        const sdy = -s * dx + c * dy;
        setE({ cropPanX: clampN(drag.px - sdx / (rect.w / 2), -1, 1), cropPanY: clampN(drag.py - sdy / (rect.h / 2), -1, 1) });
        break;
      }
      case 'fullMove': {
        const f = fullGeom!;
        setE({ cropPanX: clampN(drag.px + (x - drag.x) / f.scale / (rect.w / 2), -1, 1), cropPanY: clampN(drag.py + (y - drag.y) / f.scale / (rect.h / 2), -1, 1) });
        break;
      }
      case 'fullZoom': {
        const d = Math.max(4, Math.hypot(x - drag.cx, y - drag.cy));
        setE({ cropZoom: clampN((drag.z * drag.d0) / d, 1, 5) });
        break;
      }
      case 'imgMove':
        updImage(drag.id, { x: clampN(drag.ix + (x - drag.x) / W, -0.5, 1.5), y: clampN(drag.iy + (y - drag.y) / H, -0.5, 1.5) });
        break;
      case 'imgScale':
        updImage(drag.id, { scale: clampN((drag.s0 * Math.hypot(x - drag.cx, y - drag.cy)) / Math.max(1, drag.d0), 0.02, 2) });
        break;
      case 'imgRotate': {
        let deg = (Math.atan2(y - drag.cy, x - drag.cx) * 180) / Math.PI + 90;
        if (deg > 180) deg -= 360;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        updImage(drag.id, { rotation: Math.round(deg) });
        break;
      }
      case 'tagMove':
        setE({ nameTagOffset: clampN(drag.o0 + (y - drag.y) / drag.span, 0, 1) });
        break;
    }
  });
  const end = () => {
    if (drag) {
      drag = null;
      renderPanel();
    }
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
  g.addEventListener(
    'wheel',
    (ev) => {
      if (ui.tab !== 'cropping' || (ui.auto.autoCropEnabled && autoCropSupported()) || !lastSource || lastSource.processed) return;
      ev.preventDefault();
      setE({ cropZoom: clampN((ui.draft.cropZoom ?? 1) * Math.exp(-ev.deltaY * 0.0015), 1, 5) });
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => renderPanel(), 250);
    },
    { passive: false },
  );
}

// ---------------------------------------------------------------------------
// toolbar (ProcAmpPreviewToolbar)
// ---------------------------------------------------------------------------
const GUIDE_ICON: Record<Guide, string> = { thirdsGrid: 'grid', centerLines: 'plus', crosshair: 'viewfinder', personSilhouette: 'person', safeAreas: 'safe' };
const SCOPE_ICON: Record<ScopeType, string> = { histogram: 'histogram', vectorscope: 'vectorscope', waveform: 'waveform' };

function tbButton(iconName: string, tip: string, active: boolean, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = h('button.fx-tb-btn', { dataset: { tip }, 'aria-label': tip }) as HTMLButtonElement;
  b.append(svgIcon(iconName));
  b.classList.toggle('active', active);
  b.addEventListener('click', () => onClick(b));
  return b;
}

function renderToolbar(): void {
  const g1 = h('div.fx-tb-group');
  for (const o of GUIDE_OVERLAY_OPTIONS) {
    const v = o.value as Guide;
    g1.append(
      tbButton(GUIDE_ICON[v], o.label, ui.guides.has(v), () => {
        ui.guides.has(v) ? ui.guides.delete(v) : ui.guides.add(v);
        persistUi();
        renderToolbar();
        ui.dirtyRender = true;
      }),
    );
  }
  const aspectLabel = ASPECT_OVERLAY_OPTIONS.find((o) => o.value === ui.aspect)?.label ?? 'None';
  g1.append(
    tbButton('aspect', `Aspect Ratio: ${aspectLabel}`, ui.aspect !== 'none', (b) => {
      const r = b.getBoundingClientRect();
      menu(
        { x: r.left, y: r.top - 12 - ASPECT_OVERLAY_OPTIONS.length * 28 },
        ASPECT_OVERLAY_OPTIONS.map((o) => ({
          label: `${o.value === ui.aspect ? '✓' : '\u2003'} ${o.label}`,
          onClick: () => {
            ui.aspect = o.value as Aspect;
            persistUi();
            renderToolbar();
            ui.dirtyRender = true;
          },
        })),
      );
    }),
  );
  const g2 = h('div.fx-tb-group');
  for (const t of ['histogram', 'vectorscope', 'waveform'] as ScopeType[]) {
    g2.append(
      tbButton(SCOPE_ICON[t], SCOPE_LABEL[t], ui.scopes.has(t), () => {
        ui.scopes.has(t) ? ui.scopes.delete(t) : ui.scopes.add(t);
        persistUi();
        renderToolbar();
        layoutViews();
      }),
    );
  }
  const g3 = h(
    'div.fx-tb-group',
    tbButton(ui.bypass ? 'eye.slash' : 'eye', ui.bypass ? 'Show corrections' : 'Bypass (preview only)', ui.bypass, () => {
      ui.bypass = !ui.bypass;
      renderToolbar();
      ui.dirtyRender = true;
    }),
  );
  els.toolbar.replaceChildren(g1, h('div.fx-tb-sep'), g2, h('div.fx-tb-sep'), g3);
}

// ---------------------------------------------------------------------------
// panel controls
// ---------------------------------------------------------------------------
const pct = (p: number) => `${Math.round(p * 100)}%`;

interface SliderOpts {
  label: string;
  pos: number; // 0..1
  def: number; // default position
  onPos: (p: number) => void;
  fmt?: (p: number) => string;
  gradient?: string;
  fill?: string;
  tip?: string;
  eye?: { on: boolean; set: (v: boolean) => void; tip?: string };
  disabled?: boolean;
  /** PAChannelRow letter (R/G/B). */
  compact?: string;
}

/** PAControlSlider: label + value on top, slider below (or a PAChannelRow when `compact`). Double-click resets. */
function paSlider(o: SliderOpts): HTMLElement {
  const fmt = o.fmt ?? pct;
  const input = h('input.pa-range', { type: 'range', min: '0', max: '1000', step: '1', disabled: o.disabled }) as HTMLInputElement;
  const val = h('span.pa-val', fmt(o.pos));
  const paint = (p: number) => {
    input.style.setProperty('--p', `${clampN(p, 0, 1) * 100}%`);
    val.textContent = fmt(p);
  };
  input.value = String(Math.round(clampN(o.pos, 0, 1) * 1000));
  paint(o.pos);
  if (o.gradient) {
    input.classList.add('gradient');
    input.style.setProperty('--grad', o.gradient);
  }
  if (o.fill) input.style.setProperty('--fill', o.fill);
  input.addEventListener('input', () => {
    const p = Number(input.value) / 1000;
    paint(p);
    o.onPos(p);
  });
  const reset = () => {
    input.value = String(Math.round(o.def * 1000));
    paint(o.def);
    o.onPos(o.def);
  };
  input.addEventListener('dblclick', reset);
  const tip = o.tip ?? `Reset to default (${fmt(o.def)})`;
  input.title = tip;
  if (o.compact) return h('div.pa-channel', h('span.pa-ch', { style: `color:${o.fill}` }, o.compact), input);
  const lab = h('span.pa-label', { title: tip }, o.label);
  lab.addEventListener('dblclick', reset);
  let eye: HTMLElement | null = null;
  if (o.eye) {
    const ey = o.eye;
    const b = h('button.pa-eye', { title: ey.tip ?? (ey.on ? 'Hide guide' : 'Show guide'), disabled: o.disabled }) as HTMLButtonElement;
    b.append(svgIcon(ey.on ? 'eye' : 'eye.slash'));
    b.classList.toggle('on', ey.on);
    b.addEventListener('click', () => ey.set(!ey.on));
    eye = b;
  }
  return h('div.pa-slider', { class: o.disabled ? 'disabled' : '' }, h('div.pa-row', lab, eye, h('span.pa-spacer'), val), input);
}

function section(id: string, title: string, body: (HTMLElement | null)[], opts: { reset?: () => void; tip?: string } = {}): HTMLElement {
  const collapsed = ui.collapsed.has(id);
  const head = h('button.pa-section-head', { title: opts.tip }, svgIcon(collapsed ? 'chevron.right' : 'chevron.down', 'pa-chev'), h('span', title));
  head.addEventListener('click', () => {
    collapsed ? ui.collapsed.delete(id) : ui.collapsed.add(id);
    persistUi();
    renderPanel();
  });
  const right = h('span.pa-head-right');
  if (opts.reset) {
    const r = h('button.pa-reset', { title: `Reset ${title}` }, svgIcon('reset')) as HTMLButtonElement;
    r.addEventListener('click', opts.reset);
    right.append(r);
  }
  return h('section.pa-section', { class: collapsed ? 'collapsed' : '' }, h('div.pa-head', head, right), collapsed ? null : h('div.pa-body', ...body));
}

/** PAControlToggle. */
function paToggle(label: string, on: boolean, set: (v: boolean) => void, tip?: string, disabled = false): HTMLElement {
  const input = h('input', { type: 'checkbox', disabled }) as HTMLInputElement;
  input.checked = on;
  input.addEventListener('change', () => set(input.checked));
  return h('label.pa-toggle', { title: tip, class: disabled ? 'disabled' : '' }, h('span.pa-label', label), h('span.pa-spacer'), h('span.switch', input, h('span')));
}

function paSegmented(label: string, opts: { value: string; label: string; disabled?: boolean; title?: string }[], value: string, set: (v: string) => void, tip?: string, resetTip?: string, def?: string): HTMLElement {
  const seg = h('div.pa-seg');
  for (const o of opts) {
    const b = h('button', { disabled: o.disabled, title: o.title }, o.label) as HTMLButtonElement;
    b.classList.toggle('active', o.value === value);
    b.addEventListener('click', () => set(o.value));
    seg.append(b);
  }
  const lab = h('span.pa-label', { title: tip ?? (resetTip ? `${resetTip} (double-click)` : undefined) }, label);
  if (def !== undefined) lab.addEventListener('dblclick', () => set(def));
  return h('div.pa-field', { title: tip }, lab, seg);
}

function paPopup(label: string, opts: { value: string; label: string }[], value: string, set: (v: string) => void, tip?: string): HTMLElement {
  const p = popup(opts, value, set, { cls: 'pa-popup', title: tip });
  return h('div.pa-field', h('span.pa-label', { title: tip }, label), p.el);
}

/** PAStableTextField. */
function paText(label: string, value: string, placeholder: string, set: (v: string) => void): HTMLElement {
  const input = h('input.field.pa-text', { type: 'text', placeholder, spellcheck: 'false', title: 'Press Enter to save, Esc to cancel' }) as HTMLInputElement;
  input.value = value;
  input.addEventListener('input', () => set(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = value;
      set(value);
      input.blur();
    }
  });
  return h('div.pa-field', h('span.pa-label', label), input);
}

/** PAOverlayColorRow. */
function paColor(label: string, value: string, set: (v: string) => void, alpha?: { value: number; set: (v: number) => void }): HTMLElement {
  const input = h('input.pa-color', { type: 'color' }) as HTMLInputElement;
  input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  input.addEventListener('input', () => set(input.value));
  const row = h('div.pa-color-row', h('span.pa-label', label), h('span.pa-spacer'), input);
  if (!alpha) return row;
  return h('div', row, paSlider({ label: 'Opacity', pos: alpha.value, def: 0.78, onPos: alpha.set }));
}

// ---------------------------------------------------------------------------
// tone curve (PAToneCurveEditor / PAToneCurveCanvas)
// ---------------------------------------------------------------------------
let lutCache: { key: string; lut: Uint8Array } = { key: '', lut: new Uint8Array(256) };
function curveSample(p: [number, number][]): number[] {
  // The same LUT the renderer uses, so the editor shows exactly what renders.
  const key = JSON.stringify(p);
  if (key !== lutCache.key) lutCache = { key, lut: toneLut(p) };
  return Array.from(lutCache.lut).map((v) => v / 255);
}

function toneCurveEditor(): HTMLElement {
  const c = h('canvas.pa-curve') as HTMLCanvasElement;
  const pts = () => (ui.draft.toneCurve ?? DEFAULT_EFFECTS.toneCurve!).map((p) => [p[0], p[1]] as [number, number]);
  const M = 7;
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, Math.round(c.clientWidth * dpr));
    const H = Math.max(10, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    const m = M * dpr;
    const iw = W - 2 * m;
    const ih = H - 2 * m;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = dpr;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(m + (iw * i) / 4, m);
      ctx.lineTo(m + (iw * i) / 4, m + ih);
      ctx.moveTo(m, m + (ih * i) / 4);
      ctx.lineTo(m + iw, m + (ih * i) / 4);
      ctx.stroke();
    }
    const p = pts();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    const lut = curveSample(p);
    lut.forEach((y, i) => {
      const X = m + (i / (lut.length - 1)) * iw;
      const Y = m + (1 - y) * ih;
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of p) {
      ctx.beginPath();
      ctx.arc(m + x * iw, m + (1 - y) * ih, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  let dragI = -1;
  const toPt = (ev: PointerEvent): [number, number] => {
    const r = c.getBoundingClientRect();
    return [clampN((ev.clientX - r.left - M) / (r.width - 2 * M), 0, 1), clampN(1 - (ev.clientY - r.top - M) / (r.height - 2 * M), 0, 1)];
  };
  c.addEventListener('pointerdown', (ev) => {
    const [x, y] = toPt(ev);
    let best = -1;
    let bd = 0.08;
    pts().forEach(([px, py], i) => {
      const d = Math.hypot(px - x, py - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best >= 0) {
      dragI = best;
      c.setPointerCapture(ev.pointerId);
    }
  });
  c.addEventListener('pointermove', (ev) => {
    if (dragI < 0) return;
    const [x, y] = toPt(ev);
    const p = pts();
    const n = p.length;
    const lo = dragI === 0 ? 0 : p[dragI - 1][0] + 0.02;
    const hi = dragI === n - 1 ? 1 : p[dragI + 1][0] - 0.02;
    p[dragI] = [dragI === 0 ? 0 : dragI === n - 1 ? 1 : clampN(x, lo, hi), y];
    setE({ toneCurve: p });
    draw();
  });
  c.addEventListener('pointerup', () => (dragI = -1));
  c.addEventListener('dblclick', () => {
    setE({ toneCurve: structuredClone(DEFAULT_EFFECTS.toneCurve!) });
    draw();
  });
  new ResizeObserver(draw).observe(c);
  return h('div.pa-curve-wrap', { title: 'Drag points to shape the curve. Double-click to reset.' }, c);
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
const bip = (v: number | undefined) => ((v ?? 0) + 1) / 2;
const unbip = (p: number) => Math.round((p * 2 - 1) * 1000) / 1000;

function colorTab(): HTMLElement[] {
  const e = ui.draft;
  return [
    section(
      'adjustments',
      'Adjustments',
      [
        paSlider({ label: 'Exposure', pos: bip(e.exposure), def: 0.5, onPos: (p) => setE({ exposure: unbip(p) }) }),
        paSlider({ label: 'Contrast', pos: (e.contrast ?? 1) / 2, def: 0.5, onPos: (p) => setE({ contrast: Math.round(p * 2000) / 1000 }) }),
        paSlider({ label: 'Vibrance', pos: bip(e.vibrance), def: 0.5, onPos: (p) => setE({ vibrance: unbip(p) }) }),
        paSlider({ label: 'Sharpness', pos: e.sharpness ?? 0, def: 0, onPos: (p) => setE({ sharpness: p }) }),
        paSlider({
          label: 'Temperature',
          pos: ((e.whiteBalanceK ?? 6500) - WB_MIN_K) / (WB_MAX_K - WB_MIN_K),
          def: (6500 - WB_MIN_K) / (WB_MAX_K - WB_MIN_K),
          gradient: 'linear-gradient(90deg,#5b6cf0,#b9c6ff 40%,#ffffff 53%,#ffd9a0 72%,#ffb347)',
          onPos: (p) => setE({ whiteBalanceK: Math.round(WB_MIN_K + p * (WB_MAX_K - WB_MIN_K)) }),
        }),
        paSlider({ label: 'Tint', pos: bip(e.tint), def: 0.5, gradient: 'linear-gradient(90deg,#3fd24a,#d4f5cf 42%,#ffffff 50%,#f5c8f0 58%,#e04ad8)', onPos: (p) => setE({ tint: unbip(p) }) }),
      ],
      { reset: () => resetKeys(['exposure', 'contrast', 'vibrance', 'sharpness', 'whiteBalanceK', 'temperature', 'tint']) },
    ),
    section(
      'advanced',
      'Advanced',
      [
        paSlider({ label: 'Saturation', pos: (e.saturation ?? 1) / 2, def: 0.5, onPos: (p) => setE({ saturation: Math.round(p * 2000) / 1000 }) }),
        paSlider({ label: 'Highlights', pos: bip(e.highlights), def: 0.5, onPos: (p) => setE({ highlights: unbip(p) }) }),
        paSlider({ label: 'Shadows', pos: bip(e.shadows), def: 0.5, onPos: (p) => setE({ shadows: unbip(p) }) }),
        paSlider({ label: 'Vignette', pos: e.vignette ?? 0, def: 0, onPos: (p) => setE({ vignette: p }) }),
        h('div.pa-subhead', 'Tone curve'),
        toneCurveEditor(),
        h('div.pa-subhead', 'Lift (Shadows)'),
        ...lggRows(['liftR', 'liftG', 'liftB']),
        h('div.pa-subhead', 'Gamma (Mids)'),
        ...lggRows(['gammaR', 'gammaG', 'gammaB']),
        h('div.pa-subhead', 'Gain (Highlights)'),
        ...lggRows(['gainR', 'gainG', 'gainB']),
      ],
      { reset: () => resetKeys(['saturation', 'highlights', 'shadows', 'vignette', 'toneCurve', 'liftR', 'liftG', 'liftB', 'gammaR', 'gammaG', 'gammaB', 'gainR', 'gainG', 'gainB']) },
    ),
    h('div.pa-reset-all', resetAllButton('All', COLOR_KEYS)),
  ];
}

/** PAColorGradingControl: three PAChannelRows. */
function lggRows(keys: [keyof OutputEffects, keyof OutputEffects, keyof OutputEffects]): HTMLElement[] {
  const e = ui.draft;
  return (['R', 'G', 'B'] as const).map((ch, i) =>
    paSlider({ label: ch, compact: ch, fill: ['#e5484d', '#30a46c', '#3e8ef7'][i], pos: bip(e[keys[i]] as number), def: 0.5, onPos: (p) => setE({ [keys[i]]: unbip(p) }) }),
  );
}

function resetAllButton(label: string, keys: (keyof OutputEffects)[], extra?: () => void): HTMLElement {
  const b = h('button.btn.sm', `Reset ${label}`) as HTMLButtonElement;
  b.addEventListener('click', () => {
    extra?.();
    resetKeys(keys);
  });
  return b;
}

function croppingTab(): HTMLElement[] {
  const e = ui.draft;
  const a = ui.auto;
  const supported = autoCropSupported();
  const manualDisabled = !!a.autoCropEnabled && supported;
  const acDis = !supported || !a.autoCropEnabled;
  const acTip = supported ? undefined : AUTO_CROP_UNSUPPORTED;
  const resetCrop = h('button.btn.sm', 'Reset crop') as HTMLButtonElement;
  resetCrop.addEventListener('click', () => resetKeys(CROP_KEYS));
  return [
    h(
      'div.pa-block',
      paSegmented(
        'Preview mode',
        CROP_PREVIEW_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ui.previewMode,
        (v) => {
          ui.previewMode = v as PreviewMode;
          ui.dirtyRender = true;
          renderPanel();
        },
      ),
    ),
    section(
      'manual',
      'Manual transform',
      [
        paSlider({ label: 'Scale', pos: ((e.cropZoom ?? 1) - 1) / 4, def: 0, fmt: (p) => `${(1 + p * 4).toFixed(2)}×`, disabled: manualDisabled, onPos: (p) => setE({ cropZoom: Math.round((1 + p * 4) * 1000) / 1000 }) }),
        paSlider({ label: 'Position X', pos: bip(e.cropPanX), def: 0.5, disabled: manualDisabled, onPos: (p) => setE({ cropPanX: unbip(p) }) }),
        paSlider({ label: 'Pan Y', pos: bip(e.cropPanY), def: 0.5, disabled: manualDisabled, onPos: (p) => setE({ cropPanY: unbip(p) }) }),
        paSlider({ label: 'Rotation', pos: ((e.cropRotation ?? 0) + 180) / 360, def: 0.5, fmt: (p) => `${Math.round(p * 360 - 180)}°`, onPos: (p) => setE({ cropRotation: Math.round(p * 360 - 180) }) }),
        paToggle('Mirror', !!e.mirror, (v) => setE({ mirror: v })),
        h('div.pa-actions', resetCrop),
      ],
      { reset: () => resetKeys(CROP_KEYS) },
    ),
    section(
      'autocrop',
      'Auto-cropping',
      [
        paToggle('Enabled', !!a.autoCropEnabled && supported, (v) => setA({ autoCropEnabled: v }, true), acTip, !supported),
        paToggle('Show guides', !!a.autoCropShowGuides, (v) => setA({ autoCropShowGuides: v }, true), acTip, acDis),
        paToggle(a.autoCropShowFaceGuides ? 'Hide face guides' : 'Show face guides', !!a.autoCropShowFaceGuides, (v) => setA({ autoCropShowFaceGuides: v }, true), acTip, acDis),
        paSlider({
          label: 'Target size',
          pos: a.autoCropTargetSize,
          def: 0.35,
          disabled: acDis,
          tip: acTip ?? 'How tall the face should be in the frame. Auto-crop zooms until the face matches this size, or until the frame bounds (plus any overscan) are reached.',
          eye: { on: !!a.autoCropShowTargetSizeGuide, set: (v) => setA({ autoCropShowTargetSizeGuide: v }, true) },
          onPos: (p) => setA({ autoCropTargetSize: p }),
        }),
        paSlider({ label: 'Target vertical', pos: a.autoCropTargetVertical, def: 0.4, disabled: acDis, tip: acTip, onPos: (p) => setA({ autoCropTargetVertical: p }) }),
        paSegmented(
          'Responsiveness',
          AUTO_CROP_RESPONSIVENESS_OPTIONS.map((o) => ({ value: o.value, label: o.label, disabled: acDis })),
          a.autoCropResponsiveness,
          (v) => setA({ autoCropResponsiveness: v as AutoCropResponsiveness }, true),
          acTip ??
            'How far the face can drift before the shot follows, and how quickly it recenters. Low waits for a large move. High follows smaller head movements. Every setting eases in, moves faster when the face is far from the target, and slows down as it gets close.',
        ),
        paToggle('Crop past horizontal bounds', !!a.autoCropExtendHorizontal, (v) => setA({ autoCropExtendHorizontal: v }, true), acTip, acDis),
        a.autoCropExtendHorizontal
          ? paSlider({ label: 'Horizontal amount', pos: a.autoCropOverscanHorizontal, def: 0.1, disabled: acDis, eye: { on: !!a.autoCropShowOverscanHorizontalGuide, set: (v) => setA({ autoCropShowOverscanHorizontalGuide: v }, true) }, onPos: (p) => setA({ autoCropOverscanHorizontal: p }) })
          : null,
        paToggle('Crop past vertical bounds', !!a.autoCropExtendVertical, (v) => setA({ autoCropExtendVertical: v }, true), acTip, acDis),
        a.autoCropExtendVertical
          ? paSlider({ label: 'Vertical amount', pos: a.autoCropOverscanVertical, def: 0.1, disabled: acDis, eye: { on: !!a.autoCropShowOverscanVerticalGuide, set: (v) => setA({ autoCropShowOverscanVerticalGuide: v }, true) }, onPos: (p) => setA({ autoCropOverscanVertical: p }) })
          : null,
        paToggle(
          'Zoom out when no face',
          a.autoCropZoomOutOnLostFace !== false,
          (v) => setA({ autoCropZoomOutOnLostFace: v }, true),
          acTip ?? 'When on, the shot eases back to the full frame 3.5 seconds after the face disappears. When off, the last shot holds until a face returns.',
          acDis,
        ),
      ],
      { tip: acTip },
    ),
  ];
}

function layerLabel(ref: OverlayLayerRef): string {
  if (ref === 'nameTag') return 'Name tag';
  const img = (ui.draft.images ?? []).find((i) => `image:${i.id}` === ref);
  return img ? img.filename || img.path.split(/[\\/]/).pop() || 'Image' : 'Image';
}

function moveLayer(ref: OverlayLayerRef, dir: 1 | -1): void {
  const order = layerOrder(ui.draft);
  const i = order.indexOf(ref);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  setE({ overlayLayerOrder: order, images: (ui.draft.images ?? []).map((im) => ({ ...im, zIndex: order.indexOf(`image:${im.id}`) })) }, true);
}

async function addImage(): Promise<void> {
  const path = await api.pickFile('image');
  if (!path) return;
  const id = (crypto.randomUUID?.() ?? String(Date.now())).toLowerCase();
  const el = new Image();
  const aspect = await new Promise<number>((res) => {
    el.onload = () => res(el.naturalWidth / Math.max(1, el.naturalHeight));
    el.onerror = () => res(1);
    el.src = fileUrl(path);
  });
  overlayImgs.set(path, el);
  const order = layerOrder(ui.draft);
  order.push(`image:${id}`);
  const img: OverlayImage = { id, path, x: 0.5, y: 0.5, scale: 0.25, opacity: 1, visible: true, rotation: 0, zIndex: order.length - 1, filename: path.split(/[\\/]/).pop(), aspect };
  ui.editing = id;
  setE({ images: [...(ui.draft.images ?? []), img], overlayLayerOrder: order }, true);
}

async function removeImage(id: string): Promise<void> {
  if (!(await confirmSheet('Remove overlay', 'Are you sure you want to delete this overlay image?', 'Delete', true))) return;
  if (ui.editing === id) ui.editing = null;
  setE({ images: (ui.draft.images ?? []).filter((i) => i.id !== id), overlayLayerOrder: layerOrder(ui.draft).filter((r) => r !== `image:${id}`) }, true);
}

function overlaysTab(): HTMLElement[] {
  const e = ui.draft;
  const manual = e.nameTagNameMode === 'manual';
  const nameTag = section(
    'nametag',
    'Name tag',
    [
      paToggle('Show name tag', !!e.nameTag, (v) => setE({ nameTag: v }, true)),
      paSegmented('Name tag mode', NAME_TAG_NAME_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label })), e.nameTagNameMode ?? 'auto', (v) => setE({ nameTagNameMode: v as 'auto' | 'manual' }, true)),
      manual ? paText('Participant name', e.nameTagText, 'Participant name', (v) => setE({ nameTagText: v })) : null,
      paText('Subtitle', e.nameTagSubtitle, 'Enter subtitle', (v) => setE({ nameTagSubtitle: v })),
      paPopup('Name tag font', NAME_TAG_FONT_OPTIONS.map((o) => ({ value: o.value, label: o.label })), e.nameTagFont ?? 'helvetica', (v) => setE({ nameTagFont: v as NameTagFont }, true)),
      paSlider({ label: 'Name tag size', pos: ((e.nameTagSize ?? 100) - 50) / 200, def: 0.25, fmt: (p) => `${Math.round(50 + p * 200)}%`, onPos: (p) => setE({ nameTagSize: Math.round(50 + p * 200) }) }),
      paSlider({ label: 'Name tag position', pos: e.nameTagOffset ?? 0.85, def: 0.85, onPos: (p) => setE({ nameTagOffset: p }) }),
      paSegmented('Name tag placement', NAME_TAG_PLACEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label })), e.nameTagPlacement ?? 'left', (v) => setE({ nameTagPlacement: v as 'left' }, true), undefined, 'Reset name tag placement', 'left'),
      paSegmented('Text alignment', NAME_TAG_ALIGNMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label })), e.nameTagTextAlignment ?? 'left', (v) => setE({ nameTagTextAlignment: v as 'left' }, true), undefined, 'Reset text alignment', 'left'),
      paColor('Name text color', e.nameTagColor ?? '#ffffff', (v) => setE({ nameTagColor: v })),
      paColor('Name tag background color', e.nameTagBg ?? '#000000', (v) => setE({ nameTagBg: v }), { value: e.nameTagBgOpacity ?? 0.78, set: (v) => setE({ nameTagBgOpacity: v }) }),
      paSlider({ label: 'Corner radius', pos: (e.nameTagCornerRadius ?? 6) / 40, def: 6 / 40, fmt: (p) => `${Math.round(p * 40)}`, onPos: (p) => setE({ nameTagCornerRadius: Math.round(p * 40) }) }),
    ],
    { reset: () => resetKeys(NAME_TAG_KEYS) },
  );

  // Layers, top first; the selected image expands with its controls.
  const order = layerOrder(e).slice().reverse();
  const rows: HTMLElement[] = order.map((ref, idx) => {
    const isTag = ref === 'nameTag';
    const img = isTag ? null : ((e.images ?? []).find((i) => `image:${i.id}` === ref) ?? null);
    const key = isTag ? 'nameTag' : (img?.id ?? '');
    const sel = ui.editing === key;
    const vis = isTag ? !!e.nameTag : !!img?.visible;
    const eye = h('button.pa-eye', { title: vis ? 'Hide' : 'Show' }) as HTMLButtonElement;
    eye.append(svgIcon(vis ? 'eye' : 'eye.slash'));
    eye.classList.toggle('on', vis);
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (isTag) setE({ nameTag: !vis }, true);
      else if (img) updImage(img.id, { visible: !vis }, true);
    });
    const up = h('button.pa-mini', { title: 'Move layer up', disabled: idx === 0 }, svgIcon('chevron.up')) as HTMLButtonElement;
    up.addEventListener('click', (ev) => {
      ev.stopPropagation();
      moveLayer(ref, 1);
    });
    const down = h('button.pa-mini', { title: 'Move layer down', disabled: idx === order.length - 1 }, svgIcon('chevron.down')) as HTMLButtonElement;
    down.addEventListener('click', (ev) => {
      ev.stopPropagation();
      moveLayer(ref, -1);
    });
    let del: HTMLElement | null = null;
    if (img) {
      const b = h('button.pa-mini', { title: 'Remove overlay' }, svgIcon('xmark')) as HTMLButtonElement;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void removeImage(img.id);
      });
      del = b;
    }
    const thumb = img ? h('img.pa-layer-thumb', { src: fileUrl(img.path), alt: '' }) : h('span.pa-layer-thumb.tag', 'Aa');
    const head = h('div.pa-layer', { class: sel ? 'selected' : '' }, thumb, h('span.pa-layer-name', layerLabel(ref)), h('span.pa-spacer'), eye, up, down, del);
    head.addEventListener('click', () => {
      ui.editing = sel ? null : key;
      ui.dirtyRender = true;
      renderPanel();
    });
    if (!sel || !img) return head;
    const i = img;
    return h(
      'div.pa-layer-group',
      head,
      h(
        'div.pa-layer-body',
        paSlider({ label: 'Opacity', pos: i.opacity, def: 1, onPos: (p) => updImage(i.id, { opacity: p }) }),
        paSlider({ label: 'Scale', pos: clampN(i.scale / 2, 0, 1), def: 0.125, fmt: (p) => `${Math.round(p * 200)}%`, onPos: (p) => updImage(i.id, { scale: Math.max(0.01, p * 2) }) }),
        paSlider({ label: 'Position X', pos: clampN(i.x, 0, 1), def: 0.5, onPos: (p) => updImage(i.id, { x: p }) }),
        paSlider({ label: 'Pan Y', pos: clampN(i.y, 0, 1), def: 0.5, onPos: (p) => updImage(i.id, { y: p }) }),
        paSlider({ label: 'Rotation', pos: ((i.rotation ?? 0) + 180) / 360, def: 0.5, fmt: (p) => `${Math.round(p * 360 - 180)}°`, onPos: (p) => updImage(i.id, { rotation: Math.round(p * 360 - 180) }) }),
      ),
    );
  });
  const addBtn = h('button.btn.sm', 'Add image') as HTMLButtonElement;
  addBtn.addEventListener('click', () => void addImage());
  const delAll = h('button.btn.sm', { disabled: !(e.images ?? []).length }, 'Delete all images') as HTMLButtonElement;
  delAll.addEventListener('click', async () => {
    if (!(await confirmSheet('Delete all images', 'Are you sure you want to delete all overlay images?', 'Delete all', true))) return;
    ui.editing = null;
    setE({ images: [], overlayLayerOrder: ['nameTag'] }, true);
  });
  const layers = section('layers', 'Layers', [h('div.pa-layers', ...rows), h('div.pa-actions', addBtn, delAll)], {
    tip: 'Drag images in the preview to move them; drag a corner to scale, the top handle to rotate (Shift snaps to 15°).',
  });
  return [nameTag, layers, h('div.pa-reset-all', resetAllButton('Overlays', OVERLAY_KEYS, () => (ui.editing = null)))];
}

const TAB_ICON: Record<Tab, string> = { color: 'sliders', cropping: 'crop', overlays: 'layers' };
function renderTabs(): void {
  els.tabs.replaceChildren(
    ...(['color', 'cropping', 'overlays'] as Tab[]).map((t) => {
      const label = t === 'color' ? 'Color' : t === 'cropping' ? 'Cropping' : 'Overlays';
      const b = h('button.fx-tab', { class: ui.tab === t ? 'active' : '' }, svgIcon(TAB_ICON[t]), h('span', label)) as HTMLButtonElement;
      b.addEventListener('click', () => {
        ui.tab = t;
        persistUi();
        renderTabs();
        renderPanel();
      });
      return b;
    }),
  );
}

function renderPanel(): void {
  const st = els.scroll.scrollTop;
  const body = ui.tab === 'color' ? colorTab() : ui.tab === 'cropping' ? croppingTab() : overlaysTab();
  els.scroll.replaceChildren(...body);
  els.scroll.scrollTop = st;
  ui.dirtyRender = true;
}

// ---------------------------------------------------------------------------
// footer: Auto Apply, Save/Load preset, Apply
// ---------------------------------------------------------------------------
function renderFooter(): void {
  const autoApply = !!ui.draft.autoApply;
  const auto = h('input', { type: 'checkbox' }) as HTMLInputElement;
  auto.checked = autoApply;
  auto.addEventListener('change', () => {
    ui.draft = { ...ui.draft, autoApply: auto.checked };
    apply();
  });
  const isDirty = dirty();
  const save = h('button.fx-foot-icon', { title: 'Save preset' }, svgIcon('tray.down')) as HTMLButtonElement;
  save.addEventListener('click', savePreset);
  const load = h('button.fx-foot-icon', { title: 'Load preset' }, svgIcon('folder')) as HTMLButtonElement;
  load.addEventListener('click', loadPreset);
  const applyBtn = h('button.fx-apply', { disabled: autoApply || !isDirty, title: autoApply ? 'Changes are applied automatically' : 'Apply settings to video output' }, svgIcon('checkmark'), h('span', 'Apply')) as HTMLButtonElement;
  applyBtn.addEventListener('click', apply);
  els.footer.replaceChildren(
    h('label.fx-autoapply', { title: autoApply ? 'Changes are applied automatically' : 'Apply changes to the output as you edit' }, auto, h('span', 'Auto apply')),
    h('span.fx-status', !autoApply && isDirty ? 'Unapplied changes' : ''),
    h('span.pa-spacer'),
    save,
    load,
    applyBtn,
  );
}

function savePreset(): void {
  const name = (cfg()?.name ?? 'output').replace(/[^\w.-]+/g, '_');
  const blob = new Blob([JSON.stringify({ kind: 'gmeet-iso-effects', version: 1, effects: ui.draft, autoCrop: ui.auto }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${name}-effects.json` }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

function loadPreset(): void {
  const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const j = JSON.parse(await file.text()) as { effects?: Partial<OutputEffects>; autoCrop?: Partial<AutoFields> };
      const keepAuto = ui.draft.autoApply;
      ui.draft = { ...fullEffects(j.effects ?? (j as Partial<OutputEffects>)), autoApply: keepAuto };
      ui.draft.nameTagFont = migrateNameTagFont(ui.draft.nameTagFont);
      if (j.autoCrop) ui.auto = { ...ui.auto, ...j.autoCrop };
      ui.editing = null;
      changed(true);
    } catch (err) {
      void confirmSheet('Load preset', `Couldn't read that preset: ${(err as Error).message}`, 'OK');
    }
  });
  input.click();
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
function renderAll(): void {
  document.title = `Output Effects — ${cfg()?.name ?? ''}`;
  renderPicker();
  renderToolbar();
  renderTabs();
  renderPanel();
  renderFooter();
  layoutViews();
}

let lastScope = 0;
let lastRenderAt = 0;
function loop(now: number): void {
  // Re-render on change / new frame, or ~15 fps while auto-crop eases.
  if (ui.dirtyRender || (tracker && now - lastRenderAt > 66)) {
    ui.dirtyRender = false;
    lastRenderAt = now;
    renderPreview();
  }
  if (ui.scopes.size && now - lastScope > 120) {
    lastScope = now;
    const px = lastSource ? samplePixels(els.canvas, 320) : null;
    for (const t of ui.scopes) drawScope(t, els.scopeTiles.get(t)!.canvas, px);
  }
  requestAnimationFrame(loop);
}

void initStore().then(() => {
  installWindowChrome();
  buildSkeleton();
  ui.id = windowArg() || store.settings.outputs[0]?.id || '';
  seedFrom(cfg());
  bindSources();
  renderAll();
  on('settings', () => {
    renderPicker();
    const o = cfg();
    if (!o && store.settings.outputs.length) {
      void switchTo(store.settings.outputs[0].id);
      return;
    }
    // Follow external edits (OSC, other windows) when nothing is pending here.
    const fresh = JSON.stringify({ e: fullEffects(o?.effects), a: autoFrom(o) });
    if (!dirty() && fresh !== ui.applied) {
      const editing = ui.editing;
      seedFrom(o);
      ui.editing = editing;
      if (!document.activeElement || !els.panel.contains(document.activeElement)) renderPanel();
      renderFooter();
    }
    ui.dirtyRender = true;
  });
  on('state', () => {
    rebindSrcThumb();
    ui.dirtyRender = true;
  });
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && !ui.draft.autoApply) apply();
  });
  (window as unknown as { __fx: unknown }).__fx = { ui, apply, switchTo, setTab: (t: Tab) => ((ui.tab = t), renderTabs(), renderPanel()), gl: () => (fx ? !fx.failed : null) };
  requestAnimationFrame(loop);
});
