// The student's page: pressure-sensitive ink on squared paper, pasted images,
// and the tutor's red-pen marks. Everything is stored in page units: the page
// is 1000 units wide and grows downwards as you write.

import { clamp, uid } from './util.js';
import { renderInline } from './math.js';

export const PAGE_W = 1000;
const GRID = 40;
const MARGIN_X = 76;
const MIN_GAP = 0.7;
const ERASER_R = 12;

const PALETTES = {
  light: {
    paper: '#fcfcf7', grid: '#d9e4ee', margin: '#eba9a4',
    ink: '#1a2230', blue: '#1f5bc4', red: '#c7362b', green: '#1f7f47',
    hlYellow: 'rgba(255, 208, 0, 0.42)', hlGreen: 'rgba(52, 205, 105, 0.34)', hlPink: 'rgba(255, 90, 170, 0.30)',
  },
  dark: {
    paper: '#1b201f', grid: '#28322f', margin: '#5b3431',
    ink: '#e8edf0', blue: '#8db8ff', red: '#ff8b7e', green: '#7fd69d',
    hlYellow: 'rgba(255, 214, 0, 0.30)', hlGreen: 'rgba(80, 230, 130, 0.26)', hlPink: 'rgba(255, 110, 190, 0.26)',
  },
};
// The tutor always sees dark ink on white paper, whatever the screen theme.
const FRAME_PALETTE = { ...PALETTES.light, paper: '#ffffff' };

export const PEN_COLOURS = ['ink', 'blue', 'red', 'green'];
export const HL_COLOURS = ['hlYellow', 'hlGreen', 'hlPink'];
export const SIZES = { pen: [2.2, 3.4, 5.4], hl: [14, 22, 32] };
export const SWATCH = (name, theme = 'light') => PALETTES[theme][name];

// ---- stroke geometry ---------------------------------------------------------

const penRadius = (w, p) => (w / 2) * (0.3 + 0.7 * Math.pow(clamp(p, 0.02, 1), 0.65));

function circle(path, x, y, r) {
  path.moveTo(x + r, y);
  path.arc(x, y, r, 0, Math.PI * 2);
}

// One quad per segment. A→D→C→B winds the same way as arc(), so the circles and
// quads overlap cleanly under the nonzero fill rule, even at sharp corners.
function segment(path, x0, y0, r0, x1, y1, r1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = -dy / len;
  const ny = dx / len;
  path.moveTo(x0 + nx * r0, y0 + ny * r0);
  path.lineTo(x0 - nx * r0, y0 - ny * r0);
  path.lineTo(x1 - nx * r1, y1 - ny * r1);
  path.lineTo(x1 + nx * r1, y1 + ny * r1);
  path.closePath();
}

// Pen path for points [from .. end]. from > 0 extends an in-progress stroke.
function penPath(pts, w, from = 0, path = new Path2D()) {
  const n = pts.length / 3;
  if (n === 1) {
    circle(path, pts[0], pts[1], Math.max(penRadius(w, pts[2]), w * 0.32));
    return path;
  }
  let i = Math.max(0, from);
  let px = pts[i * 3];
  let py = pts[i * 3 + 1];
  let pr = penRadius(w, pts[i * 3 + 2]);
  if (i === 0) circle(path, px, py, pr);
  for (i += 1; i < n; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const r = penRadius(w, pts[i * 3 + 2]);
    segment(path, px, py, pr, x, y, r);
    circle(path, x, y, r);
    px = x;
    py = y;
    pr = r;
  }
  return path;
}

function polyPath(pts) {
  const p = new Path2D();
  p.moveTo(pts[0], pts[1]);
  if (pts.length === 3) p.lineTo(pts[0] + 0.01, pts[1]);
  for (let i = 3; i < pts.length; i += 3) p.lineTo(pts[i], pts[i + 1]);
  return p;
}

function strokePath(s) {
  if (!s._path) s._path = s.tool === 'hl' ? polyPath(s.pts) : penPath(s.pts, s.w);
  return s._path;
}

function boxOf(pts, w) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  const r = w / 2 + 1;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHit(s, x, y, r) {
  const pts = s.pts;
  const rr = r + s.w / 2;
  if (pts.length === 3) return Math.hypot(x - pts[0], y - pts[1]) <= rr;
  for (let i = 3; i < pts.length; i += 3) {
    if (distToSeg(x, y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1]) <= rr) return true;
  }
  return false;
}

const itemBottom = (it) => (it.type === 'image' ? it.y + it.h : it.box[3]);
const itemBox = (it) => (it.type === 'image' ? [it.x, it.y, it.x + it.w, it.y + it.h] : it.box);

// ---- the tutor's marks -----------------------------------------------------------

