// Shared overlay compositor (RE ProcAmp overlays): name tag + custom image overlays in
// layer order. Used by the output engine and the Output Effects preview, so both match.

import type { OutputEffects, OverlayImage, OverlayLayerRef } from '../../shared/types';
import { NAME_TAG_FONT_CSS, migrateNameTagFont } from '../../shared/types';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type ImageLookup = (img: OverlayImage) => (CanvasImageSource & { width: number; height: number }) | null;

/** Effective layer order, bottom → top. Unknown refs dropped, missing layers appended. */
export function layerOrder(e: Pick<OutputEffects, 'overlayLayerOrder' | 'images'>): OverlayLayerRef[] {
  const imgs = e.images ?? [];
  const valid = new Set<string>(['nameTag', ...imgs.map((i) => `image:${i.id}`)]);
  const out: OverlayLayerRef[] = [];
  for (const r of e.overlayLayerOrder ?? []) if (valid.has(r) && !out.includes(r)) out.push(r);
  if (!out.includes('nameTag')) out.push('nameTag');
  const missing = imgs.filter((i) => !out.includes(`image:${i.id}`)).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  for (const i of missing) out.push(`image:${i.id}`);
  return out;
}

/** Title shown in the name tag: manual text, else the participant's display name. */
export function nameTagTitle(e: OutputEffects, participantName: string): string {
  const manual = e.nameTagNameMode === 'manual' || (!e.nameTagNameMode && !!e.nameTagText);
  return manual ? e.nameTagText || '' : participantName;
}

export interface NameTagLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  sub: number;
  pad: number;
  font: string;
}

function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

export function nameTagLayout(ctx: Ctx, W: number, H: number, e: OutputEffects, title: string): NameTagLayout {
  const size = Math.max(6, Math.round(H * 0.045 * ((e.nameTagSize ?? 100) / 100)));
  const sub = Math.round(size * 0.7);
  const font = NAME_TAG_FONT_CSS[migrateNameTagFont(e.nameTagFont)];
  ctx.save();
  ctx.font = `600 ${size}px ${font}`;
  const tw = ctx.measureText(title).width;
  ctx.font = `400 ${sub}px ${font}`;
  const sw = e.nameTagSubtitle ? ctx.measureText(e.nameTagSubtitle).width : 0;
  ctx.restore();
  const pad = Math.round(size * 0.55);
  const w = Math.max(tw, sw) + pad * 2;
  const h = size + (e.nameTagSubtitle ? sub + size * 0.25 : 0) + pad * 1.2;
  const margin = Math.round(H * 0.05);
  const place = e.nameTagPlacement ?? (e.nameTagPosition?.endsWith('r') ? 'right' : e.nameTagPosition?.endsWith('c') ? 'center' : 'left');
  const x = place === 'right' ? W - margin - w : place === 'center' ? (W - w) / 2 : margin;
  const off = Math.max(0, Math.min(1, e.nameTagOffset ?? (e.nameTagPosition?.startsWith('t') ? 0 : 1)));
  const y = margin + off * Math.max(0, H - 2 * margin - h);
  return { x, y, w, h, size, sub, pad, font };
}

export function drawNameTag(ctx: Ctx, W: number, H: number, e: OutputEffects, title: string): NameTagLayout | null {
  if (!title) return null;
  const L = nameTagLayout(ctx, W, H, e, title);
  ctx.save();
  const r = Math.max(0, (e.nameTagCornerRadius ?? 0) * (H / 1080));
  ctx.fillStyle = hexA(e.nameTagBg ?? '#000000', e.nameTagBgOpacity ?? 0.78);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(L.x, L.y, L.w, L.h, Math.min(r, L.h / 2));
  else ctx.rect(L.x, L.y, L.w, L.h);
  ctx.fill();
  const align = e.nameTagTextAlignment ?? 'left';
  const tx = align === 'center' ? L.x + L.w / 2 : align === 'right' ? L.x + L.w - L.pad : L.x + L.pad;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillStyle = e.nameTagColor ?? '#ffffff';
  ctx.font = `600 ${L.size}px ${L.font}`;
  ctx.fillText(title, tx, L.y + L.pad * 0.6);
  if (e.nameTagSubtitle) {
    ctx.globalAlpha = 0.8;
    ctx.font = `400 ${L.sub}px ${L.font}`;
    ctx.fillText(e.nameTagSubtitle, tx, L.y + L.pad * 0.6 + L.size * 1.15);
  }
  ctx.restore();
  return L;
}

/** Image rect in output px: centre, size, rotation (rad). */
export function imageRect(img: OverlayImage, W: number, H: number, aspect: number): { cx: number; cy: number; w: number; h: number; rot: number } {
  const w = Math.max(1, img.scale * W);
  return { cx: img.x * W, cy: img.y * H, w, h: w / Math.max(0.01, aspect), rot: ((img.rotation ?? 0) * Math.PI) / 180 };
}

export function drawImageOverlay(ctx: Ctx, W: number, H: number, img: OverlayImage, bmp: CanvasImageSource & { width: number; height: number }): void {
  if (!img.visible || !bmp.width || !bmp.height) return;
  const r = imageRect(img, W, H, bmp.width / bmp.height);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, img.opacity ?? 1));
  ctx.translate(r.cx, r.cy);
  ctx.rotate(r.rot);
  ctx.drawImage(bmp, -r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
}

/** Draw every overlay layer bottom → top. */
export function drawOverlays(ctx: Ctx, W: number, H: number, e: OutputEffects, participantName: string, lookup: ImageLookup): void {
  const imgs = new Map((e.images ?? []).map((i) => [`image:${i.id}`, i]));
  for (const ref of layerOrder(e)) {
    if (ref === 'nameTag') {
      if (e.nameTag) drawNameTag(ctx, W, H, e, nameTagTitle(e, participantName));
      continue;
    }
    const img = imgs.get(ref);
    if (!img || !img.visible) continue;
    const bmp = lookup(img);
    if (bmp) drawImageOverlay(ctx, W, H, img, bmp);
  }
}
