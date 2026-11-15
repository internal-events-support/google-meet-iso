"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/control/kit.ts
  function h(sel, attrs, ...children) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) ?? [];
    const el = document.createElement(m[1] || "div");
    for (const part of (m[2] ?? "").match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
    if (attrs && (typeof attrs !== "object" || attrs instanceof Node)) {
      children.unshift(attrs);
    } else if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === void 0 || v === null || v === false) continue;
        if (k === "class") el.className += (el.className ? " " : "") + String(v);
        else if (k === "style") typeof v === "string" ? el.setAttribute("style", v) : Object.assign(el.style, v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k in el && typeof v !== "string") el[k] = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children) if (c !== null && c !== void 0 && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function reIconUrl(name) {
    const f = RE_ICON_FILES[name];
    return f ? `${RE_ASSET_BASE}/icons/${f}` : null;
  }
  function icon(name, cls = "") {
    const s = h("span.ico");
    if (RE_ICON_FILES[name]) s.className += " re-ico";
    if (cls) s.className += " " + cls;
    s.innerHTML = ICONS[name] ?? "";
    return s;
  }
  function popup(opts, value, onChange, extra = {}) {
    const sel = h("select", { title: extra.title });
    const wrap = h("label.popup", sel);
    if (extra.cls) wrap.className += " " + extra.cls;
    sel.addEventListener("change", () => onChange(sel.value));
    const api2 = {
      el: wrap,
      select: sel,
      set(options, v, disabled = false) {
        if (document.activeElement !== sel) {
          const html = renderOpts(options);
          if (sel.dataset.html !== html) {
            sel.innerHTML = html;
            sel.dataset.html = html;
          }
          sel.value = v;
          if (sel.value !== v && sel.options.length) sel.selectedIndex = 0;
        }
        sel.disabled = disabled;
        wrap.classList.toggle("disabled", disabled);
      }
    };
    api2.set(opts, value, !!extra.disabled);
    return api2;
  }
  function renderOpts(options) {
    return options.map(
      (o) => "group" in o ? `<optgroup label="${esc(o.group)}">${o.options.map(renderOpt).join("")}</optgroup>` : renderOpt(o)
    ).join("");
  }
  function renderOpt(o) {
    return `<option value="${esc(o.value)}"${o.disabled ? " disabled" : ""}>${esc(o.label)}</option>`;
  }
  function toggle(checked, onChange, extra = {}) {
    const input = h("input", { type: "checkbox", title: extra.title });
    input.checked = checked;
    input.disabled = !!extra.disabled;
    const el = h("label.switch", input, h("span"));
    if (extra.cls) el.className += " " + extra.cls;
    input.addEventListener("change", () => onChange(input.checked));
    return {
      el,
      input,
      set(v, disabled = false) {
        if (document.activeElement !== input) input.checked = v;
        input.disabled = disabled;
      }
    };
  }
  function button(label, onClick, cls = "", title = "") {
    const b = h("button.btn", { title: title || void 0 }, label);
    if (cls) b.className += " " + cls;
    b.addEventListener("click", onClick);
    return b;
  }
  function iconButton(name, onClick, title = "", cls = "") {
    const b = h("button.icon-btn", { title: title || void 0 }, icon(name));
    if (cls) b.className += " " + cls;
    b.addEventListener("click", onClick);
    return b;
  }
  function textField(value, onChange, extra = {}) {
    const input = h("input.field", { type: extra.type ?? "text", placeholder: extra.placeholder, spellcheck: "false" });
    if (extra.cls) input.className += " " + extra.cls;
    input.value = value;
    input.addEventListener(extra.live ? "input" : "change", () => onChange(input.value));
    input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
    return { el: input, set: (v) => document.activeElement !== input && (input.value = v) };
  }
  function stepper(value, onChange, min = 0, max = 99) {
    const input = h("input.field", { type: "text", inputmode: "numeric" });
    input.value = String(value);
    const clamp = (n) => Math.max(min, Math.min(max, Math.round(n)));
    const commit = (n) => {
      const v = clamp(n);
      input.value = String(v);
      onChange(v);
    };
    input.addEventListener("change", () => commit(Number(input.value) || 0));
    const dec = h("button", { title: "Remove" }, "\u2212");
    const inc = h("button", { title: "Add" }, "+");
    dec.addEventListener("click", () => commit(Number(input.value) - 1));
    inc.addEventListener("click", () => commit(Number(input.value) + 1));
    const el = h("span.stepper", input, h("span.seg", dec, inc));
    return { el, set: (v) => document.activeElement !== input && (input.value = String(v)) };
  }
  function segmented(items, value, onChange, cls = "") {
    const el = h("div.segmented");
    if (cls) el.className += " " + cls;
    const btns = items.map((it) => {
      const b = h("button", { title: it.title, dataset: { value: it.value } }, it.icon ? icon(it.icon) : null, it.label);
      b.addEventListener("click", () => onChange(it.value));
      el.append(b);
      return b;
    });
    const set = (v) => btns.forEach((b) => b.classList.toggle("active", b.dataset.value === v));
    set(value);
    return { el, set };
  }
  function meterV() {
    const i = h("i");
    const el = h("div.meter-v", i);
    return { el, set: (l) => i.style.height = `${Math.round(Math.min(1, Math.sqrt(Math.max(0, l))) * 100)}%` };
  }
  function meterH() {
    const i = h("i");
    const el = h("div.meter-h", i);
    return { el, set: (l) => i.style.width = `${Math.round(Math.min(1, Math.sqrt(Math.max(0, l))) * 100)}%` };
  }
  function popover(anchor, content, opts = {}) {
    closeCurrent?.();
    const layer = h("div.popover-layer");
    const pop = h("div.popover", content);
    if (opts.width) pop.style.width = `${opts.width}px`;
    document.body.append(layer, pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    let left = opts.align === "start" ? r.left : opts.align === "end" ? r.right - pw : r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
    pop.style.left = `${left}px`;
    pop.style.top = `${r.bottom + 10}px`;
    pop.style.setProperty("--arrow-x", `${r.left + r.width / 2 - left}px`);
    const close = () => {
      layer.remove();
      pop.remove();
      document.removeEventListener("keydown", onKey);
      if (closeCurrent === close) closeCurrent = null;
    };
    const onKey = (e) => e.key === "Escape" && close();
    layer.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    closeCurrent = close;
    return close;
  }
  function menu(anchor, items) {
    closeCurrent?.();
    const layer = h("div.popover-layer");
    const m = h("div.menu");
    for (const it of items) {
      if (!it) {
        m.append(h("hr"));
        continue;
      }
      const b = h("button", { disabled: it.disabled }, it.icon ? icon(it.icon) : null, it.label);
      if (it.destructive) b.classList.add("destructive");
      b.addEventListener("click", () => {
        close();
        it.onClick?.();
      });
      m.append(b);
    }
    document.body.append(layer, m);
    let x;
    let y;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = r.right - m.offsetWidth;
      y = r.bottom + 4;
    } else {
      x = anchor.x;
      y = anchor.y;
    }
    m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, x))}px`;
    m.style.top = `${Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, y))}px`;
    const close = () => {
      layer.remove();
      m.remove();
      if (closeCurrent === close) closeCurrent = null;
    };
    layer.addEventListener("mousedown", close);
    closeCurrent = close;
  }
  function confirmSheet(title, message, confirmLabel = "OK", destructive = false) {
    return new Promise((resolve) => {
      const done = (v) => {
        layer.remove();
        resolve(v);
      };
      const ok = button(confirmLabel, () => done(true), destructive ? "danger" : "primary");
      const layer = h("div.sheet-layer", h("div.sheet", h("h3", title), h("p", message), h("div.actions", button("Cancel", () => done(false)), ok)));
      document.body.append(layer);
      ok.focus();
    });
  }
  function promptSheet(title, value, confirmLabel = "OK") {
    return new Promise((resolve) => {
      const field2 = h("input.field", { style: "width:100%;margin-bottom:14px" });
      field2.value = value;
      const done = (v) => {
        layer.remove();
        resolve(v);
      };
      field2.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(field2.value);
        if (e.key === "Escape") done(null);
      });
      const layer = h("div.sheet-layer", h("div.sheet", h("h3", { style: "margin-bottom:12px" }, title), field2, h("div.actions", button("Cancel", () => done(null)), button(confirmLabel, () => done(field2.value), "primary"))));
      document.body.append(layer);
      field2.focus();
      field2.select();
    });
  }
  var S, F, ICONS, RE_ASSET_BASE, RE_ICON_FILES, RE_IMAGES, closeCurrent;
  var init_kit = __esm({
    "src/control/kit.ts"() {
      "use strict";
      S = (d, extra = "") => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
      F = (d) => `<svg viewBox="0 0 16 16" fill="currentColor">${d}</svg>`;
      ICONS = {
        gear: S('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"/><circle cx="8" cy="8" r="4.6"/>'),
        gearFill: F('<path d="M9.4 1.2l.4 1.6c.4.1.8.3 1.1.5l1.5-.8 1.2 1.2-.8 1.5c.2.3.4.7.5 1.1l1.6.4v1.7l-1.6.4c-.1.4-.3.8-.5 1.1l.8 1.5-1.2 1.2-1.5-.8c-.3.2-.7.4-1.1.5l-.4 1.6H7.7l-.4-1.6c-.4-.1-.8-.3-1.1-.5l-1.5.8-1.2-1.2.8-1.5c-.2-.3-.4-.7-.5-1.1l-1.6-.4V7.4l1.6-.4c.1-.4.3-.8.5-1.1l-.8-1.5 1.2-1.2 1.5.8c.3-.2.7-.4 1.1-.5l.4-1.6h1.7zM8.5 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/>'),
        record: S('<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>'),
        sliders: S('<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="10.5" cy="4" r="1.4" fill="var(--panel,#2b2b2b)"/><circle cx="5.5" cy="8" r="1.4" fill="var(--panel,#2b2b2b)"/><circle cx="9" cy="12" r="1.4" fill="var(--panel,#2b2b2b)"/>'),
        ellipsis: F('<circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/>'),
        plus: S('<path d="M8 3v10M3 8h10"/>'),
        minus: S('<path d="M3 8h10"/>'),
        x: S('<path d="M4 4l8 8M12 4l-8 8"/>'),
        check: S('<path d="m3.5 8.5 3 3 6-7"/>'),
        checkCircle: F('<path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.1 4.3a.7.7 0 0 0-1 .1L7.2 9.2 5.8 7.8a.7.7 0 1 0-1 1l2 2a.7.7 0 0 0 1-.1l3.4-4.4a.7.7 0 0 0-.1-1z"/>'),
        warn: F('<path d="M8.9 1.9a1 1 0 0 0-1.8 0L1.2 12.5A1 1 0 0 0 2.1 14h11.8a1 1 0 0 0 .9-1.5L8.9 1.9zM8 5c.4 0 .7.3.7.7v3.6a.7.7 0 0 1-1.4 0V5.7c0-.4.3-.7.7-.7zm0 7.4a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z"/>'),
        info: S('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.1"/>'),
        mic: S('<rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3v2"/>'),
        micSlash: S('<rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3v2M2 2l12 12" />'),
        video: S('<rect x="1.6" y="4" width="9" height="8" rx="1.6"/><path d="m10.6 7 3.8-2.2v6.4L10.6 9"/>'),
        videoSlash: S('<rect x="1.6" y="4" width="9" height="8" rx="1.6"/><path d="m10.6 7 3.8-2.2v6.4L10.6 9M1.5 2l12 12"/>'),
        chat: S('<path d="M2.2 3.5c0-.8.7-1.5 1.5-1.5h8.6c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5H6.5L3.5 13.8V11h.2c-.8 0-1.5-.7-1.5-1.5v-6z"/>'),
        headset: S('<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9" width="3" height="4.5" rx="1"/><rect x="11" y="9" width="3" height="4.5" rx="1"/>'),
        grid: F('<rect x="2" y="2" width="5.3" height="5.3" rx="1"/><rect x="8.7" y="2" width="5.3" height="5.3" rx="1"/><rect x="2" y="8.7" width="5.3" height="5.3" rx="1"/><rect x="8.7" y="8.7" width="5.3" height="5.3" rx="1"/>'),
        list: S('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.6" cy="4" r=".6" fill="currentColor"/><circle cx="2.6" cy="8" r=".6" fill="currentColor"/><circle cx="2.6" cy="12" r=".6" fill="currentColor"/>'),
        previews: S('<rect x="1.8" y="3" width="12.4" height="10" rx="1.5"/><path d="M8 3v10M1.8 8h12.4"/>'),
        preview: S('<rect x="1.8" y="3" width="12.4" height="10" rx="1.5"/><path d="m6.5 6 3.5 2-3.5 2z" fill="currentColor"/>'),
        person: F('<circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5z"/>'),
        personSquare: F('<path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4.5 12.5h7c0-2-1.6-3-3.5-3s-3.5 1-3.5 3z"/>'),
        people: F('<circle cx="5.5" cy="5" r="2.3"/><circle cx="11" cy="5.6" r="1.9"/><path d="M1 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4zM10.6 13.5c0-1.4-.5-2.6-1.4-3.4.6-.3 1.2-.4 1.8-.4 2.1 0 3.9 1.3 3.9 3.8z"/>'),
        screen: S('<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>'),
        share: S('<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M8 9V5M6 7l2-2 2 2M5.5 14h5"/>'),
        speaker: S('<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>'),
        waveform: S('<path d="M2 8h1M4.5 5v6M7 3v10M9.5 5.5v5M12 6.5v3M14 8h.5"/>'),
        chevronDown: S('<path d="m4 6 4 4 4-4"/>'),
        chevronRight: S('<path d="m6 4 4 4-4 4"/>'),
        chevronUpDown: S('<path d="m5 6 3-3 3 3M5 10l3 3 3-3"/>'),
        eye: S('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
        eyeSlash: S('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2 2l12 12"/>'),
        folder: S('<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>'),
        refresh: S('<path d="M13.5 8A5.5 5.5 0 1 1 11.8 4M13.5 2v3.3h-3.3"/>'),
        search: S('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>'),
        monitor: S('<rect x="1.5" y="2.5" width="13" height="9" rx="1.2"/><path d="M5 14h6"/>'),
        videoCam: F('<path d="M2.5 4h7a1.5 1.5 0 0 1 1.5 1.5V6l3-1.8v7.6L11 10v.5A1.5 1.5 0 0 1 9.5 12h-7A1.5 1.5 0 0 1 1 10.5v-5A1.5 1.5 0 0 1 2.5 4z"/>'),
        plusSquare: F('<path d="M3.5 1.5h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM8 4.5a.8.8 0 0 0-.8.8v1.9H5.3a.8.8 0 0 0 0 1.6h1.9v1.9a.8.8 0 0 0 1.6 0V8.8h1.9a.8.8 0 0 0 0-1.6H8.8V5.3A.8.8 0 0 0 8 4.5z"/>'),
        calendarStar: F('<path d="M2 4a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 4v8.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5zm6 2.2-.9 1.8-2 .3 1.5 1.4-.4 2 1.8-1 1.8 1-.4-2 1.5-1.4-2-.3z"/>'),
        ndi: S('<path d="M2 12V4l5 8V4M9.5 4v8h2a3 3 0 0 0 0-6h-2"/>'),
        osc: S('<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M10 4.5 6 11.5"/>'),
        doc: S('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5M6 8h4.5M6 10.5h4.5"/>'),
        videoLoss: S('<rect x="1.6" y="4" width="9" height="8" rx="1.6"/><path d="m10.6 7 3.8-2.2v6.4L10.6 9M4 8.5l1.5-1.5 1.5 1.5 1.5-1.5"/>'),
        crop: S('<path d="M4 1.5V12h10.5M1.5 4H12v10.5"/>'),
        layers: S('<path d="m8 2 6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3"/>'),
        palette: S('<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.3-.7 1-1.4-.3-.9.2-1.6 1.1-1.6h1.6c1.6 0 2.5-1 2.5-2.6C14.2 4.6 11.4 1.8 8 1.8z"/><circle cx="5" cy="7" r=".8" fill="currentColor"/><circle cx="7.5" cy="4.6" r=".8" fill="currentColor"/><circle cx="10.6" cy="5.3" r=".8" fill="currentColor"/>'),
        inbox: S('<path d="M2 9.5 3.5 3h9L14 9.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14"/>'),
        latch: S('<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9" width="3" height="4.5" rx="1"/><rect x="11" y="9" width="3" height="4.5" rx="1"/>'),
        hand: S('<path d="M5 8V3.5a1 1 0 0 1 2 0V7M7 7V2.5a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V8.5M11 6.5a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5h-.8A4.5 4.5 0 0 1 4 12.2L2.5 9.5a1 1 0 0 1 1.7-1L5 9.5"/>'),
        crown: F('<path d="M2 5l3 2.5L8 3l3 4.5L14 5l-1.2 7H3.2z"/>'),
        externalLink: S('<path d="M9 2.5h4.5V7M13.5 2.5 7 9M12 9.5V13H3V4h3.5"/>'),
        trash: S('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>'),
        copy: S('<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>'),
        pencil: S('<path d="m10.5 2.5 3 3L6 13H3v-3z"/>'),
        stop: F('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>'),
        play: F('<path d="M4.5 2.8v10.4L13 8z"/>'),
        ndiSource: S('<circle cx="8" cy="8" r="1.5" fill="currentColor"/><path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"/>')
      };
      RE_ASSET_BASE = "re-assets";
      RE_ICON_FILES = {
        audio: "audio.svg",
        "camera.outline": "camera.outline.svg",
        "camera.slash.outline": "camera.slash.outline.svg",
        "chat.outline": "chat.outline.svg",
        "mic.outline": "mic.outline.svg",
        "mic.slash.outline": "mic.slash.outline.svg",
        osc: "osc.svg",
        "slash.commands": "slash.commands.svg",
        "speaker.outline": "speaker.outline.svg",
        "headset.fill": "headset.fill@2x.png",
        "profile.small.fill": "profile.small.fill@2x.png",
        "record.large.fill": "record.large.fill@2x.png",
        "screenshare.fill": "screenshare.fill@2x.png",
        "speaker.fill": "speaker.fill@2x.png",
        "spotlight.fill": "spotlight.fill@2x.png",
        "events.fill": "zoom.events.fill@2x.png",
        "video.fill": "zoom.video.fill@2x.png"
      };
      RE_IMAGES = {
        testcard: `${RE_ASSET_BASE}/images/testcard.png`,
        colourbars: `${RE_ASSET_BASE}/images/colourbars.png`,
        watermark: `${RE_ASSET_BASE}/images/watermark.png`,
        profilePlaceholder: `${RE_ASSET_BASE}/images/profile-placeholder.png`,
        videoLoss: `${RE_ASSET_BASE}/images/video-loss.png`,
        frameGuide: `${RE_ASSET_BASE}/images/frame-guide.png`
      };
      ICONS.oscGlyph = ICONS.osc;
      for (const name of Object.keys(RE_ICON_FILES)) ICONS[name] = `<i style="-webkit-mask-image:url('${reIconUrl(name)}')"></i>`;
      closeCurrent = null;
    }
  });

  // src/control/store.ts
  function on(topic, fn) {
    if (!subs.has(topic)) subs.set(topic, /* @__PURE__ */ new Set());
    subs.get(topic).add(fn);
    return () => subs.get(topic)?.delete(fn);
  }
  function emit(topic) {
    for (const fn of subs.get(topic) ?? []) {
      try {
        fn();
      } catch (e) {
        console.error(`[${topic}]`, e);
      }
    }
  }
  function bindPreview(key, target) {
    const fn = typeof target === "function" ? target : (url) => target.src = url;
    if (!previewSubs.has(key)) previewSubs.set(key, /* @__PURE__ */ new Set());
    previewSubs.get(key).add(fn);
    const cur = previewUrls.get(key);
    if (cur) fn(cur);
    return () => previewSubs.get(key)?.delete(fn);
  }
  async function run(c) {
    const r = await api.command(c);
    if (!r.ok) {
      pushLog(`\u2716 ${c.cmd}: ${r.error}`);
      return void 0;
    }
    return r.result;
  }
  function updateOutput(id, patch) {
    return run({ cmd: "updateOutput", output: id, patch });
  }
  async function setSettings(patch) {
    store.settings = await api.setSettings(patch);
    emit("settings");
  }
  async function refreshNdi() {
    store.ndiSources = await api.ndiSources();
    emit("ndi");
  }
  function pushLog(line) {
    store.log.push(line);
    if (store.log.length > 2e3) store.log.splice(0, store.log.length - 2e3);
    emit("log");
  }
  function initStore() {
    if (started) return started;
    started = (async () => {
      store.settings = await api.getSettings();
      store.devices = await api.devices();
      store.system = await api.system();
      store.log = await api.logs();
      api.onSettings((s) => {
        store.settings = s;
        emit("settings");
      });
      api.onState((s) => {
        store.state = s;
        emit("state");
      });
      api.onDevices((d) => {
        store.devices = d;
        emit("devices");
      });
      api.onSystem((s) => {
        store.system = s;
        emit("system");
      });
      api.onLog(pushLog);
      api.onPreview((key, jpeg) => {
        const url = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
        const old = previewUrls.get(key);
        previewUrls.set(key, url);
        for (const fn of previewSubs.get(key) ?? []) fn(url);
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
      });
      void refreshNdi();
      setInterval(() => void refreshNdi(), 1e4);
    })();
    return started;
  }
  function outputState(id) {
    return store.state?.outputs.find((o) => o.id === id);
  }
  function inCall() {
    return store.state?.phase === "in-call";
  }
  var api, subs, store, previewUrls, previewSubs, started;
  var init_store = __esm({
    "src/control/store.ts"() {
      "use strict";
      api = window.gmeetIso;
      subs = /* @__PURE__ */ new Map();
      store = {
        settings: null,
        state: null,
        devices: { videoInputs: [], audioInputs: [], audioOutputs: [] },
        system: null,
        ndiSources: [],
        log: []
      };
      previewUrls = /* @__PURE__ */ new Map();
      previewSubs = /* @__PURE__ */ new Map();
      started = null;
    }
  });

  // src/control/recording.ts
  function isRecording() {
    return (store.state?.outputs ?? []).some((o) => o.recording) || store.settings.outputs.some((o) => o.record);
  }
  function openRecordingPopover(anchor) {
    if (isRecording()) {
      void confirmStop();
      return;
    }
    const list = h("div.rec-list");
    const warn = h("div.rec-warn");
    const startBtn = button("Start Recording", () => void start(), "rec-start");
    const selected = () => new Set(store.settings.recording.selectedOutputIds);
    const save = (ids) => void setSettings({ recording: { ...store.settings.recording, selectedOutputIds: store.settings.outputs.map((o) => o.id).filter((id) => ids.has(id)) } });
    const render = () => {
      const sel = selected();
      list.replaceChildren(
        ...store.settings.outputs.length ? store.settings.outputs.map((o) => {
          const input = h("input", { type: "checkbox" });
          input.checked = sel.has(o.id);
          input.addEventListener("change", () => {
            const s = selected();
            if (input.checked) s.add(o.id);
            else s.delete(o.id);
            save(s);
          });
          const el = h("label.check.rec-toggle", input, h("span", o.name));
          if (!o.enabled) el.title = "Output is disabled; it records once enabled.";
          return el;
        }) : [h("div.rec-empty", "No outputs")]
      );
      const any = store.settings.outputs.some((o) => sel.has(o.id));
      startBtn.disabled = !any || store.settings.engine === "disabled";
      startBtn.title = !any ? "No outputs selected for recording." : store.settings.engine === "disabled" ? "Enable capture to record." : "";
      const d = store.system?.disk;
      const lowPct = store.settings.recording.lowDiskWarningPercent;
      const free = d && d.totalGB ? d.freeGB / d.totalGB * 100 : 100;
      warn.textContent = free < lowPct ? `Low disk space (${d.freeGB.toFixed(1)} GB free)` : "";
      warn.hidden = !warn.textContent;
    };
    const start = async () => {
      const ids = store.settings.outputs.map((o) => o.id).filter((id) => selected().has(id));
      if (!ids.length) return;
      close();
      await run({ cmd: "startRecording", outputs: ids });
    };
    const content = h(
      "div.rec-pop",
      h("div.rec-title", "Select outputs for recording"),
      h("div.rec-row", button("Select All", () => save(new Set(store.settings.outputs.map((o) => o.id))), "rec-sm"), button("Deselect All", () => save(/* @__PURE__ */ new Set()), "rec-sm")),
      list,
      h("hr.rec-div"),
      warn,
      h("div.rec-row", button("Open Folder", () => void api.openPath("recordings"), "rec-md"), button("Recording Settings", () => {
        close();
        void api.openWindow("settings", "recording");
      }, "rec-md")),
      startBtn
    );
    const close = popover(anchor, content, { width: 260, align: "center" });
    const offs = [on("settings", render), on("system", render)];
    const obs = new MutationObserver(() => {
      if (!content.isConnected) {
        offs.forEach((f) => f());
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
    render();
  }
  async function confirmStop() {
    const n = (store.state?.outputs ?? []).filter((o) => o.recording).length || store.settings.outputs.filter((o) => o.record).length;
    const ok = await confirmSheet("Stop Recording?", `Are you sure you want to stop recording all ${n} output${n === 1 ? "" : "s"}?`, "Stop Recording", true);
    if (ok) await run({ cmd: "stopRecording" });
  }
  var init_recording = __esm({
    "src/control/recording.ts"() {
      "use strict";
      init_kit();
      init_store();
    }
  });

  // src/control/tabs/audio.ts
  function mountAudio(host) {
    host.append(h("div.empty", "Audio \u2014 not built yet"));
  }
  var init_audio = __esm({
    "src/control/tabs/audio.ts"() {
      "use strict";
      init_kit();
    }
  });

  // src/shared/types.ts
  function newOutput(n, prefix = "GMEET", patch = {}) {
    return {
      id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: `${prefix} ${n}`,
      enabled: true,
      mode: "auto",
      selection: null,
      format: { width: 1280, height: 720, fpsN: 3e4, fpsD: 1001 },
      lossMode: "black",
      lossImage: "",
      failover: "loss",
      audio: "iso",
      audioDelayMs: 0,
      audioGainDb: 0,
      effects: { ...DEFAULT_EFFECTS },
      record: false,
      display: null,
      isAutoAssign: true,
      useDefaultAudioMode: false,
      videoLoss: null,
      ...DEFAULT_AUTO_CROP,
      ...patch
    };
  }
  function defaultOutputs(prefix = "GMEET") {
    return [
      newOutput(1, prefix),
      newOutput(2, prefix),
      newOutput(3, prefix),
      newOutput(4, prefix),
      newOutput(5, prefix, { name: `${prefix} Screen`, mode: "screenshare", audio: "mix" }),
      newOutput(6, prefix, { name: `${prefix} Speaker`, mode: "activeSpeaker", audio: "mix" })
    ];
  }
  var DEFAULT_EFFECTS, DEFAULT_AUTO_CROP, FORMAT_PRESETS, DEFAULT_VIDEO_LOSS, DEFAULT_GLOBAL_VIDEO_LOSS, DEFAULT_RECORDING, DEFAULT_AUTO_ASSIGN, DEFAULT_INTERFACE, DEFAULT_ADVANCED_AUDIO, DEFAULT_EMBEDDED_AUDIO, DEFAULT_OSC, DEFAULT_SETTINGS, NOT_IN_MEET, OUTPUT_MODE_OPTIONS, EMBEDDED_AUDIO_OPTIONS, GAIN_REDUCTION_OPTIONS, NAME_TAG_PLACEMENT_OPTIONS, NAME_TAG_ALIGNMENT_OPTIONS, OUTPUT_ARRANGEMENT_OPTIONS;
  var init_types = __esm({
    "src/shared/types.ts"() {
      "use strict";
      DEFAULT_EFFECTS = {
        brightness: 1,
        contrast: 1,
        saturation: 1,
        hue: 0,
        zoom: 1,
        panX: 0,
        panY: 0,
        mirror: false,
        nameTag: false,
        nameTagText: "",
        nameTagSubtitle: "",
        nameTagPosition: "bl",
        exposure: 0,
        vibrance: 0,
        sharpness: 0,
        temperature: 0,
        tint: 0,
        highlights: 0,
        shadows: 0,
        vignette: 0,
        toneCurve: [
          [0, 0],
          [0.25, 0.25],
          [0.5, 0.5],
          [0.75, 0.75],
          [1, 1]
        ],
        liftR: 0,
        liftG: 0,
        liftB: 0,
        gammaR: 0,
        gammaG: 0,
        gammaB: 0,
        gainR: 0,
        gainG: 0,
        gainB: 0,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0,
        padBlack: true,
        nameTagSize: 100,
        nameTagFont: "helvetica",
        nameTagColor: "#ffffff",
        nameTagBg: "#0a0c10",
        nameTagBgOpacity: 0.78,
        nameTagAccent: "#3b82f6",
        images: [],
        whiteBalanceK: 6500,
        cropZoom: 1,
        cropPanX: 0,
        cropPanY: 0,
        cropRotation: 0,
        nameTagNameMode: "auto",
        nameTagPlacement: "left",
        nameTagTextAlignment: "left",
        nameTagCornerRadius: 6,
        nameTagOffset: 0.85,
        overlayLayerOrder: ["nameTag"],
        autoApply: true
      };
      DEFAULT_AUTO_CROP = {
        autoCropEnabled: false,
        autoCropShowGuides: false,
        autoCropShowFaceGuides: false,
        autoCropShowTargetSizeGuide: false,
        autoCropShowOverscanHorizontalGuide: false,
        autoCropShowOverscanVerticalGuide: false,
        autoCropTargetSize: 0.35,
        autoCropTargetVertical: 0.4,
        autoCropResponsiveness: "medium",
        autoCropExtendHorizontal: false,
        autoCropExtendVertical: false,
        autoCropOverscanHorizontal: 0.1,
        autoCropOverscanVertical: 0.1,
        autoCropZoomOutOnLostFace: true
      };
      FORMAT_PRESETS = [
        { label: "Native (from Meet)", format: null },
        { label: "720p 25", format: { width: 1280, height: 720, fpsN: 25, fpsD: 1 } },
        { label: "720p 29.97", format: { width: 1280, height: 720, fpsN: 3e4, fpsD: 1001 } },
        { label: "720p 30", format: { width: 1280, height: 720, fpsN: 30, fpsD: 1 } },
        { label: "720p 50", format: { width: 1280, height: 720, fpsN: 50, fpsD: 1 } },
        { label: "720p 59.94", format: { width: 1280, height: 720, fpsN: 6e4, fpsD: 1001 } },
        { label: "1080p 25", format: { width: 1920, height: 1080, fpsN: 25, fpsD: 1 } },
        { label: "1080p 29.97", format: { width: 1920, height: 1080, fpsN: 3e4, fpsD: 1001 } },
        { label: "1080p 30", format: { width: 1920, height: 1080, fpsN: 30, fpsD: 1 } },
        { label: "1080p 50", format: { width: 1920, height: 1080, fpsN: 50, fpsD: 1 } },
        { label: "1080p 59.94", format: { width: 1920, height: 1080, fpsN: 6e4, fpsD: 1001 } },
        { label: "2160p 29.97", format: { width: 3840, height: 2160, fpsN: 3e4, fpsD: 1001 } }
      ];
      DEFAULT_VIDEO_LOSS = {
        mode: "black",
        image: "",
        displayOutputNameOnImage: false,
        profilePictureSize: 0.4,
        profilePictureForceInitials: false,
        profilePictureBackgroundColor: "#222222",
        profilePictureOverrideInitialsBgColor: false,
        profilePictureInitialsBgColor: "#4793F1",
        profilePictureInitialsColor: "#FFFFFF",
        profilePictureShowName: true
      };
      DEFAULT_GLOBAL_VIDEO_LOSS = { ...DEFAULT_VIDEO_LOSS, delay: "medium", perOutputVideoLossEnabled: false };
      DEFAULT_RECORDING = {
        format: "mp4",
        videoCodec: "h264",
        videoBitrateMbps: 10,
        fileNamePrefix: "",
        fileNameSuffix: "",
        fileNameDateFormat: "standard",
        selectedOutputIds: [],
        lowDiskWarningPercent: 10,
        selectNewOutputsByDefault: false
      };
      DEFAULT_AUTO_ASSIGN = {
        includeHostsAndCoHosts: true,
        includeNonVideoParticipants: true,
        includeSelfCamera: false,
        continuouslyEvaluateEligibility: true,
        offlineParticipantMatching: "matchByIDOrName"
      };
      DEFAULT_INTERFACE = { showSystemPerformanceSummary: true, compactMode: false, customFramingGuidePath: "" };
      DEFAULT_ADVANCED_AUDIO = { defaultChannelMode: "none", defaultPanPattern: "stereo", defaultGainDb: 0, defaultDelaySeconds: 0 };
      DEFAULT_EMBEDDED_AUDIO = { defaultMode: "iso", defaultDelayMs: 0 };
      DEFAULT_OSC = {
        enabled: true,
        host: "127.0.0.1",
        rxPort: 9099,
        txPort: 9098,
        interface: "",
        enableAllowList: false,
        allowList: [],
        allowListPath: "",
        baudRate: "fastest",
        prepend: "/gmeetosc",
        subscribeMode: "all",
        disabledCommands: []
      };
      DEFAULT_SETTINGS = {
        ndiPrefix: "GMEET",
        ndiGroups: "",
        maxFps: 30,
        graceSeconds: 15,
        screenShare: true,
        includeSelf: false,
        autoJoin: true,
        muteLocalAudio: false,
        // Tiled layout gives each tile a share of this; 1440p keeps tiles big enough that Meet
        // sends 720p streams (1080p viewport → 640×360 with 3 tiles).
        meetWindowWidth: 2560,
        meetWindowHeight: 1440,
        camera: { type: "none", name: "" },
        micLabel: "",
        previewFps: 8,
        lastMeetUrl: "",
        botName: "",
        engine: "enabled",
        outputs: defaultOutputs("GMEET"),
        autoLayout: true,
        maxTiles: 49,
        autoAdmit: false,
        joinNotice: "This meeting is being captured for broadcast.",
        monitorDevice: "",
        oscEnabled: true,
        oscListenPort: 9099,
        oscReplyHost: "127.0.0.1",
        oscReplyPort: 9098,
        apiEnabled: true,
        apiPort: 8787,
        ndiDiscoveryServer: "",
        ndiNicIps: "",
        recordDir: "",
        autoStartEngine: false,
        defaultFormat: { width: 1280, height: 720, fpsN: 3e4, fpsD: 1001 },
        defaultAudio: "iso",
        defaultGainDb: 0,
        defaultDelayMs: 0,
        defaultLossMode: "black",
        defaultLossImage: "",
        defaultNameTag: false,
        defaultNameTagPosition: "bl",
        recordNewOutputs: false,
        autoAssignCamerasOff: true,
        logLevel: "info",
        outputsView: "grid",
        audioOutputDevices: [],
        audioInputDevices: [],
        videoLoss: { ...DEFAULT_GLOBAL_VIDEO_LOSS },
        recording: { ...DEFAULT_RECORDING },
        autoAssign: { ...DEFAULT_AUTO_ASSIGN },
        interface: { ...DEFAULT_INTERFACE },
        advancedAudio: { ...DEFAULT_ADVANCED_AUDIO },
        embeddedAudio: { ...DEFAULT_EMBEDDED_AUDIO },
        osc: { ...DEFAULT_OSC }
      };
      NOT_IN_MEET = "Not available in Google Meet";
      OUTPUT_MODE_OPTIONS = [
        { value: "participant", label: "Participant" },
        { value: "activeSpeaker", label: "Speaker" },
        { value: "screenshare", label: "Active Screenshare" },
        { value: "auto", label: "Auto" }
      ];
      EMBEDDED_AUDIO_OPTIONS = [
        { value: "off", label: "None" },
        { value: "iso", label: "Isolated Participant" },
        { value: "mix", label: "Mix of all outputs" }
      ];
      GAIN_REDUCTION_OPTIONS = [0, -3, -6, -9, -12, -18, -24].map((db) => ({ value: String(db), label: db === 0 ? "0 dB" : `${db} dB` }));
      NAME_TAG_PLACEMENT_OPTIONS = [
        { value: "left", label: "Left" },
        { value: "center", label: "Center" },
        { value: "right", label: "Right" }
      ];
      NAME_TAG_ALIGNMENT_OPTIONS = NAME_TAG_PLACEMENT_OPTIONS.map((o) => ({ ...o }));
      OUTPUT_ARRANGEMENT_OPTIONS = [
        { value: "multiview", label: "Previews" },
        { value: "grid", label: "Grid" },
        { value: "list", label: "List" }
      ];
    }
  });

  // src/control/tabs/meeting.ts
  function meetingButton(title, iconEl, color, onClick, disabledTitle = "") {
    const tile = h("span.mt-tile", { class: color }, iconEl);
    const b = h("button.mt-button", tile, h("span.mt-title", title));
    b.addEventListener("click", onClick);
    if (disabledTitle) {
      b.disabled = true;
      b.title = disabledTitle;
      b.dataset.na = "1";
    }
    return b;
  }
  function openJoinSheet() {
    const codeInput = h("input.field", { placeholder: "abc-defg-hij", spellcheck: "false" });
    const linkInput = h("input.field", { placeholder: "https://meet.google.com/abc-defg-hij", spellcheck: "false" });
    const last = store.settings.lastMeetUrl || "";
    codeInput.value = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(last)?.[1] ?? "";
    linkInput.value = last;
    const err = h("div.mt-sheet-error");
    const panes = {
      meetingInfo: h(
        "div.mt-form",
        h("label.mt-form-row", h("span", "Meeting code"), codeInput),
        h("div.mt-form-row", h("span", "Display name"), h("span.secondary", store.settings.botName || "Signed-in Google account"))
      ),
      url: h("div.mt-form", h("label.mt-form-row", h("span", "Meeting link"), linkInput)),
      zak: h("div.mt-form", h("div.mt-sheet-disabled", `ZAK tokens are a Zoom feature. ${NOT_IN_MEET}.`))
    };
    const labels = { meetingInfo: "Meeting Info", url: "URL", zak: "ZAK" };
    const tabs = h("div.segmented.mt-sheet-tabs");
    const body = h("div.mt-sheet-body");
    const joinBtn = button("Join", () => void submit(), "primary");
    const select = (t) => {
      joinTab = t;
      for (const b of tabs.children) b.classList.toggle("active", b.dataset.value === t);
      body.replaceChildren(panes[t]);
      joinBtn.disabled = t === "zak";
      err.textContent = "";
      setTimeout(() => (t === "url" ? linkInput : codeInput).focus(), 0);
    };
    for (const t of Object.keys(labels)) {
      const b = h("button", { dataset: { value: t }, title: t === "zak" ? NOT_IN_MEET : void 0 }, labels[t]);
      if (t === "zak") b.classList.add("na");
      b.addEventListener("click", () => select(t));
      tabs.append(b);
    }
    const close = () => layer.remove();
    const submit = async () => {
      let target = "";
      if (joinTab === "meetingInfo") {
        const v = codeInput.value.trim();
        if (!/^[a-z]{3}-?[a-z]{4}-?[a-z]{3}$/i.test(v)) {
          err.textContent = "Check the meeting code. It should look like abc-defg-hij.";
          return;
        }
        const c = v.replace(/-/g, "").toLowerCase();
        target = `${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}`;
      } else if (joinTab === "url") {
        const v = linkInput.value.trim();
        if (!/^(https?:\/\/)?meet\.google\.com\/\S+/i.test(v)) {
          err.textContent = "That is not a valid Google Meet link. Paste a meet.google.com invite URL.";
          return;
        }
        target = /^https?:/i.test(v) ? v : `https://${v}`;
      } else return;
      joinBtn.disabled = true;
      joinBtn.textContent = "Joining\u2026";
      try {
        await api.join(target);
        close();
      } catch (e) {
        err.textContent = `Failed to join meeting: ${e.message}`;
        joinBtn.disabled = false;
        joinBtn.textContent = "Join";
      }
    };
    for (const inp of [codeInput, linkInput])
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") close();
      });
    const layer = h("div.sheet-layer", h("div.sheet.mt-join-sheet", h("h3", "Join Meeting"), tabs, body, err, h("div.actions", button("Cancel", close), joinBtn)));
    document.body.append(layer);
    select(joinTab);
  }
  function footLink() {
    const a = h("span.link", "meet.google.com");
    a.addEventListener("click", () => window.open("https://meet.google.com"));
    return a;
  }
  function splash() {
    const signIn = h("button.splash-btn", h("span.ico"), "Sign in");
    signIn.firstElementChild.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.6"/><path d="M5 8h5.5M8.3 5.6 10.7 8l-2.4 2.4"/></svg>';
    signIn.addEventListener("click", () => void api.signIn());
    return h(
      "div.splash",
      h("div.splash-deco.l"),
      h("div.splash-deco.r"),
      h(
        "div.splash-center",
        h("img.splash-logo", { src: "icon.png", alt: "" }),
        h("div.splash-name", "GMeet ISO", h("span.beta-badge", "BETA")),
        h("div.splash-sub", "Isolated broadcast outputs from", h("br"), "Google Meet meetings"),
        signIn
      ),
      h("div.mt-footer", footLink(), h("span", VERSION))
    );
  }
  function mountMeeting(host) {
    host.classList.add("meeting-tab");
    const newBtn = meetingButton("New Meeting", icon("video.fill"), "orange", () => void api.join("https://meet.google.com/new"));
    const pmiBtn = meetingButton("PMI", icon("profile.small.fill"), "orange", () => {
    }, `Personal Meeting IDs are a Zoom feature. ${NOT_IN_MEET}`);
    const joinBtn = meetingButton("Join Meeting", icon("plusSquare"), "blue", openJoinSheet);
    const eventsBtn = meetingButton("Zoom Events", icon("events.fill"), "blue", () => {
    }, `Zoom Events. ${NOT_IN_MEET}`);
    const group = h("div.mt-buttons", newBtn, pmiBtn, joinBtn, eventsBtn);
    const status = h("div.mt-status");
    const hideBtn = button("Show Meet Window", async () => {
      meetWindowVisible = await api.setMeetWindowVisible(!meetWindowVisible);
      render();
    }, "mt-small");
    const settingsBtn = button(h("span.mt-btn-inner", icon("gear"), "Open Meet Settings"), () => void api.openWindow("settings", "inMeeting"), "mt-small");
    const img = h("img", { alt: "" });
    const pvMsg = h("div.mt-preview-msg");
    let hasFrame = false;
    bindPreview("__botcam__", (url) => {
      img.src = url;
      if (!hasFrame) {
        hasFrame = true;
        queueMicrotask(render);
      }
    });
    const preview = h("div.mt-preview", img, pvMsg);
    const setCamera = async (camera) => {
      await setSettings({ camera });
      if (inCall()) void api.setMeetCamera(camera.type !== "none");
    };
    const inputSource = popup([], "", (v) => {
      const type = v;
      const first = type === "ndi" ? store.ndiSources[0] : type === "device" ? store.devices.videoInputs[0] : "";
      void setCamera({ type, name: first ?? "" });
    });
    const source = popup([], "", (v) => void setCamera({ type: store.settings.camera.type, name: v }));
    const refresh = h("button.mt-refresh", { title: "Refresh NDI sources" }, icon("refresh"));
    refresh.addEventListener("click", () => void refreshNdi());
    const sourceLabel = h("span.mt-row-label", "Camera");
    const mic = popup([], "", async (v) => {
      await setSettings({ micLabel: v });
      if (inCall()) void api.setMeetMic(!!v);
    });
    const speaker = popup([], "", (v) => void setSettings({ monitorDevice: v }));
    const audioBtn = h("button.mt-inbtn");
    const videoBtn = h("button.mt-inbtn");
    const leaveBtn = h("button.mt-inbtn.leave", h("span", "Leave Meeting"));
    audioBtn.addEventListener("click", () => void api.setMeetMic(!store.state?.micOn));
    videoBtn.addEventListener("click", () => void api.setMeetCamera(!store.state?.camOn));
    leaveBtn.addEventListener("click", () => void api.leave());
    const chatField = h("input.field", { placeholder: "Message everyone", spellcheck: "false" });
    const sendChat = async () => {
      const text = chatField.value.trim();
      if (text && await run({ cmd: "chat", text })) chatField.value = "";
    };
    chatField.addEventListener("keydown", (e) => e.key === "Enter" && void sendChat());
    const chatBtn = h("button.btn.mt-small", icon("chat.outline"), h("span", "Chat with group (0)"));
    chatBtn.addEventListener("click", () => void sendChat());
    const talkBtn = h("button.btn.mt-small", { title: `Talkback. ${NOT_IN_MEET}` }, icon("headset.fill"), h("span", "Talk to group (0)"));
    talkBtn.disabled = true;
    const inMeeting = h("div.mt-inmeeting", h("div.mt-inbtns", audioBtn, videoBtn, leaveBtn), h("div.mt-chat", chatField, chatBtn, talkBtn));
    const row = (label, ...ctl) => h("div.mt-row", typeof label === "string" ? h("span.mt-row-label", label) : label, ...ctl);
    const panel = h(
      "div.mt-panel",
      status,
      h("div.mt-panel-btns", hideBtn, settingsBtn),
      preview,
      row("Input Source", inputSource.el),
      row(sourceLabel, source.el, refresh),
      row("Microphone", mic.el),
      row("Speaker", speaker.el),
      inMeeting
    );
    const splashEl = splash();
    host.append(h("div.mt-body", group, panel), h("div.mt-footer", footLink(), h("span", VERSION)));
    document.body.append(splashEl);
    function render() {
      const s = store.settings;
      const st = store.state;
      const phase = st?.phase ?? "loading";
      const live = phase === "in-call";
      const joining = phase === "green-room" || phase === "waiting";
      splashEl.hidden = phase !== "signed-out";
      status.textContent = live ? "In Meeting" : joining ? phase === "waiting" ? "Waiting to be admitted" : "Joining\u2026" : "Not in Meeting";
      status.className = "mt-status " + (live ? "in" : joining ? "joining" : "out");
      newBtn.disabled = live || joining;
      joinBtn.disabled = live || joining;
      hideBtn.textContent = meetWindowVisible ? "Hide Meet Window" : "Show Meet Window";
      const types = [
        { value: "device", label: "Webcam" },
        { value: "ndi", label: "NDI" },
        { value: "blackmagic", label: "Blackmagic Desktop Video", disabled: true },
        { value: "aja", label: "AJA NTV2", disabled: true },
        { value: "none", label: "None" }
      ];
      inputSource.set(types, s.camera.type);
      let list = s.camera.type === "ndi" ? [...store.ndiSources] : s.camera.type === "device" ? [...store.devices.videoInputs] : [];
      if (s.camera.name && !list.includes(s.camera.name)) list = [s.camera.name, ...list];
      const opts = s.camera.type === "none" ? [{ value: "", label: "--" }] : list.length ? list.map((n2) => ({ value: n2, label: n2 })) : [{ value: "", label: s.camera.type === "ndi" ? "Scanning..." : "No cameras" }];
      source.set(opts, s.camera.name, s.camera.type === "none" || !list.length);
      sourceLabel.textContent = s.camera.type === "ndi" ? "NDI Source" : "Camera";
      refresh.hidden = s.camera.type !== "ndi";
      const mics = [...store.devices.audioInputs];
      if (s.micLabel && !mics.includes(s.micLabel)) mics.unshift(s.micLabel);
      mic.set([{ value: "", label: "None (muted)" }, ...mics.map((m) => ({ value: m, label: m }))], s.micLabel);
      const outs = [...store.devices.audioOutputs ?? []];
      if (s.monitorDevice && !outs.includes(s.monitorDevice)) outs.unshift(s.monitorDevice);
      speaker.set([{ value: "", label: "Same as system" }, ...outs.map((m) => ({ value: m, label: m }))], s.monitorDevice);
      const bc = st?.botCam;
      const label = s.camera.type === "ndi" ? s.camera.name || "NDI Input" : s.camera.type === "device" ? s.camera.name || "Camera" : "No Input";
      pvMsg.textContent = s.camera.type === "none" ? "No Input" : bc && bc.status !== "live" ? `${label}
${bc.status}` : hasFrame ? "" : label;
      pvMsg.hidden = !pvMsg.textContent;
      img.hidden = s.camera.type === "none" || !hasFrame;
      inMeeting.hidden = !live;
      audioBtn.disabled = st?.micOn == null;
      videoBtn.disabled = st?.camOn == null;
      audioBtn.classList.toggle("off", st?.micOn === false);
      videoBtn.classList.toggle("off", st?.camOn === false);
      audioBtn.replaceChildren(icon(st?.micOn === false ? "mic.slash.outline" : "mic.outline"), h("span", st?.micOn === false ? "Unmute" : "Mute"));
      videoBtn.replaceChildren(icon(st?.camOn === false ? "camera.slash.outline" : "camera.outline"), h("span", st?.camOn === false ? "Start Video" : "Stop Video"));
      const n = (st?.participants ?? []).filter((p) => p.kind === "camera" && !p.isSelf).length;
      chatBtn.lastChild.textContent = `Chat with group (${n})`;
      talkBtn.lastChild.textContent = `Talk to group (${n})`;
    }
    on("settings", render);
    on("state", render);
    on("devices", render);
    on("ndi", render);
    render();
  }
  var VERSION, meetWindowVisible, joinTab;
  var init_meeting = __esm({
    "src/control/tabs/meeting.ts"() {
      "use strict";
      init_types();
      init_kit();
      init_store();
      VERSION = "v0.2.0 (beta)";
      meetWindowVisible = false;
      joinTab = "meetingInfo";
    }
  });

  // src/control/tabs/participants.ts
  function mountParticipants(host) {
    host.append(h("div.empty", "Participants \u2014 not built yet"));
  }
  var init_participants = __esm({
    "src/control/tabs/participants.ts"() {
      "use strict";
      init_kit();
    }
  });

  // src/control/video/common.ts
  function setMode(cfg, mode) {
    const patch = { mode };
    const isScreen = !!cfg.selection?.key.endsWith(":screen");
    if (mode === "participant" && isScreen) patch.selection = null;
    if (mode === "screenshare" && cfg.selection && !isScreen) patch.selection = null;
    void updateOutput(cfg.id, patch);
  }
  function roster(kind) {
    const includeSelf = store.settings.includeSelf;
    return (store.state?.participants ?? []).filter((p) => p.kind === kind && (includeSelf || !p.isSelf));
  }
  function selectionModel(cfg, st) {
    if (cfg.mode === "participant" || cfg.mode === "screenshare") {
      const kind = cfg.mode === "participant" ? "camera" : "screen";
      const list = roster(kind);
      const opts = [
        { value: "", label: kind === "camera" ? "--" : "Any Screen Share" }
      ];
      for (const p of list) opts.push({ value: p.key, label: kind === "screen" ? p.displayName.replace(/\s*\(presentation\)$/i, "") : p.displayName });
      let value = "";
      const sel = cfg.selection;
      if (sel) {
        const hit = list.find((p) => p.key === sel.key) ?? list.find((p) => p.displayName === sel.name);
        if (hit) value = hit.key;
        else {
          value = sel.key;
          opts.push({ value: sel.key, label: `${sel.name || sel.key} (offline)` });
        }
      }
      return { opts, value, disabled: false };
    }
    const label = st?.sourceName || "--";
    return { opts: [{ value: "", label }], value: "", disabled: true };
  }
  function setSelection(cfg, key) {
    if (!key) void updateOutput(cfg.id, { selection: null });
    else void run({ cmd: "route", output: cfg.id, participant: key });
  }
  function deviceModel(cfg) {
    const displays = store.system?.displays ?? [];
    const opts = [{ value: "ndi", label: "NDI" }];
    for (const d of displays) opts.push({ value: `d:${d.id}`, label: `NDI + ${d.label}${d.primary ? " (Main)" : ""}` });
    let value = "ndi";
    if (cfg.display !== null && cfg.display !== void 0) {
      value = `d:${cfg.display}`;
      if (!displays.some((d) => d.id === cfg.display)) opts.push({ value, label: "NDI + Display (disconnected)" });
    }
    return { opts: [...opts, { group: NOT_IN_MEET, options: [
      { value: "x-srt", label: "SRT", disabled: true },
      { value: "x-bmd", label: "Blackmagic Desktop Video", disabled: true },
      { value: "x-syphon", label: "Syphon", disabled: true },
      { value: "x-aja", label: "AJA", disabled: true }
    ] }], value };
  }
  function setDevice(cfg, v) {
    void updateOutput(cfg.id, { display: v.startsWith("d:") ? Number(v.slice(2)) : null });
  }
  function formatValue(cfg) {
    const f = cfg.format;
    const i = FORMAT_PRESETS.findIndex((p) => p.format === null ? f === null : !!f && p.format.width === f.width && p.format.height === f.height && p.format.fpsN === f.fpsN && p.format.fpsD === f.fpsD);
    return String(Math.max(0, i));
  }
  function setFormat(cfg, v) {
    const p = FORMAT_PRESETS[Number(v)];
    if (p) void updateOutput(cfg.id, { format: p.format ? { ...p.format } : null });
  }
  function statusModel(cfg, st) {
    if (!cfg.enabled) return { kind: "none", text: "Output disabled" };
    if (!st || st.status === "off") return { kind: "none", text: store.settings.engine === "disabled" ? "Capture disabled" : "Starting\u2026" };
    const hasIn = st.inWidth > 0 && st.inHeight > 0;
    const res = hasIn ? `${st.inWidth} x ${st.inHeight} - ${st.inFps.toFixed(1)} fps in` : "";
    if (st.status === "standby") return { kind: "none", text: res || "Standby" };
    if (!st.sourceKey) return { kind: "none", text: cfg.mode === "screenshare" ? "No screen share" : "No source" };
    if (st.status === "loss" || !hasIn) return { kind: "warn", text: res ? `${res} (loss)` : "Video loss" };
    const f = cfg.format;
    const below = !!f && (st.inHeight < f.height || st.inFps < f.fpsN / f.fpsD * 0.8);
    return { kind: below ? "warn" : "ok", text: res };
  }
  function statusLine() {
    const ico = icon("checkCircle");
    ico.classList.add("vo-st-ico");
    const txt = h("span");
    const el = h("span.status-line.vo-status", ico, txt);
    let lastKind = "";
    return {
      el,
      set(cfg, st) {
        const m = statusModel(cfg, st);
        if (m.kind !== lastKind) {
          lastKind = m.kind;
          el.dataset.kind = m.kind;
          ico.innerHTML = icon(m.kind === "warn" ? "warn" : m.kind === "ok" ? "checkCircle" : "info").innerHTML;
        }
        if (txt.textContent !== m.text) txt.textContent = m.text;
        el.title = st?.sourceName ? `Source: ${st.sourceName}${st.latencyMs ? ` \xB7 ${st.latencyMs.toFixed(0)} ms` : ""}` : "";
      }
    };
  }
  function sourceParticipant(st) {
    if (!st?.sourceKey) return void 0;
    const ps = store.state?.participants ?? [];
    const p = ps.find((x) => x.key === st.sourceKey);
    if (p && p.kind === "screen") return ps.find((x) => x.participantId === p.participantId && x.kind === "camera") ?? p;
    return p;
  }
  function quickActions(getId, opts = {}) {
    const mk = (name, title) => h("button.icon-btn.vo-qa", { title }, icon(name));
    const mic = mk("mic.outline", "Mute participant");
    const cam = mk("camera.outline", `Ask participant to start/stop video: ${UNSUPPORTED}`);
    cam.disabled = true;
    const chat = mk("chat.outline", `Private chat: ${UNSUPPORTED}`);
    chat.disabled = true;
    mic.addEventListener("click", () => {
      const p = sourceParticipant(outputState(getId()));
      if (p) void run({ cmd: "muteParticipant", participant: p.key });
    });
    const talk = opts.talk ? h("button.btn.sm.vo-talk", { title: `Talkback: ${UNSUPPORTED}`, disabled: true }, icon("headset.fill"), "Talk") : null;
    const el = h("span.vo-qas", mic, cam, chat, talk);
    return {
      el,
      set(st) {
        const p = sourceParticipant(st);
        const muted = p?.muted === true;
        mic.disabled = !inCall() || !p || p.isSelf || p.muted !== false;
        mic.title = !p ? "Please assign a participant to the stream" : muted ? `${p.displayName} is muted. Unmuting others: ${UNSUPPORTED}` : p.muted === null ? "Mic state unknown" : `Mute ${p.displayName} (requires host)`;
        const want = muted ? "mic.slash.outline" : "mic.outline";
        if (mic.dataset.ico !== want) {
          mic.dataset.ico = want;
          mic.replaceChildren(icon(want));
        }
        mic.classList.toggle("muted", muted);
        const vidOff = !!p && p.kind === "camera" && !p.hasVideo;
        const wantCam = vidOff ? "camera.slash.outline" : "camera.outline";
        if (cam.dataset.ico !== wantCam) {
          cam.dataset.ico = wantCam;
          cam.replaceChildren(icon(wantCam));
        }
      }
    };
  }
  function openEffects(id) {
    void api.openWindow("effects", id);
  }
  async function duplicateOutput(cfg) {
    const { id: _id, ...rest } = structuredClone(cfg);
    const names = new Set(store.settings.outputs.map((o) => o.name));
    let name = `${cfg.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${cfg.name} copy ${i}`;
    await run({ cmd: "addOutput", patch: { ...rest, name, record: false } });
  }
  async function renameOutput(cfg) {
    const v = await promptSheet("Rename Output", cfg.name, "Rename");
    const name = v?.trim();
    if (name && name !== cfg.name) await updateOutput(cfg.id, { name });
  }
  async function deleteOutput(cfg) {
    if (await confirmSheet(`Are you sure you want to delete "${cfg.name}"?`, "The NDI source will stop and this output\u2019s settings will be removed.", "Delete", true)) {
      await run({ cmd: "deleteOutput", output: cfg.id });
    }
  }
  function outputMenu(anchor, getCfg) {
    const cfg = getCfg();
    if (!cfg) return;
    menu(anchor, [
      { label: "Duplicate", icon: "copy", onClick: () => void duplicateOutput(cfg) },
      { label: "Rename", icon: "pencil", onClick: () => void renameOutput(cfg) },
      { label: "Output Effects", icon: "sliders", onClick: () => openEffects(cfg.id) },
      null,
      { label: "Delete output", icon: "trash", destructive: true, onClick: () => void deleteOutput(cfg) }
    ]);
  }
  function addOutput() {
    void run({ cmd: "addOutput" });
  }
  function cfgById(id) {
    return store.settings.outputs.find((o) => o.id === id);
  }
  function reconcile(parent, views, outputs, create, before = null) {
    const want = new Set(outputs.map((o) => o.id));
    for (const [id, v] of views) {
      if (!want.has(id)) {
        v.destroy();
        v.el.remove();
        views.delete(id);
      }
    }
    outputs.forEach((cfg, i) => {
      let v = views.get(cfg.id);
      if (!v) {
        v = create(cfg, i);
        views.set(cfg.id, v);
      }
      const at = parent.children[i] ?? null;
      if (at !== v.el) parent.insertBefore(v.el, at ?? before);
    });
    if (before && before.parentNode === parent && parent.lastChild !== before) parent.append(before);
  }
  var UNSUPPORTED, MODE_OPTS, FORMAT_OPTS, AUDIO_OPTS;
  var init_common = __esm({
    "src/control/video/common.ts"() {
      "use strict";
      init_types();
      init_kit();
      init_store();
      UNSUPPORTED = NOT_IN_MEET;
      MODE_OPTS = OUTPUT_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
      FORMAT_OPTS = FORMAT_PRESETS.map((p, i) => ({ value: String(i), label: p.label }));
      AUDIO_OPTS = EMBEDDED_AUDIO_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
    }
  });

  // src/control/video/grid.ts
  function previewWell(id) {
    const img = h("img", { alt: "", draggable: false });
    const msg = h("div.well-msg");
    const el = h("div.well.vo-well", img, msg);
    let got = false;
    const unbind = bindPreview(id, (url) => {
      if (img.hidden) return;
      img.src = url;
      if (!got) {
        got = true;
        el.classList.add("has-frame");
        msg.hidden = true;
      }
    });
    return {
      el,
      set(cfg, st) {
        const off = !cfg.enabled || !st || st.status === "off";
        img.hidden = off;
        if (off && got) {
          img.removeAttribute("src");
          got = false;
          el.classList.remove("has-frame");
        }
        const text = !cfg.enabled ? "Preview off" : off ? "ENGINE PAUSED OR STOPPED" : got ? "" : "No incoming video";
        if (msg.textContent !== text) msg.textContent = text;
        msg.hidden = !text;
      },
      destroy: unbind
    };
  }
  function recordingBadge() {
    const el = h("span.vo-rec", { title: "Recording" }, icon("record.large.fill"));
    el.hidden = true;
    return { el, set: (on2) => void (el.hidden = !on2) };
  }
  function audioIndicators() {
    const l = meterV();
    const r = meterV();
    const el = h("div.vo-meters", l.el, r.el);
    return {
      el,
      set(cfg, st) {
        const lvl = cfg.enabled ? st?.audioLevel ?? 0 : 0;
        l.set(lvl);
        r.set(lvl);
      }
    };
  }
  function setTally(el, st) {
    el.classList.toggle("pgm", !!st?.program);
    el.classList.toggle("pvw", !st?.program && !!st?.preview);
  }
  function field(control, caption) {
    return h("div.vo-field", control, h("span.caption", caption));
  }
  function gridCard(cfg0) {
    const id = cfg0.id;
    const cfg = () => cfgById(id);
    const name = h("span.vo-name", { title: "Double-click to rename" });
    name.addEventListener("dblclick", () => {
      const c = cfg();
      if (c) void renameOutput(c);
    });
    const rec = recordingBadge();
    const enabled = toggle(cfg0.enabled, (v) => void updateOutput(id, { enabled: v }), { cls: "sm", title: "Video Output is enabled" });
    const fx = iconButton("sliders", () => openEffects(id), "Output Effects", "vo-fx");
    const more = iconButton("ellipsis", () => outputMenu(more, cfg), "Options", "vo-more");
    const header = h("div.vo-head", h("span.vo-title", name, rec.el), h("span.vo-head-r", enabled.el, fx, more));
    const well = previewWell(id);
    well.el.title = "Double-click for Output Effects";
    well.el.addEventListener("dblclick", () => openEffects(id));
    const meters = audioIndicators();
    const prev = h("div.vo-prev", well.el, meters.el);
    const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
      const c = cfg();
      if (c) setMode(c, v);
    }, { title: "Mode" });
    const sel = popup([], "", (v) => {
      const c = cfg();
      if (c) setSelection(c, v);
    }, { title: "Selection" });
    const status = statusLine();
    const qa = quickActions(() => id, { talk: true });
    const device = popup([], "ndi", (v) => {
      const c = cfg();
      if (c) setDevice(c, v);
    }, { title: "Output Device" });
    const format = popup(FORMAT_OPTS, formatValue(cfg0), (v) => {
      const c = cfg();
      if (c) setFormat(c, v);
    }, { title: "Format" });
    const audio = popup(AUDIO_OPTS, cfg0.audio, (v) => void updateOutput(id, { audio: v }), { title: "Embedded Audio" });
    const el = h(
      "div.vo-card",
      { dataset: { id } },
      header,
      prev,
      h("div.vo-row.two", mode.el, sel.el),
      h("div.vo-row.status", status.el, qa.el),
      h("div.vo-row.three", field(device.el, "Output Device"), field(format.el, "Format"), field(audio.el, "Embedded Audio"))
    );
    return {
      el,
      update(c, st) {
        if (name.textContent !== c.name) name.textContent = c.name;
        el.classList.toggle("disabled", !c.enabled);
        setTally(prev, st);
        rec.set(!!st?.recording);
        enabled.set(c.enabled);
        well.set(c, st);
        meters.set(c, st);
        mode.set(MODE_OPTS, c.mode);
        const sm = selectionModel(c, st);
        sel.set(sm.opts, sm.value, sm.disabled);
        status.set(c, st);
        qa.set(st);
        const dm = deviceModel(c);
        device.set(dm.opts, dm.value);
        format.set(FORMAT_OPTS, formatValue(c));
        audio.set(AUDIO_OPTS, c.audio);
      },
      destroy: well.destroy
    };
  }
  function addTile() {
    const b = h("button.vo-add-btn", { title: "Add Output" }, icon("plus"));
    b.addEventListener("click", addOutput);
    return h("div.vo-add", b);
  }
  var init_grid = __esm({
    "src/control/video/grid.ts"() {
      "use strict";
      init_kit();
      init_store();
      init_common();
    }
  });

  // src/control/video/list.ts
  function openVideoPreview(anchor, id) {
    const well = previewWell(id);
    const body = h("div.vo-pop-prev", well.el);
    const tick = () => {
      const c = cfgById(id);
      if (!c || !body.isConnected) {
        well.destroy();
        return;
      }
      well.set(c, outputState(id));
      setTimeout(tick, 250);
    };
    popover(anchor, body, { width: 360 });
    tick();
  }
  function listRow(cfg0, index) {
    const id = cfg0.id;
    const cfg = () => cfgById(id);
    const enabled = toggle(cfg0.enabled, (v) => void updateOutput(id, { enabled: v }), { cls: "sm", title: "Video Output is enabled" });
    const idx = h("span.vo-idx", String(index + 1));
    const rec = recordingBadge();
    const name = textField(cfg0.name, (v) => {
      const n = v.trim();
      if (n) void updateOutput(id, { name: n });
      else name.set(cfg()?.name ?? "");
    }, { cls: "vo-name-field" });
    name.el.title = "Output Name";
    const modeIco = icon(MODE_ICON[cfg0.mode] ?? "person", "vo-mode-ico");
    const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
      const c = cfg();
      if (c) setMode(c, v);
    }, { cls: "sm vo-mode", title: "Mode" });
    mode.el.prepend(modeIco);
    const sel = popup([], "", (v) => {
      const c = cfg();
      if (c) setSelection(c, v);
    }, { cls: "sm", title: "Selection" });
    const qa = quickActions(() => id);
    const device = popup([], "ndi", (v) => {
      const c = cfg();
      if (c) setDevice(c, v);
    }, { cls: "sm", title: "Output Device" });
    const format = popup(FORMAT_OPTS, formatValue(cfg0), (v) => {
      const c = cfg();
      if (c) setFormat(c, v);
    }, { cls: "sm", title: "Format" });
    const audio = popup(AUDIO_OPTS, cfg0.audio, (v) => void updateOutput(id, { audio: v }), { cls: "sm", title: "Embedded Audio" });
    const status = statusLine();
    const prevBtn = iconButton("preview", () => openVideoPreview(prevBtn, id), "Open Video Preview", "plain vo-prev-btn");
    const meterL = meterH();
    const meterR = meterH();
    const fx = iconButton("sliders", () => openEffects(id), "Output Effects", "vo-fx");
    const more = iconButton("ellipsis", () => outputMenu(more, cfg), "Options", "plain vo-more");
    const td = (cls, ...c) => h(`td.${cls}`, ...c);
    const el = h(
      "tr.vo-tr",
      { dataset: { id } },
      td("c-en", enabled.el),
      td("c-idx", idx),
      td("c-rec", rec.el),
      td("c-name", name.el),
      td("c-mode", mode.el),
      td("c-sel", sel.el),
      td("c-qa", qa.el),
      td("c-dev", device.el),
      td("c-fmt", format.el),
      td("c-aud", audio.el),
      td("c-status", status.el),
      td("c-prev", prevBtn),
      td("c-meters", h("div.vo-hmeters", meterL.el, meterR.el)),
      td("c-opts", h("span.vo-opts", fx, more))
    );
    return {
      el,
      setIndex(i) {
        const t = String(i + 1);
        if (idx.textContent !== t) idx.textContent = t;
      },
      update(c, st) {
        el.classList.toggle("disabled", !c.enabled);
        setTally(el, st);
        enabled.set(c.enabled);
        rec.set(!!st?.recording);
        name.set(c.name);
        if (modeIco.dataset.m !== c.mode) {
          modeIco.dataset.m = c.mode;
          modeIco.replaceChildren(...icon(MODE_ICON[c.mode] ?? "person").childNodes);
        }
        mode.set(MODE_OPTS, c.mode);
        const sm = selectionModel(c, st);
        sel.set(sm.opts, sm.value, sm.disabled);
        qa.set(st);
        const dm = deviceModel(c);
        device.set(dm.opts, dm.value);
        format.set(FORMAT_OPTS, formatValue(c));
        audio.set(AUDIO_OPTS, c.audio);
        status.set(c, st);
        const lvl = c.enabled ? st?.audioLevel ?? 0 : 0;
        meterL.set(lvl);
        meterR.set(lvl);
      },
      destroy() {
      }
    };
  }
  function listShell() {
    const tbody = h("tbody");
    const table = h(
      "table.table.vo-table",
      h("thead", h("tr", ...LIST_COLUMNS.map((c) => h("th", c)))),
      tbody
    );
    const add = h("button.btn.sm.vo-add-row", { title: "Add Output" }, icon("plus"), "Add Output");
    add.addEventListener("click", addOutput);
    const el = h("div.vo-list", h("div.vo-table-wrap", table), h("div.vo-list-foot", add));
    return { el, tbody };
  }
  var LIST_COLUMNS, MODE_ICON;
  var init_list = __esm({
    "src/control/video/list.ts"() {
      "use strict";
      init_kit();
      init_store();
      init_common();
      init_grid();
      LIST_COLUMNS = [
        "Enabled",
        "Index",
        "Rec",
        "Output Name",
        "Mode",
        "Selection",
        "Participant Controls",
        "Output Device",
        "Format",
        "Audio",
        "Status",
        "Preview",
        "Meters",
        "Options"
      ];
      MODE_ICON = { participant: "person", activeSpeaker: "speaker", screenshare: "screen", auto: "people" };
    }
  });

  // src/control/video/multiview.ts
  function multiviewTile(cfg0) {
    const id = cfg0.id;
    const cfg = () => cfgById(id);
    const well = previewWell(id);
    well.el.addEventListener("dblclick", () => openEffects(id));
    const name = h("span.mv-name");
    const rec = recordingBadge();
    const fx = iconButton("sliders", () => openEffects(id), "Output Effects", "mv-fx");
    const meters = audioIndicators();
    const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
      const c = cfg();
      if (c) setMode(c, v);
    }, { cls: "sm mv-pop", title: "Mode" });
    const sel = popup([], "", (v) => {
      const c = cfg();
      if (c) setSelection(c, v);
    }, { cls: "sm mv-pop", title: "Selection" });
    const qa = quickActions(() => id);
    const overlay = h(
      "div.mv-ov",
      h("div.mv-top", h("span.mv-label", name, rec.el), fx),
      meters.el,
      h("div.mv-bottom", mode.el, sel.el, qa.el)
    );
    const el = h("div.mv-tile", { dataset: { id } }, well.el, overlay);
    return {
      el,
      update(c, st) {
        if (name.textContent !== c.name) name.textContent = c.name;
        el.classList.toggle("disabled", !c.enabled);
        setTally(el, st);
        rec.set(!!st?.recording);
        well.set(c, st);
        meters.set(c, st);
        mode.set(MODE_OPTS, c.mode);
        const sm = selectionModel(c, st);
        sel.set(sm.opts, sm.value, sm.disabled);
        qa.set(st);
      },
      destroy: well.destroy
    };
  }
  function multiviewColumns(n, w, hgt) {
    let best = { cols: 1, tileW: 0 };
    for (let cols = 1; cols <= Math.max(1, n); cols++) {
      const rows = Math.ceil(n / cols);
      const tw = Math.min(w / cols, hgt / rows * (16 / 9));
      if (tw > best.tileW + 0.5) best = { cols, tileW: tw };
    }
    return best;
  }
  var init_multiview = __esm({
    "src/control/video/multiview.ts"() {
      "use strict";
      init_kit();
      init_common();
      init_grid();
    }
  });

  // src/control/tabs/video.ts
  function mountVideo(host) {
    host.classList.add("vo-tab");
    let pending = null;
    const count = stepper(store.settings.outputs.length, (n) => void setCount(n), 0, MAX_OUTPUTS);
    async function setCount(n) {
      const cur = store.settings.outputs.length;
      if (n === cur) return;
      if (n < cur) {
        const gone = store.settings.outputs.slice(n).map((o) => o.name);
        const ok = await confirmSheet(
          "Delete output" + (gone.length > 1 ? "s" : ""),
          `Are you sure you want to delete ${gone.map((g) => `"${g}"`).join(", ")}?`,
          "Delete",
          true
        );
        if (!ok) {
          count.set(cur);
          return;
        }
      }
      pending = n;
      await run({ cmd: "setOutputCount", count: n });
      pending = null;
    }
    const showOv = toggle(localStorage.getItem(OVERLAYS_KEY) === "1", (v) => {
      localStorage.setItem(OVERLAYS_KEY, v ? "1" : "0");
      body.classList.toggle("show-overlays", v);
    }, { cls: "sm", title: "Show Overlays" });
    const ovWrap = h("label.vo-ov-toggle", "Show Overlays", showOv.el);
    const arr = segmented(
      OUTPUT_ARRANGEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: ARR_ICON[o.value] })),
      store.settings.outputsView,
      (v) => {
        show(v);
        void setSettings({ outputsView: v });
      },
      "sm vo-arr"
    );
    const bar = h(
      "div.vo-bar",
      h("div.vo-bar-l", h("span.vo-count-label", "Number of Outputs"), count.el, ovWrap),
      h("div.vo-bar-r", arr.el)
    );
    const body = h("div.vo-body");
    body.classList.toggle("show-overlays", showOv.input.checked);
    const gridEl = h("div.vo-grid");
    const add = addTile();
    const gridViews = /* @__PURE__ */ new Map();
    const list = listShell();
    const rowViews = /* @__PURE__ */ new Map();
    const mvEl = h("div.vo-mv");
    const mvViews = /* @__PURE__ */ new Map();
    const empty = h("div.empty.vo-empty", "No outputs");
    body.append(mvEl, gridEl, list.el, empty);
    host.append(bar, body);
    let current2 = store.settings.outputsView;
    function layoutMultiview() {
      const n = mvViews.size;
      if (!n || current2 !== "multiview") return;
      const r = body.getBoundingClientRect();
      const pad = 12;
      const { cols, tileW } = multiviewColumns(n, Math.max(0, r.width - pad * 2), Math.max(0, r.height - pad * 2));
      mvEl.style.setProperty("--mv-w", `${Math.floor(tileW)}px`);
      mvEl.style.maxWidth = `${Math.floor(tileW) * cols + 1}px`;
    }
    new ResizeObserver(layoutMultiview).observe(body);
    function render() {
      const outs = store.settings.outputs;
      if (pending === null) count.set(outs.length);
      empty.hidden = outs.length > 0 || current2 === "grid" || current2 === "list";
      if (current2 === "grid") {
        if (add.parentNode !== gridEl) gridEl.append(add);
        reconcile(gridEl, gridViews, outs, (c) => gridCard(c), add);
        for (const c of outs) gridViews.get(c.id)?.update(c, outputState(c.id));
      } else if (current2 === "list") {
        reconcile(list.tbody, rowViews, outs, (c, i) => listRow(c, i));
        outs.forEach((c, i) => {
          const v = rowViews.get(c.id);
          v.setIndex(i);
          v.update(c, outputState(c.id));
        });
      } else {
        const before = mvViews.size;
        reconcile(mvEl, mvViews, outs, (c) => multiviewTile(c));
        for (const c of outs) mvViews.get(c.id)?.update(c, outputState(c.id));
        if (before !== mvViews.size) layoutMultiview();
      }
    }
    function clear(views) {
      for (const v of views.values()) {
        v.destroy();
        v.el.remove();
      }
      views.clear();
    }
    function show(v) {
      if (!["multiview", "grid", "list"].includes(v)) v = "grid";
      current2 = v;
      arr.set(v);
      body.dataset.view = v;
      ovWrap.hidden = v !== "multiview";
      if (v !== "grid") clear(gridViews);
      if (v !== "list") clear(rowViews);
      if (v !== "multiview") clear(mvViews);
      gridEl.hidden = v !== "grid";
      list.el.hidden = v !== "list";
      mvEl.hidden = v !== "multiview";
      render();
      layoutMultiview();
    }
    on("settings", () => {
      if (store.settings.outputsView !== current2) show(store.settings.outputsView);
      else render();
    });
    on("state", render);
    show(current2);
  }
  var ARR_ICON, OVERLAYS_KEY, MAX_OUTPUTS;
  var init_video = __esm({
    "src/control/tabs/video.ts"() {
      "use strict";
      init_types();
      init_kit();
      init_store();
      init_common();
      init_grid();
      init_list();
      init_multiview();
      ARR_ICON = { multiview: "previews", grid: "grid", list: "list" };
      OVERLAYS_KEY = "vo.showOverlays";
      MAX_OUTPUTS = 32;
    }
  });

  // src/control/shell.ts
  function showTab(id) {
    current = id;
    nav?.set(id);
    for (const [tid, host] of hosts) host.hidden = tid !== id;
    if (!mounted.has(id)) {
      mounted.add(id);
      TABS.find((t) => t.id === id).mount(hosts.get(id));
    }
    document.body.dataset.tab = id;
  }
  function topBar() {
    const pillLabel = h("span", "Capture Disabled");
    const sw = toggle(false, (v) => void run({ cmd: "engine", state: v ? "enabled" : "disabled" }));
    const pill = h("div.capture-pill", icon("gearFill"), pillLabel, sw.el);
    const renderPill = () => {
      const e = store.settings.engine;
      pill.classList.toggle("on", e === "enabled");
      pill.classList.toggle("standby", e === "standby");
      pillLabel.textContent = e === "enabled" ? "Capture Enabled" : e === "standby" ? "Capture Standby" : "Capture Disabled";
      sw.set(e !== "disabled");
    };
    on("settings", renderPill);
    renderPill();
    nav = segmented(TABS.map((t) => ({ value: t.id, label: t.label })), current, (v) => showTab(v));
    const recLabel = h("span", "Configure Recording");
    const recBtn = h("button.btn.pill.rec-pill", icon("record"), recLabel);
    recBtn.addEventListener("click", () => openRecordingPopover(recBtn));
    const renderRec = () => {
      const recs = (store.state?.outputs ?? []).filter((o) => o.recording);
      recBtn.classList.toggle("running", recs.length > 0);
      if (!recs.length) recLabel.textContent = "Configure Recording";
    };
    on("state", renderRec);
    setInterval(() => {
      const since = recordingSince();
      if (since) recLabel.innerHTML = `<span class="timer">${fmt(Date.now() - since)}</span>`;
    }, 500);
    const settingsBtn = h("button.btn.pill", icon("gear"), "Settings");
    settingsBtn.addEventListener("click", () => void api.openWindow("settings"));
    const avatar = h("div.avatar", { title: "" });
    const renderAvatar = () => {
      const name = store.settings.botName || "";
      avatar.textContent = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "";
      avatar.title = name ? `Signed in as ${name}` : "Not signed in";
      avatar.style.background = name ? "var(--blue)" : "var(--control)";
    };
    avatar.addEventListener("click", () => {
      const name = store.settings.botName;
      const body = h(
        "div",
        { style: "display:flex;flex-direction:column;gap:10px;min-width:200px" },
        h("div", { style: "font-weight:600" }, name || "Not signed in"),
        h("div.caption", "Google account used by the hidden Meet client"),
        button(name ? "Switch account\u2026" : "Sign in\u2026", () => void api.signIn(), "block")
      );
      popover(avatar, body, { align: "end" });
    });
    on("settings", renderAvatar);
    renderAvatar();
    return h(
      "header.topbar",
      h("div.left", pill, h("span.app-title", "GMeet ISO")),
      h("div.center", nav.el),
      h("div.right", recBtn, settingsBtn, avatar)
    );
  }
  function recordingSince() {
    const now = Date.now();
    const running = new Set((store.state?.outputs ?? []).filter((o) => o.recording).map((o) => o.id));
    for (const id of running) if (!recStarted.has(id)) recStarted.set(id, now);
    for (const id of [...recStarted.keys()]) if (!running.has(id)) recStarted.delete(id);
    return recStarted.size ? Math.min(...recStarted.values()) : 0;
  }
  function fmt(ms) {
    const s = Math.floor(ms / 1e3);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function camOpts() {
    const c = store.settings.camera;
    const type = [
      { value: "device", label: "Webcam" },
      { value: "ndi", label: "NDI" },
      { value: "none", label: "None" }
    ];
    let list = [];
    if (c.type === "ndi") list = [...store.ndiSources];
    if (c.type === "device") list = [...store.devices.videoInputs];
    if (c.name && !list.includes(c.name)) list.unshift(c.name);
    const device = c.type === "none" ? [{ value: "", label: "--" }] : list.length ? list.map((n) => ({ value: n, label: n })) : [{ value: "", label: c.type === "ndi" ? "No NDI sources" : "No cameras" }];
    return { type, device };
  }
  function returnFeedBar() {
    const img = h("img", { alt: "" });
    const msg = h("div.well-msg", "No camera");
    bindPreview("__botcam__", (url) => {
      img.src = url;
    });
    const preview = h("div.well.rf-preview", img, msg);
    const micBtn = h("button.rf-toggle", icon("mic"), "Audio");
    const camBtn = h("button.rf-toggle", icon("video"), "Video");
    micBtn.addEventListener("click", () => void api.setMeetMic(!store.state?.micOn));
    camBtn.addEventListener("click", () => void api.setMeetCamera(!store.state?.camOn));
    const setCamera = async (camera2) => {
      await setSettings({ camera: camera2 });
      if (inCall()) void api.setMeetCamera(camera2.type !== "none");
    };
    const inputSource = popup([], "", (v) => {
      const type = v;
      const first = type === "ndi" ? store.ndiSources[0] : type === "device" ? store.devices.videoInputs[0] : "";
      void setCamera({ type, name: first ?? "" });
    });
    const camera = popup([], "", (v) => void setCamera({ type: store.settings.camera.type, name: v }));
    const mic = popup([], "", async (v) => {
      await setSettings({ micLabel: v });
      if (inCall()) void api.setMeetMic(!!v);
    });
    const speaker = popup([], "", (v) => void setSettings({ monitorDevice: v }));
    const field2 = (control, caption) => h("div.rf-field", control, h("span.caption", caption));
    const render = () => {
      const s = store.settings;
      const o = camOpts();
      inputSource.set(o.type, s.camera.type);
      camera.set(o.device, s.camera.name, s.camera.type === "none");
      const mics = [...store.devices.audioInputs];
      if (s.micLabel && !mics.includes(s.micLabel)) mics.unshift(s.micLabel);
      mic.set([{ value: "", label: "None (muted)" }, ...mics.map((m) => ({ value: m, label: m }))], s.micLabel);
      const outs2 = [...store.devices.audioOutputs ?? []];
      if (s.monitorDevice && !outs2.includes(s.monitorDevice)) outs2.unshift(s.monitorDevice);
      speaker.set([{ value: "", label: "Same as system" }, ...outs2.map((m) => ({ value: m, label: m }))], s.monitorDevice);
      const st = store.state;
      const live = st?.phase === "in-call" || st?.phase === "green-room";
      micBtn.disabled = !live || st?.micOn === null;
      camBtn.disabled = !live || st?.camOn === null;
      micBtn.classList.toggle("off", st?.micOn === false);
      camBtn.classList.toggle("off", st?.camOn === false);
      micBtn.querySelector(".ico").innerHTML = icon(st?.micOn === false ? "micSlash" : "mic").innerHTML;
      camBtn.querySelector(".ico").innerHTML = icon(st?.camOn === false ? "videoSlash" : "video").innerHTML;
      const bc = st?.botCam;
      msg.textContent = s.camera.type === "none" ? "No camera" : bc && bc.status !== "live" ? bc.status : "";
      msg.hidden = !msg.textContent;
      if (s.camera.type === "none") img.removeAttribute("src");
    };
    on("settings", render);
    on("state", render);
    on("devices", render);
    on("ndi", render);
    const cpu = h("span");
    const ram = h("span");
    const net = h("span");
    const outs = h("span");
    const perfBtn = button("Open Performance Details", () => void api.openWindow("perf"), "sm");
    const renderSys = () => {
      const sy = store.system;
      if (!sy) return;
      cpu.textContent = `CPU: ${Math.round(sy.cpu)}%`;
      ram.textContent = `RAM: ${(sy.memMB / 1024).toFixed(1)} GB`;
      net.textContent = `Network in: ${(store.state?.rxMbps ?? 0).toFixed(0)}Mbps`;
      const live = (store.state?.outputs ?? []).filter((o) => o.status === "live").length;
      outs.textContent = `Outputs live: ${live}/${store.settings.outputs.filter((o) => o.enabled).length}`;
    };
    on("system", renderSys);
    on("state", renderSys);
    const chatBtn = h("button.btn", icon("chat"), h("span", "Chat with group"));
    chatBtn.addEventListener("click", () => {
      const tf = textField("", () => {
      }, { placeholder: "Message everyone", cls: "" });
      tf.el.style.width = "100%";
      const send = async () => {
        const text = tf.el.value.trim();
        if (!text) return;
        const ok = await run({ cmd: "chat", text });
        if (ok) close();
      };
      tf.el.addEventListener("keydown", (e) => e.key === "Enter" && void send());
      const body = h("div", { style: "display:flex;flex-direction:column;gap:8px" }, h("div", { style: "font-weight:600" }, "Send to everyone"), tf.el, h("div", { style: "display:flex;justify-content:flex-end" }, button("Send", () => void send(), "primary")));
      const close = popover(chatBtn, body, { width: 300, align: "end" });
      setTimeout(() => tf.el.focus(), 0);
    });
    const renderChat = () => {
      const n = (store.state?.participants ?? []).filter((p) => p.kind === "camera").length;
      chatBtn.lastChild.textContent = `Chat with group (${n})`;
      chatBtn.disabled = !inCall();
    };
    on("state", renderChat);
    const meetLink = h("span.link", "meet.google.com");
    meetLink.addEventListener("click", () => store.state?.url && navigator.clipboard?.writeText(store.state.url));
    const bar = h(
      "footer.bottombar",
      preview,
      h("div.rf-title", h("h2", "Return Feed"), h("div.rf-toggles", micBtn, camBtn)),
      h("div.rf-fields", field2(inputSource.el, "Input Source"), field2(camera.el, "Camera"), field2(mic.el, "Microphone"), field2(speaker.el, "Speaker")),
      h("div.rf-spacer"),
      h("div.rf-stats", h("div.col", cpu, ram), h("div.col", outs, net), perfBtn),
      h("div.rf-right", chatBtn, h("div.version", meetLink, h("span", "v0.2.0 (beta)")))
    );
    render();
    renderSys();
    renderChat();
    return bar;
  }
  function buildShell(root) {
    const tabhost = h("main.tabhost");
    for (const t of TABS) {
      const host = h("section.tab", { dataset: { tab: t.id } });
      host.hidden = true;
      hosts.set(t.id, host);
      tabhost.append(host);
    }
    root.append(topBar(), tabhost, returnFeedBar());
    showTab(inCall() ? "video" : "meeting");
  }
  var TABS, hosts, mounted, current, nav, recStarted;
  var init_shell = __esm({
    "src/control/shell.ts"() {
      "use strict";
      init_kit();
      init_recording();
      init_store();
      init_audio();
      init_meeting();
      init_participants();
      init_video();
      TABS = [
        { id: "meeting", label: "Meeting", mount: mountMeeting },
        { id: "video", label: "Video Outputs", mount: mountVideo },
        { id: "audio", label: "Audio Outputs", mount: mountAudio },
        { id: "participants", label: "Participants", mount: mountParticipants }
      ];
      hosts = /* @__PURE__ */ new Map();
      mounted = /* @__PURE__ */ new Set();
      current = "meeting";
      recStarted = /* @__PURE__ */ new Map();
    }
  });

  // src/control/app.ts
  var require_app = __commonJS({
    "src/control/app.ts"() {
      init_shell();
      init_store();
      void initStore().then(() => {
        buildShell(document.getElementById("app"));
        window.__showTab = (t) => showTab(t);
        let jumped = inCall();
        on("state", () => {
          if (!jumped && inCall()) {
            jumped = true;
            if (document.body.dataset.tab === "meeting") showTab("video");
          }
        });
      });
    }
  });
  require_app();
})();
