// Chalkside on a computer: pictures of the screen or window you share, for the tutor.
// What ScreenCapture.java does on the tablet, done with the browser: a new JPEG only when
// something has changed (moving the mouse doesn't count), at most one a second.

const MAX_SIDE = 1600; // sharp enough for code and slide text
const CHANGED = 20; // summed difference over the grid; the mouse pointer alone comes to about 13
const STRIP = 34; // height of the label across the top, when two screens are shared

// A 32 x 20 grid of average brightness. Each cell averages 20 x 20 pixels of a 640 x 400 copy:
// shrinking straight to 32 x 20 would look at a few pixels per cell and miss small changes.
const GRID_W = 32, GRID_H = 20, CELL = 20;

export class PcScreen extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.active = true; // false while you've hidden your screen from the tutor
    this.seq = 0;
    this.json = '';
    this.label = '';
    this.strip = ''; // e.g. "Screen 2 · the window “Lecture 7”", drawn across the top of each picture
    this.small = document.createElement('canvas');
    this.small.width = GRID_W * CELL;
    this.small.height = GRID_H * CELL;
    this.smallG = this.small.getContext('2d', { willReadFrequently: true });
    this.smallG.imageSmoothingQuality = 'high';
    this.big = document.createElement('canvas');
  }

  get sharing() {
    return !!this.stream;
  }

  // Asks which screen or window to share. Call it from a click: browsers insist.
  async start() {
    this.stop();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 5 } },
      audio: false,
      selfBrowserSurface: 'exclude', // not the Chalkside tab itself
      surfaceSwitching: 'include',
    });
    const track = stream.getVideoTracks()[0];
    this.stream = stream;
    this.label = describe(track);
    this.sent = null;
    this.json = '';
    track.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.stop();
      this.dispatchEvent(new Event('ended')); // Chrome's own "Stop sharing" button
    });
    this.follow(track);
    this.ticker = startTicker(() => this.tick());
    this.dispatchEvent(new Event('started'));
  }

  stop() {
    this.ticker?.stop();
    this.ticker = null;
    this.reader?.stop();
    this.reader = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // With two screens shared, each picture says which it is. A new label means a new picture.
  setStrip(text) {
    if (text === this.strip) return;
    this.strip = text;
    this.sent = null;
  }

  // The newest picture as JSON {seq, w, h, data} if it is newer than `since` (-1: the newest, whatever it is).
  frame(since) {
    if (!this.json || !this.active) return '';
    if (since !== -1 && since >= this.seq) return '';
    return this.json;
  }

  // Keeps the newest frame of the shared screen. MediaStreamTrackProcessor hands over every frame
  // even while this tab is in the background; a <video> is the fallback.
  follow(track) {
    if (typeof MediaStreamTrackProcessor === 'function') {
      try {
        const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        let frame = null, stopped = false;
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (stopped) {
              value.close();
              break;
            }
            frame?.close();
            frame = value;
          }
        })().catch(() => {});
        this.reader = {
          get: () => frame && { img: frame, w: frame.displayWidth, h: frame.displayHeight },
          stop() {
            stopped = true;
            reader.cancel().catch(() => {});
            frame?.close();
            frame = null;
          },
        };
        return;
      } catch {
        /* fall back to a video element */
      }
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    this.reader = {
      get: () => (video.readyState >= 2 && video.videoWidth ? { img: video, w: video.videoWidth, h: video.videoHeight } : null),
      stop: () => (video.srcObject = null),
    };
  }

  signature(img) {
    const g = this.smallG;
    g.drawImage(img, 0, 0, this.small.width, this.small.height);
    const d = g.getImageData(0, 0, this.small.width, this.small.height).data;
    const sums = new Float32Array(GRID_W * GRID_H);
    for (let y = 0; y < this.small.height; y++) {
      const row = ((y / CELL) | 0) * GRID_W;
      for (let x = 0; x < this.small.width; x++) {
        const i = (y * this.small.width + x) * 4;
        sums[row + ((x / CELL) | 0)] += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      }
    }
    return sums.map((s) => s / (CELL * CELL));
  }

  tick() {
    if (!this.active || !this.reader) return;
    const shot = this.reader.get();
    if (!shot) return;
    const sig = this.signature(shot.img);
    if (this.sent && differs(this.sent, sig) < CHANGED) return; // nothing new
    const scale = Math.min(1, MAX_SIDE / Math.max(shot.w, shot.h));
    const c = this.big;
    const top = this.strip ? STRIP : 0;
    c.width = Math.round(shot.w * scale);
    c.height = Math.round(shot.h * scale) + top;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(shot.img, 0, top, c.width, c.height - top);
    if (top) {
      g.fillStyle = '#213a33';
      g.fillRect(0, 0, c.width, top);
      g.fillStyle = '#ffffff';
      g.font = `bold ${Math.round(top * 0.58)}px sans-serif`;
      g.textBaseline = 'middle';
      g.fillText(this.strip, 14, top / 2, c.width - 28);
    }
    const data = c.toDataURL('image/jpeg', 0.8).split(',')[1];
    this.sent = sig;
    this.seq++;
    this.json = JSON.stringify({ seq: this.seq, w: c.width, h: c.height, data });
  }
}

// What is being shared, in words: Chrome labels a window with its title, a screen as "screen:0:0".
function describe(track) {
  const surface = track.getSettings?.().displaySurface;
  if (surface === 'monitor') return 'your whole screen';
  if (surface === 'browser') return 'a browser tab';
  const label = track.label || '';
  return label && !/^(screen|window|web-contents)/i.test(label) && !/^[0-9a-f-]{20,}$/i.test(label) ? `the window “${label}”` : 'a window';
}

function differs(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

// A worker's timer keeps a steady beat when the tab is in the background; the page's own slows down.
function startTicker(fn) {
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000);'], { type: 'text/javascript' })));
    w.onmessage = fn;
    return { stop: () => w.terminate() };
  } catch {
    const id = setInterval(fn, 1000);
    return { stop: () => clearInterval(id) };
  }
}
