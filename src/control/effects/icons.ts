// SF-Symbols-like line icons for the Output Effects window (16×16 viewBox, currentColor).

const P: Record<string, string> = {
  grid: '<path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  viewfinder: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M8 6v4M6 8h4"/>',
  person: '<circle cx="8" cy="5.2" r="2.3"/><path d="M3.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4"/>',
  safe: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><rect x="4.2" y="5.2" width="7.6" height="5.6" rx=".6" fill="currentColor" stroke="none" opacity=".8"/>',
  aspect: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M9.5 3v10"/>',
  histogram: '<path d="M2.5 13V9M5 13V5M7.5 13V7.5M10 13V3.5M12.5 13V8.5"/>',
  vectorscope: '<circle cx="8" cy="8" r="5.5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
  waveform: '<path d="M1.5 8.5h2.2l1.4-4 2.2 8 2-6.5 1.3 2.5h3.9"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  'eye.slash': '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5l11 11"/>',
  reset: '<path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/>',
  'chevron.right': '<path d="M6 3.5L10.5 8 6 12.5"/>',
  'chevron.down': '<path d="M3.5 6L8 10.5 12.5 6"/>',
  'chevron.up': '<path d="M3.5 10L8 5.5 12.5 10"/>',
  xmark: '<path d="M4 4l8 8M12 4l-8 8"/>',
  sliders: '<path d="M2 4.5h12M2 8h12M2 11.5h12"/><circle cx="10" cy="4.5" r="1.4" fill="currentColor"/><circle cx="5.5" cy="8" r="1.4" fill="currentColor"/><circle cx="9" cy="11.5" r="1.4" fill="currentColor"/>',
  crop: '<path d="M4.5 1.5v9.5a.5.5 0 0 0 .5.5h9.5M1.5 4.5H11a.5.5 0 0 1 .5.5v9.5"/>',
  layers: '<path d="M8 2l6 3.2-6 3.2-6-3.2z"/><path d="M2 8.2l6 3.2 6-3.2"/><path d="M2 11l6 3.2 6-3.2"/>',
  'tray.down': '<path d="M8 2v7M5 6.5L8 9.5l3-3"/><path d="M2 9.5v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/>',
  folder: '<path d="M1.8 4.2a1 1 0 0 1 1-1h3.3l1.4 1.5h5.7a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>',
  checkmark: '<path d="M3 8.5l3.2 3L13 4.5"/>',
};

export function svgIcon(name: string, cls = ''): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `fx-ico${cls ? ' ' + cls : ''}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = P[name] ?? '';
  return svg;
}
