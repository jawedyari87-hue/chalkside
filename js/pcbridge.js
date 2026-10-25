// Chalkside on a computer (?overlay&pc): the "app" side of the floating tutor, which the Android
// app provides on a tablet as window.ChalksideAndroid. Screen pictures come from the Chalkside PC
// page (pc/), which shares a screen or window (and maybe a second one) and holds the window this
// page runs in. Opened on its own, the page shares the screen itself when a lesson starts.
//
// A second screen takes the place of the tablet app's linked PC (pcFrame, pcLinked), so the two
// take turns in the same way.

import { PcScreen } from './pccapture.js';

// The Chalkside PC page around this one, if any: { screen, screen2, close(), resize(mode, w, h) }.
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
  const screen2 = host?.screen2 || null;
  const send = (type) => window.chalksideNative?.(type);
  // One share stopping or starting only matters when the other isn't going.
  const onEnded = () => !screen2?.sharing && send('screen-stopped');
  const onStarted = () => send('screen-started');
  const onEnded2 = () => !screen.sharing && send('screen-stopped');
  const onStarted2 = () => !screen.sharing && send('screen-started');
  screen.addEventListener('ended', onEnded);
  screen.addEventListener('started', onStarted);
  screen2?.addEventListener('ended', onEnded2);
  screen2?.addEventListener('started', onStarted2);
  window.addEventListener('pagehide', () => {
    screen.removeEventListener('ended', onEnded);
    screen.removeEventListener('started', onStarted);
    screen2?.removeEventListener('ended', onEnded2);
    screen2?.removeEventListener('started', onStarted2);
    if (!host) screen.stop();
  });

  return {
    hosted: !!host, // the Chalkside PC page holds the share
    floating: !!host?.floating, // ...and this page is in a window of its own
    onTop: host?.kind === 'top', // ...one that stays on top, which can't go full screen
    info: () => JSON.stringify({ version: 1, screen: true, pc: true }),
    frame: (since) => screen.frame(since),
    pcFrame: (since) => screen2?.frame(since) || '',
    pcLinked: () => !!screen2?.sharing,
    hasShare: () => screen.sharing || !!screen2?.sharing,
    screens: () => (screen.sharing ? 1 : 0) + (screen2?.sharing ? 1 : 0),
    // Nothing to draw pen marks on, and settings are on this page.
    clearMarks() {},
    settingsClosed() {},
    setCapture(on) {
      screen.active = on;
      if (screen2) screen2.active = on;
      if (!on || screen.sharing || screen2?.sharing) return;
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