function wobblyEllipse() {
  const pts = [];
  const start = -1.9;
  const sweep = Math.PI * 2 + 0.55;
  for (let k = 0; k <= 48; k++) {
    const a = start + (sweep * k) / 48;
    const r = 1 + 0.035 * Math.sin(a * 3 + 1) - 0.06 * (k / 48);
    pts.push(`${(50 + 50 * r * Math.cos(a)).toFixed(1)} ${(50 + 50 * r * Math.sin(a)).toFixed(1)}`);
  }
  return 'M' + pts.join(' L');
}
const ELLIPSE_D = wobblyEllipse();
const MARK_SHAPES = {
  mistake: `<svg class="mk__shape mk__shape--ring" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="${ELLIPSE_D}"/></svg>`,
  correct: '<svg class="mk__shape mk__shape--tick" viewBox="0 0 40 40" aria-hidden="true"><path pathLength="1" d="M5 22 C9 25 12 28 15 33 C20 22 27 13 36 5"/></svg>',
  check:
    '<svg class="mk__shape mk__shape--wave" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M0 6 Q5 0 10 6 T20 6 T30 6 T40 6 T50 6 T60 6 T70 6 T80 6 T90 6 T100 6"/></svg>',
  note: '<svg class="mk__shape mk__shape--bracket" viewBox="0 0 12 100" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M11 2 C3 2 3 3 3 12 L3 88 C3 97 3 98 11 98"/></svg>',
};
const VERDICTS = ['correct', 'mistake', 'check', 'note'];

// ---- the page -----------------------------------------------------------------------

