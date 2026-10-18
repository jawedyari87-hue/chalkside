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
    // A message from the app: 'stop', 'back', 'screen-stopped' or 'settings'.
    send: (type) => window.chalksideNative?.(type),
  };
  console.info('[mock] Fake Android bridge installed');
}
