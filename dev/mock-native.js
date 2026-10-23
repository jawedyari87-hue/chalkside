// Development only: a stand-in for the Android app's bridge (window.ChalksideAndroid),
// loaded with ?overlay&mock. It hands out pictures of a pretend screen and records what
// the page asked the app to do. window.__native exposes that record and a few levers.

export function installMockNative() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 640;
  const g = canvas.getContext('2d');
  const scenes = [
    ['Lecture 7: Eigenvalues', 'An eigenvector of A satisfies  A v = λ v', 'so  det(A − λI) = 0', 'Example:  A = [ 2  1 ; 1  2 ]'],
    ['Problem sheet 4, question 3', 'Find the eigenvalues and eigenvectors of', 'B = [ 4  1 ; 2  3 ]'],
  ];
  const state = { seq: 0, scene: 0, data: '', capture: false, mode: '', size: null, focusable: false, screenOn: false, calls: [] };

  function draw() {
    const [title, ...lines] = scenes[state.scene % scenes.length];
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#1b2420';
    g.font = 'bold 42px sans-serif';
    g.fillText(title, 60, 100);
    g.font = '32px serif';
    lines.forEach((line, i) => g.fillText(line, 80, 200 + i * 80));
    state.data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    state.seq++;
  }
  draw();

  const log = (...call) => state.calls.push(call);
  const relay = typeof BroadcastChannel === 'function' ? new BroadcastChannel('chalkside-pclink-test') : null;
  if (relay) {
    relay.onmessage = (e) => {
      if (typeof e.data?.viewer === 'boolean') state.pcViewer = e.data.viewer;
      if (typeof e.data?.say === 'string') window.chalksideNative?.('say', e.data.say);
    };
  }
  window.ChalksideAndroid = {
    info: () => JSON.stringify({ version: 1, screen: true }),
    // The newest picture if it is newer than `since` (-1: the newest, whatever it is).
    frame(since) {
      if (!state.capture) return '';
      if (since !== -1 && since >= state.seq) return '';
      return JSON.stringify({ seq: state.seq, w: canvas.width, h: canvas.height, data: state.data });
    },
    setMode(mode, w, h) {
      log('setMode', mode, w, h);
      state.mode = mode;
      state.size = mode === 'bubble' ? [w, h] : null;
    },
    setFocusable(on) {
      log('setFocusable', on);
      state.focusable = on;
    },
    setCapture(on) {
      log('setCapture', on);
      state.capture = on;
    },
    keepScreenOn(on) {
      log('keepScreenOn', on);
      state.screenOn = on;
    },
    toast: (text) => log('toast', text),
    showMarks(json) {
      log('showMarks', JSON.parse(json));
      state.marks = JSON.parse(json);
    },
    clearMarks() {
      log('clearMarks');
      state.marks = [];
    },
    showVolume: () => log('showVolume'),
    volumeInfo: () => JSON.stringify({ level: state.volume ?? 5, min: 1, max: 15 }),
    setVolume(level) {
      log('setVolume', level);
      state.volume = level;
    },
    setDraggable: (on) => log('setDraggable', on),
    // A linked PC: window.__native.pcPicture() gives it a new picture.
    pcFrame(since) {
      if (!state.pc || (since !== -1 && since >= state.pc.seq)) return '';
      return JSON.stringify(state.pc);
    },
    pcLinked: () => !!state.pc,
    // The board for the PC link page. A PC is "looking" while state.pcViewer is true. What the
    // page hands over is kept, and goes out on a BroadcastChannel, so a test page on this origin
    // can serve it to the PC link page, and pass back what's typed there (__native.say).
    pcBoard(json) {
      state.pcBoard = json;
      relay?.postMessage({ board: json });
    },
    pcLive(json) {
      state.pcLive = json;
      relay?.postMessage({ live: json });
    },
    pcBoardShown: () => !!state.pcViewer,
    openSettings: () => log('openSettings'),
    settingsClosed: (hasKey) => log('settingsClosed', hasKey),
    stop: () => log('stop'),
  };
  window.__native = {
    state,
    // Show the next pretend screen, as if the student had switched app or scrolled.
    nextScreen() {
      state.scene++;
      draw();
    },
    // A message from the app: 'stop', 'blur', 'screen-stopped', 'screen-started', 'marks-cleared' or 'settings'.
    send: (type) => window.chalksideNative?.(type),
    // Something typed or tapped on the PC link page, as the app passes it on.
    say: (json) => window.chalksideNative?.('say', json),
    // A new picture of the linked PC's screen.
    pcPicture() {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 640, 400);
      g.fillStyle = '#213a33';
      g.fillRect(0, 0, 640, 28);
      g.fillStyle = '#000000';
      g.font = '28px sans-serif';
      g.fillText(`Slide ${(state.pc?.seq || 0) + 1}: Eigenvalues`, 40, 120);
      state.pc = { seq: (state.pc?.seq || 0) + 1, w: 640, h: 400, data: c.toDataURL('image/jpeg', 0.8).split(',')[1] };
    },
  };
  console.info('[mock] Fake Android bridge installed');
}