export class InkPage extends EventTarget {
  constructor(host) {
    super();
    this.host = host;
    this.items = [];
    this.marks = [];
    this.undoStack = [];
    this.redoStack = [];
    this.scrollY = 0;
    this.tool = 'pen';
    this.penColour = 'ink';
    this.hlColour = 'hlYellow';
    this.sizeIdx = 1;
    this.fingerMode = 'auto';
    this.penSeen = false;
    this.theme = 'light';
    this.gridStyle = 'squares';
    this.version = 0;
    this.selected = null;
    this.drawPtr = null;
    this.cur = null;
    this.erasing = null;
    this.touches = new Map();
    this.ignored = new Set();
    this.lastPenAt = 0;
    this.velocity = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.scale = 1;
    this.dpr = 1;

    const mk = (tag, cls) => {
      const el = document.createElement(tag);
      el.className = cls;
      return el;
    };
    this.bg = mk('canvas', 'ink-bg');
    this.cv = mk('canvas', 'ink-content');
    this.marksLayer = mk('div', 'ink-marks');
    this.marksInner = mk('div', 'ink-marks__inner');
    this.marksLayer.append(this.marksInner);
    this.live = mk('canvas', 'ink-live');
    this.selLayer = mk('div', 'ink-sel');
    this.bar = mk('div', 'ink-bar');
    this.thumb = mk('div', 'ink-bar__thumb');
    this.bar.append(this.thumb);
    this.hint = mk('div', 'ink-hint');
    this.hint.textContent = 'Write here with your S Pen';
    this.live.setAttribute('aria-label', 'Your page. Write with the stylus; drag with a finger to scroll.');
    host.append(this.bg, this.cv, this.marksLayer, this.live, this.selLayer, this.bar, this.hint);
    this.gBg = this.bg.getContext('2d');
    this.g = this.cv.getContext('2d');
    this.gLive = this.live.getContext('2d', { desynchronized: true }) || this.live.getContext('2d');

    const L = this.live;
    L.addEventListener('pointerdown', (e) => this.onDown(e));
    L.addEventListener('pointermove', (e) => this.onMove(e));
    L.addEventListener('pointerup', (e) => this.onUp(e, false));
    L.addEventListener('pointercancel', (e) => this.onUp(e, true));
    L.addEventListener('pointerleave', (e) => {
      if (!this.drawPtr && e.pointerType === 'pen') this.clearLive();
    });
    L.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.stopMomentum();
        this.scrollBy((e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY) / this.scale);
      },
      { passive: false },
    );
    L.addEventListener('contextmenu', (e) => e.preventDefault());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  // ---- settings ----

  get palette() {
    return PALETTES[this.theme] || PALETTES.light;
  }
  setTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    this.renderAll();
  }
  setGrid(style) {
    this.gridStyle = style;
    this.renderBg();
  }
  setTool(tool) {
    this.tool = tool;
    if (tool !== 'move') this.select(null);
    this.clearLive();
    this.host.dataset.tool = tool;
    this.dispatchEvent(new Event('tool'));
  }
  setPenColour(c) {
    this.penColour = c;
  }
  setHlColour(c) {
    this.hlColour = c;
  }
  setSize(i) {
    this.sizeIdx = clamp(i, 0, 2);
  }
  setFingerMode(m) {
    this.fingerMode = m;
  }
  touchDraws() {
    return this.fingerMode === 'draw' || (this.fingerMode === 'auto' && !this.penSeen);
  }

  // ---- geometry ----

  get viewH() {
    return this.cssH / this.scale;
  }
  get height() {
    let bottom = 0;
    for (const it of this.items) bottom = Math.max(bottom, itemBottom(it));
    return Math.max(bottom + 1400, this.viewH * 2, 2600);
  }
  contentBottom() {
    let bottom = 0;
    for (const it of this.items) bottom = Math.max(bottom, itemBottom(it));
    return bottom;
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    this.rect = r;
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.scale = r.width / PAGE_W;
    for (const c of [this.bg, this.cv, this.live]) {
      c.width = Math.round(r.width * this.dpr);
      c.height = Math.round(r.height * this.dpr);
    }
    this.marksLayer.style.setProperty('--mk-scale', String(this.scale));
    this.clampScroll();
    this.renderAll(true);
    this.dispatchEvent(new Event('viewport'));
  }

  toPage(e) {
    const r = this.rect;
    let p = e.pressure;
    if (e.pointerType !== 'pen' || !(p > 0)) p = e.pointerType === 'pen' ? 0.45 : 0.55;
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale + this.scrollY, p };
  }

  clampScroll() {
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, this.height - this.viewH));
  }

  scrollBy(dy) {
    this.scrollTo(this.scrollY + dy);
  }

  scrollTo(y) {
    const before = this.scrollY;
    this.scrollY = y;
    this.clampScroll();
    if (this.scrollY !== before) {
      this.requestRender();
      this.showBar();
      this.dispatchEvent(new Event('viewport'));
    }
  }

  // ---- rendering ----

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderAll();
    });
  }

  renderAll(relayoutMarks = false) {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    this.renderBg();
    this.renderContent();
    this.layoutMarks(relayoutMarks);
    this.layoutSel();
    this.updateBar();
  }

  setXform(g) {
    const k = this.dpr * this.scale;
    g.setTransform(k, 0, 0, k, 0, -this.scrollY * k);
  }

  renderBg() {
    const g = this.gBg;
    const pal = this.palette;
    const W = this.bg.width;
    const H = this.bg.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = pal.paper;
    g.fillRect(0, 0, W, H);
    if (this.gridStyle === 'plain') return;
    // Grid lines in device pixels so they stay crisp.
    const k = this.dpr * this.scale;
    const y0 = this.scrollY;
    const y1 = y0 + this.viewH;
    g.lineWidth = Math.max(1, Math.round(this.dpr * 0.9));
    g.strokeStyle = pal.grid;
    g.beginPath();
    if (this.gridStyle === 'squares') {
      for (let x = GRID; x < PAGE_W; x += GRID) {
        const px = Math.round(x * k) + 0.5;
        g.moveTo(px, 0);
        g.lineTo(px, H);
      }
    }
    for (let y = Math.ceil(y0 / GRID) * GRID; y <= y1; y += GRID) {
      const py = Math.round((y - y0) * k) + 0.5;
      g.moveTo(0, py);
      g.lineTo(W, py);
    }
    g.stroke();
    g.strokeStyle = pal.margin;
    g.lineWidth = Math.max(1, Math.round(this.dpr * 1.4));
    g.beginPath();
    const mx = Math.round(MARGIN_X * k) + 0.5;
    g.moveTo(mx, 0);
    g.lineTo(mx, H);
    g.stroke();
  }

  renderContent() {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    this.setXform(g);
    this.drawItems(g, this.palette, this.scrollY - 40, this.scrollY + this.viewH + 40);
  }

  drawItems(g, pal, y0, y1, bolder = 0) {
    for (const it of this.items) {
      if (it.type === 'image' && it.y < y1 && it.y + it.h > y0) this.drawImage(g, it);
    }
    for (const pass of ['hl', 'pen']) {
      for (const it of this.items) {
        if (it.type !== 'stroke' || it.tool !== pass || it.box[1] > y1 || it.box[3] < y0) continue;
        const path = strokePath(it);
        if (it.tool === 'hl') {
          g.strokeStyle = pal[it.colour] || pal.hlYellow;
          g.lineWidth = it.w;
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.stroke(path);
        } else {
          g.fillStyle = pal[it.colour] || pal.ink;
          g.fill(path);
          if (bolder) {
            g.strokeStyle = g.fillStyle;
            g.lineWidth = bolder;
            g.lineJoin = 'round';
            g.stroke(path);
          }
        }
      }
    }
  }

  drawImage(g, it) {
    if (!it._img) {
      it._img = new Image();
      it._img.onload = () => {
        this.requestRender();
        this.version++;
        this.dispatchEvent(new CustomEvent('change', { detail: { kind: 'image-loaded' } }));
      };
      it._img.src = it.src;
      return;
    }
    if (!it._img.complete || !it._img.naturalWidth) return;
    g.drawImage(it._img, it.x, it.y, it.w, it.h);
    g.lineWidth = 1.2;
    g.strokeStyle = 'rgba(30, 40, 50, 0.18)';
    g.strokeRect(it.x, it.y, it.w, it.h);
  }

  clearLive() {
    const g = this.gLive;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.live.width, this.live.height);
  }

  drawLive() {
    const c = this.cur;
    if (!c) return;
    const g = this.gLive;
    if (c.tool === 'hl') {
      this.clearLive();
      this.setXform(g);
      g.strokeStyle = this.palette[c.colour];
      g.lineWidth = c.w;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke(polyPath(c.pts));
      return;
    }
    // Opaque ink: draw only the new segments.
    this.setXform(g);
    g.fillStyle = this.palette[c.colour] || this.palette.ink;
    const n = c.pts.length / 3;
    if (c.drawn === 0) {
      g.fill(penPath(c.pts.slice(0, 3), c.w));
      c.drawn = 1;
    }
    if (n > c.drawn) {
      g.fill(penPath(c.pts, c.w, c.drawn - 1));
      c.drawn = n;
    }
  }

  drawEraserRing(e) {
    const g = this.gLive;
    this.clearLive();
    const p = this.toPage(e);
    this.setXform(g);
    g.beginPath();
    g.arc(p.x, p.y, ERASER_R, 0, Math.PI * 2);
    g.lineWidth = 1.5 / this.scale;
    g.strokeStyle = this.theme === 'dark' ? 'rgba(232,237,240,0.7)' : 'rgba(26,34,48,0.55)';
    g.stroke();
  }

  // ---- pointer input ----

  onDown(e) {
    const now = performance.now();
    const touch = e.pointerType === 'touch';
    if (e.pointerType === 'pen') {
      this.penSeen = true;
      this.lastPenAt = now;
      // A palm that landed first must not keep scrolling the page under the pen.
      if (this.touches.size) {
        for (const id of this.touches.keys()) this.ignored.add(id);
        this.touches.clear();
      }
      this.stopMomentum();
    } else if (touch && this.penSeen) {
      // Palm rejection: ignore touches while the pen hovers nearby, and palm-sized contacts.
      if (now - this.lastPenAt < 350 || e.width > 38 || e.height > 38) {
        this.ignored.add(e.pointerId);
        return;
      }
    }
    this.rect = this.host.getBoundingClientRect();
    if (this.drawPtr && this.drawPtr.id !== e.pointerId) {
      // Already drawing. A quick second finger turns a finger stroke into a scroll; anything else is a palm.
      if (touch && this.drawPtr.type === 'touch' && performance.now() - this.drawPtr.t0 < 300) {
        this.abortDraw();
        this.addTouch(e);
      }
      return;
    }
    this.stopMomentum();
    if (touch) {
      const hitImg = this.tool === 'move' ? this.hitImage(this.toPage(e)) : null;
      if (!hitImg && (!this.touchDraws() || this.touches.size > 0 || this.tool === 'move')) {
        this.addTouch(e);
        return;
      }
    }
    if (e.pointerType === 'mouse' && e.button === 1) {
      this.addTouch(e);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers can't be captured */
    }
    const penEraser = e.pointerType === 'pen' && (e.buttons & 32 || e.buttons & 2 || e.button === 5 || e.button === 2);
    this.drawPtr = { id: e.pointerId, type: e.pointerType, t0: performance.now(), mode: 'stroke' };
    if (this.tool === 'move' && !penEraser) this.startMove(e);
    else if (this.tool === 'eraser' || penEraser) this.startErase(e);
    else this.startStroke(e);
  }

  onMove(e) {
    if (e.pointerType === 'pen') this.lastPenAt = performance.now();
    if (this.ignored.has(e.pointerId)) return;
    if (this.touches.has(e.pointerId)) {
      if (this.drawPtr?.type !== 'pen') this.moveTouch(e);
      return;
    }
    const d = this.drawPtr;
    if (!d || d.id !== e.pointerId) {
      if (!d && e.pointerType === 'pen' && this.tool === 'eraser') {
        this.rect = this.host.getBoundingClientRect();
        this.drawEraserRing(e);
      }
      return;
    }
    e.preventDefault();
    if (d.mode === 'stroke' && this.cur) {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      for (const ce of list && list.length ? list : [e]) this.addPoint(this.toPage(ce));
      this.drawLive();
    } else if (d.mode === 'erase') {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      for (const ce of list && list.length ? list : [e]) this.eraseAt(this.toPage(ce));
      this.drawEraserRing(e);
    } else if (d.mode === 'move') {
      this.dragImage(e);
    }
  }

  onUp(e, cancelled) {
    if (this.ignored.delete(e.pointerId)) return;
    if (this.touches.has(e.pointerId)) {
      this.removeTouch(e);
      return;
    }
    const d = this.drawPtr;
    if (!d || d.id !== e.pointerId) return;
    this.drawPtr = null;
    if (d.mode === 'stroke') this.finishStroke(cancelled ? null : e);
    else if (d.mode === 'erase') this.finishErase();
    else if (d.mode === 'move') this.finishMove(d);
  }

  abortDraw() {
    const d = this.drawPtr;
    this.drawPtr = null;
    if (!d) return;
    if (d.mode === 'stroke') {
      this.cur = null;
      this.clearLive();
    } else if (d.mode === 'erase') this.finishErase();
    else if (d.mode === 'move') this.finishMove(d);
  }

  // ---- strokes ----

  startStroke(e) {
    const p = this.toPage(e);
    const tool = this.tool === 'hl' ? 'hl' : 'pen';
    this.drawPtr.mode = 'stroke';
    this.cur = {
      tool,
      colour: tool === 'hl' ? this.hlColour : this.penColour,
      w: SIZES[tool][this.sizeIdx],
      pts: [p.x, p.y, p.p],
      sx: p.x,
      sy: p.y,
      sp: p.p,
      drawn: 0,
    };
    this.hint.hidden = true;
    this.drawLive();
  }

  addPoint(p) {
    const c = this.cur;
    const k = c.tool === 'hl' ? 0.35 : 0.6;
    c.sx += (p.x - c.sx) * k;
    c.sy += (p.y - c.sy) * k;
    c.sp += (p.p - c.sp) * 0.35;
    const n = c.pts.length;
    const dx = c.sx - c.pts[n - 3];
    const dy = c.sy - c.pts[n - 2];
    if (dx * dx + dy * dy < MIN_GAP * MIN_GAP) return;
    c.pts.push(c.sx, c.sy, c.sp);
  }

  finishStroke(e) {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    if (e) {
      // Catch up with where the pen actually lifted.
      const p = this.toPage(e);
      const n = c.pts.length;
      if (Math.hypot(p.x - c.pts[n - 3], p.y - c.pts[n - 2]) > MIN_GAP) c.pts.push(p.x, p.y, c.sp * 0.9);
    }
    // A typed array keeps saving cheap: long pages hold hundreds of thousands of numbers.
    const pts = Float32Array.from(c.pts);
    const item = { id: uid(), type: 'stroke', tool: c.tool, colour: c.colour, w: c.w, pts, box: boxOf(pts, c.tool === 'hl' ? c.w : c.w * 1.2) };
    this.items.push(item);
    this.pushUndo({ op: 'add', items: [item] });
    // A full redraw keeps highlighter strokes underneath the ink.
    this.renderContent();
    this.clearLive();
    this.changed('stroke');
  }

  // ---- eraser ----

  startErase(e) {
    this.drawPtr.mode = 'erase';
    this.erasing = { removed: [], marks: 0 };
    this.eraseAt(this.toPage(e));
    this.drawEraserRing(e);
  }

  eraseAt(p) {
    const r = ERASER_R;
    let hit = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type !== 'stroke') continue;
      const b = it.box;
      if (p.x < b[0] - r || p.x > b[2] + r || p.y < b[1] - r || p.y > b[3] + r) continue;
      if (strokeHit(it, p.x, p.y, r)) {
        this.items.splice(i, 1);
        this.erasing.removed.push({ item: it, index: i });
        hit = true;
      }
    }
    let marksHit = false;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      if (p.x >= m.x - r && p.x <= m.x + m.w + r && p.y >= m.y - r && p.y <= m.y + m.h + r) {
        this.marks.splice(i, 1);
        marksHit = true;
      }
    }
    if (hit) this.renderContent();
    if (marksHit) {
      this.erasing.marks++;
      this.layoutMarks();
      this.dispatchEvent(new Event('marks'));
    }
  }

  finishErase() {
    const er = this.erasing;
    this.erasing = null;
    this.clearLive();
    if (er && er.removed.length) {
      this.pushUndo({ op: 'erase', entries: er.removed });
      this.changed('erase');
    }
  }

  // ---- images ----

  hitImage(p) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type === 'image' && p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) return it;
    }
    return null;
  }

  addImage({ src, width, height }) {
    const maxW = PAGE_W - MARGIN_X - 48;
    const aspect = height / width;
    let w = maxW * (aspect > 1.15 ? 0.72 : 1);
    let h = w * aspect;
    const maxH = Math.max(320, this.viewH * 0.85);
    if (h > maxH) {
      h = maxH;
      w = h / aspect;
    }
    // Below the existing writing, or near the top of the view, clear of the toolbar.
    const TOP_GAP = 90;
    const bottom = this.contentBottom();
    const y = bottom < this.scrollY + 20 ? this.scrollY + TOP_GAP : bottom + 40;
    const item = { id: uid(), type: 'image', src, x: MARGIN_X + 24, y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    this.items.push(item);
    this.pushUndo({ op: 'add', items: [item] });
    this.hint.hidden = true;
    if (item.y + item.h > this.scrollY + this.viewH || item.y < this.scrollY + TOP_GAP) this.scrollTo(item.y - TOP_GAP);
    this.setTool('move');
    this.select(item.id);
    this.renderContent();
    this.changed('image');
    return item;
  }

  select(id) {
    this.selected = id;
    this.layoutSel();
  }

  startMove(e) {
    const p = this.toPage(e);
    const img = this.hitImage(p);
    if (!img) {
      this.select(null);
      this.drawPtr.mode = 'none';
      return;
    }
    this.select(img.id);
    this.drawPtr.mode = 'move';
    this.drawPtr.img = img;
    this.drawPtr.start = p;
    this.drawPtr.orig = { x: img.x, y: img.y, w: img.w, h: img.h };
    this.drawPtr.resize = false;
  }

  startResize(e, img) {
    this.rect = this.host.getBoundingClientRect();
    this.drawPtr = {
      id: e.pointerId, type: e.pointerType, t0: performance.now(), mode: 'move', img, start: this.toPage(e),
      orig: { x: img.x, y: img.y, w: img.w, h: img.h }, resize: true,
    };
  }

  dragImage(e) {
    const d = this.drawPtr;
    const p = this.toPage(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const img = d.img;
    if (d.resize) {
      const w = clamp(d.orig.w + dx, 80, PAGE_W * 1.2);
      img.w = Math.round(w);
      img.h = Math.round(w * (d.orig.h / d.orig.w));
    } else {
      img.x = Math.round(clamp(d.orig.x + dx, -img.w * 0.6, PAGE_W - img.w * 0.4));
      img.y = Math.round(Math.max(0, d.orig.y + dy));
    }
    this.renderContent();
    this.layoutSel();
  }

  finishMove(d) {
    if (!d || !d.img) return;
    const img = d.img;
    const to = { x: img.x, y: img.y, w: img.w, h: img.h };
    const from = d.orig;
    if (from.x !== to.x || from.y !== to.y || from.w !== to.w) {
      this.pushUndo({ op: 'xform', id: img.id, from, to });
      this.changed('image');
    }
  }

  deleteSelected() {
    const i = this.items.findIndex((it) => it.id === this.selected);
    if (i < 0) return;
    const [item] = this.items.splice(i, 1);
    this.pushUndo({ op: 'erase', entries: [{ item, index: i }] });
    this.select(null);
    this.renderContent();
    this.changed('erase');
  }

  layoutSel() {
    const img = this.selected && this.items.find((it) => it.id === this.selected);
    if (!img || this.tool !== 'move') {
      this.selLayer.replaceChildren();
      return;
    }
    let box = this.selLayer.firstElementChild;
    if (!box || box.dataset.id !== img.id) {
      box = document.createElement('div');
      box.className = 'sel-box';
      box.dataset.id = img.id;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sel-del';
      del.setAttribute('aria-label', 'Delete image');
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.deleteSelected();
      });
      const handle = document.createElement('div');
      handle.className = 'sel-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          handle.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        const target = this.items.find((it) => it.id === this.selected);
        if (target) this.startResize(ev, target);
      });
      handle.addEventListener('pointermove', (ev) => {
        if (this.drawPtr && this.drawPtr.id === ev.pointerId && this.drawPtr.resize) this.dragImage(ev);
      });
      const end = (ev) => {
        const d = this.drawPtr;
        if (d && d.id === ev.pointerId) {
          this.drawPtr = null;
          this.finishMove(d);
        }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      box.append(del, handle);
      this.selLayer.replaceChildren(box);
    }
    const k = this.scale;
    box.style.left = `${img.x * k}px`;
    box.style.top = `${(img.y - this.scrollY) * k}px`;
    box.style.width = `${img.w * k}px`;
    box.style.height = `${img.h * k}px`;
  }

  // ---- touch scrolling ----

  addTouch(e) {
    try {
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.touches.set(e.pointerId, { y: e.clientY });
    this.panY = this.avgTouchY();
    this.panT = performance.now();
    this.velocity = 0;
  }

  avgTouchY() {
    let s = 0;
    for (const t of this.touches.values()) s += t.y;
    return s / Math.max(1, this.touches.size);
  }

  moveTouch(e) {
    const t = this.touches.get(e.pointerId);
    t.y = e.clientY;
    const y = this.avgTouchY();
    const now = performance.now();
    const dy = (y - this.panY) / this.scale;
    const dt = Math.max(1, now - this.panT);
    this.scrollBy(-dy);
    this.velocity = this.velocity * 0.6 + (-dy / dt) * 0.4;
    this.panY = y;
    this.panT = now;
  }

  removeTouch(e) {
    this.touches.delete(e.pointerId);
    if (this.touches.size) {
      this.panY = this.avgTouchY();
      return;
    }
    if (performance.now() - this.panT > 80) this.velocity = 0;
    if (Math.abs(this.velocity) > 0.05) this.startMomentum();
  }

  startMomentum() {
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      this.scrollBy(this.velocity * dt);
      this.velocity *= Math.pow(0.94, dt / 16);
      const atEdge = this.scrollY <= 0 || this.scrollY >= this.height - this.viewH;
      if (Math.abs(this.velocity) < 0.02 || atEdge) {
        this.momentum = 0;
        return;
      }
      this.momentum = requestAnimationFrame(step);
    };
    this.momentum = requestAnimationFrame(step);
  }

  stopMomentum() {
    if (this.momentum) cancelAnimationFrame(this.momentum);
    this.momentum = 0;
    this.velocity = 0;
  }

  showBar() {
    this.bar.classList.add('is-active');
    clearTimeout(this._barT);
    this._barT = setTimeout(() => this.bar.classList.remove('is-active'), 900);
  }

  updateBar() {
    const total = this.height;
    const frac = Math.min(1, this.viewH / total);
    this.thumb.style.height = `${frac * 100}%`;
    this.thumb.style.top = `${(this.scrollY / total) * 100}%`;
  }

  // ---- undo / redo ----

  pushUndo(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dispatchEvent(new Event('history'));
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.applyOp(op, true);
    this.redoStack.push(op);
    this.afterHistory();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.applyOp(op, false);
    this.undoStack.push(op);
    this.afterHistory();
  }

  applyOp(op, inverse) {
    const removeIds = (ids) => {
      const set = new Set(ids);
      this.items = this.items.filter((it) => !set.has(it.id));
    };
    if (op.op === 'add') {
      if (inverse) removeIds(op.items.map((i) => i.id));
      else this.items.push(...op.items);
    } else if (op.op === 'erase') {
      if (inverse) {
        for (let k = op.entries.length - 1; k >= 0; k--) {
          const { item, index } = op.entries[k];
          this.items.splice(Math.min(index, this.items.length), 0, item);
        }
      } else removeIds(op.entries.map((e) => e.item.id));
    } else if (op.op === 'xform') {
      const img = this.items.find((it) => it.id === op.id);
      if (img) Object.assign(img, inverse ? op.from : op.to);
    } else if (op.op === 'clear') {
      this.items = inverse ? op.items.slice() : [];
    }
  }

  afterHistory() {
    if (this.selected && !this.items.some((it) => it.id === this.selected)) this.selected = null;
    this.hint.hidden = this.items.length > 0;
    this.clampScroll();
    this.renderAll();
    this.dispatchEvent(new Event('history'));
    this.changed('history');
  }

  clearPage() {
    if (!this.items.length) return;
    this.pushUndo({ op: 'clear', items: this.items.slice() });
    this.items = [];
    this.marks = [];
    this.selected = null;
    this.scrollY = 0;
    this.hint.hidden = false;
    this.renderAll();
    this.dispatchEvent(new Event('marks'));
    this.changed('clear');
  }

  changed(kind) {
    this.version++;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  // ---- the tutor's marks ----

  addMarks(marks, frameRect) {
    if (!Array.isArray(marks)) throw new Error('marks must be a list');
    const rect = frameRect || { x: 0, y: this.scrollY, w: PAGE_W, h: this.viewH };
    let n = 0;
    for (const m of marks.slice(0, 12)) {
      let b = Array.isArray(m?.box_2d) ? m.box_2d.map(Number) : null;
      if (!b || b.length !== 4 || b.some((v) => !Number.isFinite(v))) continue;
      // Accept boxes given on a 0-1 scale as well as the asked-for 0-1000.
      if (b.every((v) => v >= 0 && v <= 1) && b.some((v) => v > 0)) b = b.map((v) => v * 1000);
      let [ymin, xmin, ymax, xmax] = b.map((v) => clamp(v, 0, 1000));
      if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
      if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
      const x = rect.x + (xmin / 1000) * rect.w;
      const y = rect.y + (ymin / 1000) * rect.h;
      const w = Math.max(16, ((xmax - xmin) / 1000) * rect.w);
      const h = Math.max(16, ((ymax - ymin) / 1000) * rect.h);
      const verdict = VERDICTS.includes(m.verdict) ? m.verdict : 'note';
      this.marks.push({ id: uid(), verdict, label: String(m.label ?? '').trim().slice(0, 80), x, y, w, h, t: Date.now(), fresh: true });
      n++;
    }
    if (!n) throw new Error('no usable box_2d values; send [ymin, xmin, ymax, xmax] from 0 to 1000');
    this.layoutMarks();
    this.dispatchEvent(new Event('marks'));
    return n;
  }

  clearMarks() {
    if (!this.marks.length) return;
    this.marks = [];
    this.layoutMarks();
    this.dispatchEvent(new Event('marks'));
  }

  layoutMarks(force = false) {
    const k = this.scale;
    this.marksInner.style.transform = `translate3d(0, ${(-this.scrollY * k).toFixed(2)}px, 0)`;
    const existing = new Map(Array.from(this.marksInner.children, (el) => [el.dataset.id, el]));
    for (const m of this.marks) {
      let el = existing.get(m.id);
      if (el) existing.delete(m.id);
      else {
        el = this.renderMark(m);
        this.marksInner.append(el);
        force = true;
      }
      if (force || !el.dataset.k || Number(el.dataset.k) !== k) {
        el.style.left = `${m.x * k}px`;
        el.style.top = `${m.y * k}px`;
        el.style.width = `${m.w * k}px`;
        el.style.height = `${m.h * k}px`;
        el.dataset.k = String(k);
      }
    }
    for (const el of existing.values()) el.remove();
  }

  renderMark(m) {
    const el = document.createElement('div');
    const below = m.x + m.w > PAGE_W * 0.64;
    el.className = `mk mk--${m.verdict}${below ? ' mk--below' : ''}`;
    el.dataset.id = m.id;
    el.innerHTML = MARK_SHAPES[m.verdict] || MARK_SHAPES.note;
    if (m.label) {
      const label = document.createElement('div');
      label.className = 'mk__label';
      label.innerHTML = renderInline(m.label);
      el.append(label);
    }
    if (m.fresh && !matchMedia('(prefers-reduced-motion: reduce)').matches) el.classList.add('is-fresh');
    m.fresh = false;
    return el;
  }

  // ---- what the tutor sees ----

  // Render the visible part of the page, cropped to the writing, as dark ink on white.
  snapshot({ maxSide = 1024 } = {}) {
    const view = { x: 0, y: this.scrollY, w: PAGE_W, h: this.viewH };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const it of this.items) {
      const b = itemBox(it);
      if (b[3] < view.y || b[1] > view.y + view.h) continue;
      x0 = Math.min(x0, b[0]);
      y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    let rect = view;
    const empty = !(x1 > x0);
    if (!empty) {
      const pad = 36;
      let rx0 = clamp(x0 - pad, 0, PAGE_W);
      let rx1 = clamp(x1 + pad, 0, PAGE_W);
      let ry0 = clamp(y0 - pad, view.y, view.y + view.h);
      let ry1 = clamp(y1 + pad, view.y, view.y + view.h);
      if (rx1 - rx0 < 480) {
        const c = (rx0 + rx1) / 2;
        rx0 = clamp(c - 240, 0, PAGE_W - 480);
        rx1 = rx0 + 480;
      }
      const minH = Math.min(320, view.h);
      if (ry1 - ry0 < minH) {
        const c = (ry0 + ry1) / 2;
        ry0 = clamp(c - minH / 2, view.y, view.y + view.h - minH);
        ry1 = ry0 + minH;
      }
      rect = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
    }
    const s = Math.min(maxSide / Math.max(rect.w, rect.h), 2);
    const cw = Math.max(1, Math.round(rect.w * s));
    const ch = Math.max(1, Math.round(rect.h * s));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d');
    g.fillStyle = FRAME_PALETTE.paper;
    g.fillRect(0, 0, cw, ch);
    g.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);
    this.drawItems(g, FRAME_PALETTE, rect.y, rect.y + rect.h, 1.1 / s);
    return { canvas: c, rect, empty };
  }

  // The whole page as one image, for printing.
  snapshotAll({ maxW = 1400 } = {}) {
    const bottom = Math.max(400, this.contentBottom() + 40);
    const s = Math.min(maxW / PAGE_W, 12000 / bottom);
    const c = document.createElement('canvas');
    c.width = Math.round(PAGE_W * s);
    c.height = Math.round(bottom * s);
    const g = c.getContext('2d');
    g.fillStyle = FRAME_PALETTE.paper;
    g.fillRect(0, 0, c.width, c.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    this.drawItems(g, FRAME_PALETTE, 0, bottom);
    return c.toDataURL('image/jpeg', 0.9);
  }

  // ---- persistence ----

  serialize() {
    return {
      items: this.items.map(({ _path, _img, ...rest }) => rest),
      marks: this.marks.map(({ fresh, ...m }) => m),
      scrollY: Math.round(this.scrollY),
    };
  }

  load(data) {
    this.items = Array.isArray(data?.items) ? data.items.map((it) => ({ ...it })) : [];
    this.marks = Array.isArray(data?.marks) ? data.marks.map((m) => ({ ...m, fresh: false })) : [];
    this.scrollY = Number(data?.scrollY) || 0;
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null;
    this.cur = null;
    this.drawPtr = null;
    this.hint.hidden = this.items.length > 0;
    this.version++;
    this.marksInner.replaceChildren();
    this.clampScroll();
    this.renderAll(true);
    this.dispatchEvent(new Event('history'));
    this.dispatchEvent(new Event('marks'));
  }
}
