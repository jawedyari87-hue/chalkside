// Chalkside on a computer (?overlay&pc): the "app" side of the floating tutor, which the Android
// app provides on a tablet as window.ChalksideAndroid. Screen pictures come from the Chalkside PC
// page (pc/), which shares a screen or window and holds the always-on-top window this page runs
// in. Opened on its own, the page shares the screen itself when a lesson starts.

import { PcScreen } from './pccapture.js';

// The Chalkside PC page around this one, if any: { screen, close(), resize(mode, w, h) }.
function hostPage() {
  try {
    return window.parent !== window ? window.parent.chalksidePc || null : null;
  } catch {
    return null; // someone else's page
  }
}

export function pcBridge() {
  const host = hostPage();
  const screen = host?.screen || new PcScreen();
  const send = (type) => window.chalksideNative?.(type);
  const onEnded = () => send('screen-stopped');
  const onStarted = () => send('screen-started');
  screen.addEventListener('ended', onEnded);
  screen.addEventListener('started', onStarted);
  window.addEventListener('pagehide', () => {
    screen.removeEventListener('ended', onEnded);
    screen.removeEventListener('started', onStarted);
    if (!host) screen.stop();
  });

  return {
    hosted: !!host, // the Chalkside PC page holds the share
    floating: !!host?.floating, // ...and this page is in a window of its own
    info: () => JSON.stringify({ version: 1, screen: true, pc: true }),
    frame: (since) => screen.frame(since),
    hasShare: () => screen.sharing,
    // Nothing to draw pen marks on, and settings are on this page.
    clearMarks() {},
    settingsClosed() {},
    setCapture(on) {
      screen.active = on;
      if (!on || screen.sharing) return;
      // Browsers only let a page ask to share the screen from a click on that page. With the PC
      // page holding the share, sharing again happens there.
      if (host) send('screen-stopped');
      else screen.start().catch(() => send('screen-stopped'));
    },
    keepScreenOn(on) {
      if (!on && !host) screen.stop(); // the lesson ended: stop sharing
    },
    setMode: (mode, w, h) => host?.resize?.(mode, w, h),
    setFocusable() {},
    setDraggable() {},
    // In the small bar, a message shows for a moment over it.
    toast(text) {
      const box = document.getElementById('toasts');
      if (!box) return;
      const el = document.createElement('div');
      el.className = 'toast toast--info';
      el.setAttribute('role', 'status');
      el.textContent = text;
      box.append(el);
      setTimeout(() => el.remove(), 3500);
    },
    stop() {
      if (host?.close) return host.close();
      screen.stop();
      location.href = new URL('pc/', document.baseURI).href;
    },
  };
}
