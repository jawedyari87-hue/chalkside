// Small shared helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Trailing-edge debounce. With maxWait, a burst of calls still fires at least that often.
export function debounce(fn, wait, maxWait = 0) {
  let timer = 0;
  let first = 0;
  let lastArgs = [];
  const run = () => {
    timer = 0;
    first = 0;
    fn(...lastArgs);
  };
  const debounced = (...args) => {
    lastArgs = args;
    const now = performance.now();
    if (!first) first = now;
    clearTimeout(timer);
    const left = maxWait ? Math.min(wait, Math.max(0, first + maxWait - now)) : wait;
    timer = setTimeout(run, left);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    first = 0;
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  return debounced;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// localStorage that never throws (private windows, blocked storage).
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('chalkside:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('chalkside:' + key, JSON.stringify(value));
    } catch {
      /* storage unavailable: keep going in memory */
    }
  },
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + `, ${time}`;
}

export function toast(message, { kind = 'info', ms = 5000, actionLabel, onAction } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return null;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  el.append(text);
  if (actionLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast__action';
    b.textContent = actionLabel;
    b.addEventListener('click', () => {
      el.remove();
      onAction?.();
    });
    el.append(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast__close';
  x.setAttribute('aria-label', 'Dismiss');
  x.textContent = '×';
  x.addEventListener('click', () => el.remove());
  el.append(x);
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// Downscale an image file or data URL to a JPEG data URL no larger than maxSide.
export async function imageToDataUrl(source, maxSide = 2000, quality = 0.88) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    return { src: c.toDataURL('image/jpeg', quality), width: w, height: h };
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be opened.'));
    img.src = src;
  });
}
