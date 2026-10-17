// Chalkside: a voice maths tutor (Gemini Live) that watches your handwriting
// and writes the maths on a chalkboard beside your page.

import { $, $$, clamp, debounce, sleep, uid, prefs, bytesToBase64, base64ToBytes, fmtClock, fmtDate, toast, imageToDataUrl, escapeHtml } from './util.js';
import { InkPage, PEN_COLOURS, HL_COLOURS, SWATCH } from './ink.js';
import { Board } from './board.js';
import { AudioEngine } from './audio.js';
import { LiveSession } from './live.js';
import { MODELS, VOICES, modelProfile, buildSystemPrompt, buildTools, ASKS } from './prompt.js';
import { lessons } from './store.js';
import { openPdf, renderPdfPage, showThumbnails } from './pdfimport.js';
import { renderInline } from './math.js';

const MOCK = new URLSearchParams(location.search).has('mock');
if (MOCK) {
  try {
    const mock = await import('../dev/mock-live.js');
    mock.installMock();
  } catch {
    console.warn('[chalkside] ?mock needs the dev folder, which is not deployed here.');
  }
}

// ---- settings --------------------------------------------------------------------

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.8-live',
  customModel: '',
  thinkingLevel: 'LOW',
  voice: 'Kore',
  help: 'balanced',
  about: '',
  thinkTime: true,
  noisy: false,
  autoSend: true,
  watch: true,
  layout: 'board-left',
  grid: 'squares',
  finger: 'auto',
  theme: 'system',
  boardScale: 1,
  split: 0.45,
  splitV: 0.42,
};
const settings = { ...DEFAULTS, ...prefs.get('settings', {}) };
const saveSettings = () => prefs.set('settings', settings);

// ---- elements --------------------------------------------------------------------

const app = $('#app');
const workspace = $('#workspace');
const divider = $('#divider');
const sessionEl = $('#session');
const startBtn = $('#startBtn');
const liveCtl = $('#liveCtl');
const micBtn = $('#micBtn');
const statusText = $('#statusText');
const statusMeta = $('#statusMeta');
const skipBtn = $('#skipBtn');
const endBtn = $('#endBtn');
const watchBtn = $('#watchBtn');
const lessonTitleEl = $('#lessonTitle');
const capYou = $('#capYou');
const capTutor = $('#capTutor');
const seenTag = $('#seenTag');
const swatches = $('#swatches');
const sizes = $('#sizes');
const undoBtn = $('#undoBtn');
const redoBtn = $('#redoBtn');
const boardEl = $('#board');

const page = new InkPage($('#pageSurface'));
const board = new Board({
  scroll: $('#boardScroll'),
  board: boardEl,
  pill: $('#newPill'),
  pageLabel: $('#pageLabel'),
  pageTitle: $('#boardPageTitle'),
  prev: $('#prevPage'),
  next: $('#nextPage'),
});
const audio = new AudioEngine();

// ---- theme and layout --------------------------------------------------------------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => (settings.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme);

function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  page.setTheme(effectiveTheme());
  $('meta[name="theme-color"]').content = effectiveTheme() === 'dark' ? '#111614' : '#e7ebe6';
  renderSwatches();
}
darkQuery.addEventListener('change', applyTheme);

function applyLayout() {
  app.dataset.layout = settings.layout;
  app.style.setProperty('--split', `${(settings.split * 100).toFixed(1)}%`);
  app.style.setProperty('--split-v', `${(settings.splitV * 100).toFixed(1)}%`);
  boardEl.style.setProperty('--board-scale', String(settings.boardScale));
}

const portrait = () => matchMedia('(orientation: portrait), (max-width: 720px)').matches;

divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try {
    divider.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  const r = workspace.getBoundingClientRect();
  const vertical = portrait();
  const move = (ev) => {
    if (vertical) settings.splitV = clamp((ev.clientY - r.top) / r.height, 0.2, 0.75);
    else {
      let f = (ev.clientX - r.left) / r.width;
      if (settings.layout === 'board-right') f = 1 - f;
      settings.split = clamp(f, 0.25, 0.7);
    }
    applyLayout();
  };
  const up = () => {
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
    saveSettings();
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
});
divider.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -0.03, ArrowRight: 0.03, ArrowUp: -0.03, ArrowDown: 0.03 }[e.key];
  if (!step) return;
  e.preventDefault();
  if (portrait()) settings.splitV = clamp(settings.splitV + step, 0.2, 0.75);
  else settings.split = clamp(settings.split + (settings.layout === 'board-right' ? -step : step), 0.25, 0.7);
  applyLayout();
  saveSettings();
});

// ---- page toolbar ------------------------------------------------------------------

const COLOUR_NAMES = { ink: 'Black', blue: 'Blue', red: 'Red', green: 'Green', hlYellow: 'Yellow', hlGreen: 'Green', hlPink: 'Pink' };

function renderSwatches() {
  const isHl = page.tool === 'hl';
  const names = isHl ? HL_COLOURS : PEN_COLOURS;
  const current = isHl ? page.hlColour : page.penColour;
  swatches.hidden = page.tool === 'eraser' || page.tool === 'move';
  swatches.replaceChildren(
    ...names.map((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.setProperty('--sw', SWATCH(n, effectiveTheme()).replace(/,\s*[\d.]+\)$/, ', 1)'));
      b.setAttribute('aria-pressed', String(n === current));
      b.setAttribute('aria-label', `${COLOUR_NAMES[n]} ${isHl ? 'highlighter' : 'ink'}`);
      b.addEventListener('click', () => {
        if (isHl) page.setHlColour(n);
        else page.setPenColour(n);
        renderSwatches();
      });
      return b;
    }),
  );
}

function renderSizes() {
  sizes.hidden = page.tool === 'eraser' || page.tool === 'move';
  $$('.size', sizes).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === page.sizeIdx)));
}

function updateToolbar() {
  $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === page.tool)));
  renderSwatches();
  renderSizes();
  undoBtn.disabled = !page.canUndo();
  redoBtn.disabled = !page.canRedo();
}

$$('[data-tool]').forEach((b) => b.addEventListener('click', () => page.setTool(b.dataset.tool)));
$$('.size', sizes).forEach((b) =>
  b.addEventListener('click', () => {
    page.setSize(Number(b.dataset.size));
    renderSizes();
  }),
);
undoBtn.addEventListener('click', () => page.undo());
redoBtn.addEventListener('click', () => page.redo());
page.addEventListener('tool', updateToolbar);
page.addEventListener('history', updateToolbar);

$('#clearMarksBtn').addEventListener('click', () => page.clearMarks());
page.addEventListener('marks', () => {
  $('#clearMarksBtn').disabled = page.marks.length === 0;
  saveSoon();
});

const clearConfirm = $('#clearConfirm');
$('#clearPageBtn').addEventListener('click', () => {
  if (!page.items.length) return;
  clearConfirm.hidden = false;
});
$('#clearNo').addEventListener('click', () => (clearConfirm.hidden = true));
$('#clearYes').addEventListener('click', () => {
  clearConfirm.hidden = true;
  page.clearPage();
  toast('Page cleared.', { actionLabel: 'Undo', onAction: () => page.undo(), ms: 6000 });
});

// Images and PDFs

async function addImageFile(file) {
  try {
    const img = await imageToDataUrl(file, 2000, 0.88);
    page.addImage(img);
    toast('Added to your page. Drag it to move it, or drag the corner to resize. Pick the pen to write.', { ms: 5000 });
  } catch (err) {
    toast(err.message || 'That image could not be added.', { kind: 'error' });
  }
}

const imageInput = $('#imageInput');
$('#addImageBtn').addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  const f = imageInput.files?.[0];
  imageInput.value = '';
  if (f) addImageFile(f);
});

document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith('image/'));
  if (f) {
    e.preventDefault();
    addImageFile(f);
  }
});

const pdfInput = $('#pdfInput');
const pdfDlg = $('#pdfDlg');
const pdfGrid = $('#pdfGrid');
const pdfAdd = $('#pdfAdd');
$('#addPdfBtn').addEventListener('click', () => pdfInput.click());
pdfInput.addEventListener('change', async () => {
  const f = pdfInput.files?.[0];
  pdfInput.value = '';
  if (!f) return;
  $('#pdfTitle').textContent = f.name.replace(/\.pdf$/i, '');
  pdfGrid.innerHTML = '<p class="help">Opening the PDF…</p>';
  pdfAdd.disabled = true;
  pdfAdd.textContent = 'Add pages';
  pdfDlg.showModal();
  let pdf;
  try {
    pdf = await openPdf(f);
  } catch (err) {
    pdfGrid.innerHTML = `<p class="help">${escapeHtml(err.message || 'That PDF could not be opened.')}</p>`;
    return;
  }
  const selected = showThumbnails(pdf, pdfGrid, (n) => {
    pdfAdd.disabled = n === 0;
    pdfAdd.textContent = n > 1 ? `Add ${n} pages` : 'Add page';
  });
  pdfAdd.onclick = async () => {
    const pages = selected();
    pdfAdd.disabled = true;
    pdfAdd.textContent = 'Adding…';
    try {
      for (const n of pages) {
        const c = await renderPdfPage(pdf, n, 1600);
        page.addImage({ src: c.toDataURL('image/jpeg', 0.86), width: c.width, height: c.height });
      }
      toast(pages.length > 1 ? `Added ${pages.length} pages.` : 'Page added.', { ms: 3000 });
    } catch (err) {
      toast(err.message || 'That page could not be added.', { kind: 'error' });
    }
    pdfDlg.close();
    pdf.destroy?.();
  };
});

// ---- board controls ----------------------------------------------------------------

$('#textSmaller').addEventListener('click', () => setBoardScale(settings.boardScale - 0.1));
$('#textBigger').addEventListener('click', () => setBoardScale(settings.boardScale + 0.1));
function setBoardScale(v) {
  settings.boardScale = Math.round(clamp(v, 0.8, 1.7) * 10) / 10;
  applyLayout();
  saveSettings();
}
$('#newBoardPage').addEventListener('click', () => board.newPage(''));
$('#printBtn').addEventListener('click', printLesson);
board.addEventListener('change', () => {
  autoTitle();
  saveSoon();
});

// ---- lessons -------------------------------------------------------------------------

let lesson = null;
let transcript = [];
let saveWarned = false;

function welcomeBoard() {
  const blocks = [
    {
      kind: 'note',
      content: "This is the tutor's board. When you talk, the tutor explains out loud and writes the maths here, one step at a time.",
    },
    {
      kind: 'example',
      title: 'What it looks like',
      content: 'Differentiate $y = x^2 \\sin x$ using the product rule:\n$$\\frac{d}{dx}(uv) = u\\frac{dv}{dx} + v\\frac{du}{dx}$$',
    },
    { kind: 'step', content: '$u = x^2$ and $v = \\sin x$, so $\\dfrac{du}{dx} = 2x$ and $\\dfrac{dv}{dx} = \\cos x$' },
    { kind: 'answer', content: '$$\\frac{dy}{dx} = x^2\\cos x + 2x\\sin x$$' },
    { kind: 'your_turn', content: 'Try $y = x^3 e^{x}$ on your page, then tap **Check my work**.' },
  ];
  if (!settings.apiKey) {
    blocks.push({
      kind: 'note',
      title: 'Getting started',
      content:
        '1. Get a free Gemini API key at **aistudio.google.com/apikey**\n2. Open **Settings** (top right) and paste it in\n3. Tap **Start tutor** and say hello',
    });
  }
  return {
    pages: [{ id: 1, title: 'Welcome to Chalkside', sample: true, blocks: blocks.map((b, i) => ({ id: i + 1, title: '', ...b, t: Date.now() })) }],
    nextId: blocks.length + 1,
    nextPageId: 2,
  };
}

function renderLessonTitle() {
  lessonTitleEl.textContent = lesson?.title || 'Untitled lesson';
  document.title = lesson && lesson.title !== 'Untitled lesson' ? `${lesson.title} · Chalkside` : 'Chalkside';
}

function autoTitle() {
  if (!lesson || lesson.titleSet) return;
  const t = board.firstTitle();
  if (t && t !== lesson.title) {
    lesson.title = t.replace(/\$/g, '').slice(0, 60);
    renderLessonTitle();
  }
}

function loadLesson(L) {
  lesson = { id: L.id, title: L.title || 'Untitled lesson', created: L.created || Date.now(), updated: L.updated || Date.now(), titleSet: !!L.titleSet };
  page.load(L.page);
  board.load(L.board);
  transcript = Array.isArray(L.transcript) ? L.transcript : [];
  renderLessonTitle();
  renderTranscript();
  prefs.set('currentLesson', lesson.id);
}

function startFreshLesson({ welcome = false } = {}) {
  lesson = { id: uid(), title: 'Untitled lesson', created: Date.now(), updated: Date.now(), titleSet: false };
  page.load(null);
  board.load(welcome ? welcomeBoard() : null);
  transcript = [];
  renderLessonTitle();
  renderTranscript();
  prefs.set('currentLesson', lesson.id);
}

function lessonIsEmpty() {
  return page.items.length === 0 && board.isEmpty() && transcript.length === 0;
}

function previewText() {
  const last = board.allBlocks().filter((b) => b.kind !== 'graph').at(-1);
  return last ? String(last.content).replace(/\s+/g, ' ').slice(0, 120) : '';
}

function snapshotLesson() {
  return {
    ...lesson,
    updated: Date.now(),
    page: page.serialize(),
    board: board.serialize(),
    transcript: transcript.slice(-500),
    preview: previewText(),
  };
}

async function saveNow() {
  if (!lesson) return;
  if (lessonIsEmpty()) return;
  lesson.updated = Date.now();
  try {
    await lessons.put(snapshotLesson());
  } catch {
    if (!saveWarned) {
      saveWarned = true;
      toast("This browser won't let Chalkside save lessons, so this one only lasts until you close the app.", { kind: 'error', ms: 9000 });
    }
  }
}
const saveSoon = debounce(() => saveNow(), 1500, 8000);

const lessonsDlg = $('#lessonsDlg');
const lessonList = $('#lessonList');
const lessonName = $('#lessonName');

$('#lessonsBtn').addEventListener('click', openLessons);

async function openLessons() {
  lessonName.value = lesson.title === 'Untitled lesson' ? '' : lesson.title;
  lessonsDlg.showModal();
  await saveNow();
  await renderLessonList();
}

async function renderLessonList() {
  let list;
  try {
    list = await lessons.list();
  } catch {
    lessonList.innerHTML = '<li class="help">This browser is not letting Chalkside save lessons.</li>';
    return;
  }
  // Tidy away lessons that never got any content.
  const hasContent = (m) => m.blocks || m.strokes || m.pictures;
  for (const m of list) if (m.id !== lesson.id && !hasContent(m)) lessons.remove(m.id).catch(() => {});
  list = list.filter((m) => m.id === lesson.id || hasContent(m));
  if (!list.length) {
    lessonList.innerHTML = '<li class="help">Nothing saved yet. Lessons save themselves as you work.</li>';
    return;
  }
  lessonList.replaceChildren(
    ...list.map((m) => {
      const li = document.createElement('li');
      li.className = 'lesson-item' + (m.id === lesson.id ? ' is-current' : '');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'lesson-open';
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const counts = [
        m.blocks ? `${plural(m.blocks, 'block')} on the board` : '',
        m.strokes ? plural(m.strokes, 'pen stroke') : '',
        m.pictures ? plural(m.pictures, 'picture') : '',
      ]
        .filter(Boolean)
        .join(' · ');
      open.innerHTML = `<strong>${escapeHtml(m.title || 'Untitled lesson')}</strong><span>${escapeHtml(fmtDate(m.updated))}${counts ? ' · ' + counts : ''}${m.id === lesson.id ? ' · open now' : ''}</span>`;
      open.addEventListener('click', () => switchLesson(m.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lesson-del';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete ${m.title || 'lesson'}`);
      let armed = 0;
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = setTimeout(() => {
            armed = 0;
            del.textContent = 'Delete';
            del.classList.remove('is-armed');
          }, 4000);
          del.textContent = 'Tap again to delete';
          del.classList.add('is-armed');
          return;
        }
        clearTimeout(armed);
        await lessons.remove(m.id).catch(() => {});
        if (m.id === lesson.id) {
          if (sessionActive()) endSession({ quiet: true });
          startFreshLesson();
        }
        renderLessonList();
      });
      li.append(open, del);
      return li;
    }),
  );
}

async function switchLesson(id) {
  if (id === lesson.id) {
    lessonsDlg.close();
    return;
  }
  if (sessionActive()) endSession({ quiet: true });
  await saveNow();
  try {
    const L = await lessons.get(id);
    if (L) loadLesson(L);
  } catch {
    toast("That lesson couldn't be opened.", { kind: 'error' });
  }
  lessonsDlg.close();
}

lessonName.addEventListener('input', () => {
  const v = lessonName.value.trim();
  lesson.title = v || 'Untitled lesson';
  lesson.titleSet = !!v;
  renderLessonTitle();
  saveSoon();
});

$('#newLessonBtn').addEventListener('click', async () => {
  if (sessionActive()) endSession({ quiet: true });
  await saveNow();
  startFreshLesson();
  lessonsDlg.close();
  toast('New lesson. Your last one is saved under Lessons.', { ms: 3500 });
});

// ---- transcript -------------------------------------------------------------------------

const transcriptDlg = $('#transcriptDlg');
const transcriptList = $('#transcriptList');
$('#captions').addEventListener('click', () => {
  renderTranscript();
  transcriptDlg.showModal();
  transcriptList.lastElementChild?.scrollIntoView({ block: 'end' });
});

function renderTranscript() {
  if (!transcript.length) {
    transcriptList.innerHTML = '<li class="help">Nothing said yet.</li>';
    return;
  }
  transcriptList.replaceChildren(
    ...transcript.slice(-300).map((t) => {
      const li = document.createElement('li');
      li.className = t.who === 'tutor' ? 'tutor' : 'you';
      li.innerHTML = `<span class="who">${t.who === 'tutor' ? 'Tutor' : 'You'}</span><span class="said"></span>`;
      li.lastElementChild.textContent = t.text.trim();
      return li;
    }),
  );
}

// ---- dialogs: shared close buttons ---------------------------------------------------------

$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog')?.close()));
$$('dialog').forEach((d) =>
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  }),
);

// ---- settings ------------------------------------------------------------------------------

const settingsDlg = $('#settingsDlg');
const settingsForm = $('#settingsForm');
const f = {
  key: $('#sKey'),
  model: $('#sModel'),
  custom: $('#sCustom'),
  think: $('#sThink'),
  voice: $('#sVoice'),
  about: $('#sAbout'),
  thinkTime: $('#sThinkTime'),
  noisy: $('#sNoisy'),
  autoSend: $('#sAutoSend'),
  layout: $('#sLayout'),
  grid: $('#sGrid'),
  finger: $('#sFinger'),
  theme: $('#sTheme'),
};
f.voice.replaceChildren(
  ...VOICES.map(([name, feel]) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = `${name} · ${feel}`;
    return o;
  }),
);

function syncModelRows() {
  const m = f.model.value;
  $('#sCustomRow').hidden = m !== 'custom';
  $('#sThinkRow').hidden = !(MODELS[m]?.thinking);
  $('#sModelBlurb').textContent = MODELS[m]?.blurb || 'Any Live API model ID your key can use.';
}
f.model.addEventListener('change', syncModelRows);

$('#sKeyShow').addEventListener('click', (e) => {
  const show = f.key.type === 'password';
  f.key.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
});

function openSettings(reason = '') {
  f.key.value = settings.apiKey;
  f.key.type = 'password';
  $('#sKeyShow').textContent = 'Show';
  f.model.value = settings.model;
  f.custom.value = settings.customModel;
  f.think.value = settings.thinkingLevel;
  f.voice.value = settings.voice;
  f.about.value = settings.about;
  f.thinkTime.checked = settings.thinkTime;
  f.noisy.checked = settings.noisy;
  f.autoSend.checked = settings.autoSend;
  f.layout.value = settings.layout;
  f.grid.value = settings.grid;
  f.finger.value = settings.finger;
  f.theme.value = settings.theme;
  const help = settingsForm.querySelector(`input[name="sHelp"][value="${settings.help}"]`);
  if (help) help.checked = true;
  syncModelRows();
  const note = connectionNote();
  $('#sConnInfo').textContent = note;
  $('#sConnInfo').hidden = !note;
  const reasonEl = $('#settingsReason');
  reasonEl.textContent = reason;
  reasonEl.hidden = !reason;
  settingsDlg.showModal();
  if (reason || !settings.apiKey) f.key.focus();
}

$('#settingsBtn').addEventListener('click', () => openSettings());
$('#settingsCancel').addEventListener('click', () => settingsDlg.close());
$('#settingsX').addEventListener('click', () => settingsDlg.close());

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const before = JSON.stringify(setupRelevant());
  settings.apiKey = f.key.value.trim();
  settings.model = f.model.value;
  settings.customModel = f.custom.value.trim();
  settings.thinkingLevel = f.think.value;
  settings.voice = f.voice.value;
  settings.about = f.about.value.trim().slice(0, 1500);
  settings.thinkTime = f.thinkTime.checked;
  settings.noisy = f.noisy.checked;
  settings.autoSend = f.autoSend.checked;
  settings.layout = f.layout.value;
  settings.grid = f.grid.value;
  settings.finger = f.finger.value;
  settings.theme = f.theme.value;
  settings.help = settingsForm.querySelector('input[name="sHelp"]:checked')?.value || 'balanced';
  saveSettings();
  settingsDlg.close();
  applyTheme();
  applyLayout();
  page.setGrid(settings.grid);
  page.setFingerMode(settings.finger);
  updateWatch();
  if (sessionActive() && JSON.stringify(setupRelevant()) !== before) {
    toast('Saved. The tutor picks up the new settings next time you start.', { actionLabel: 'Restart now', onAction: restartSession, ms: 9000 });
  } else {
    toast('Settings saved.', { ms: 2000 });
  }
});

function setupRelevant() {
  const { apiKey, model, customModel, thinkingLevel, voice, help, about, thinkTime, noisy } = settings;
  return { apiKey, model, customModel, thinkingLevel, voice, help, about, thinkTime, noisy };
}

// ---- watch my working ------------------------------------------------------------------------

function updateWatch() {
  const on = settings.watch && settings.autoSend;
  watchBtn.setAttribute('aria-pressed', String(on));
  watchBtn.disabled = !settings.autoSend;
  watchBtn.title = settings.autoSend
    ? 'When this is on, the tutor speaks up if it spots a mistake while you write.'
    : 'Turn on "Let the tutor see my page as I write" in Settings first.';
  seenTag.hidden = !(S.phase === 'live' && settings.autoSend);
}
watchBtn.addEventListener('click', () => {
  settings.watch = !settings.watch;
  saveSettings();
  updateWatch();
  toast(settings.watch ? 'The tutor will speak up if it spots a mistake.' : 'The tutor will wait until you ask.', { ms: 2500 });
});

// ---- the live session -------------------------------------------------------------------------

const S = {
  live: null,
  profile: null,
  phase: 'idle',
  muted: false,
  hearing: false,
  tutorTalking: false,
  awaiting: false,
  dropAudio: false,
  pendingAsk: null,
  lastFrameKey: '',
  lastFrameAt: -1e9,
  lastFrameRect: null,
  lastNudgeAt: -1e9,
  inkSinceNudge: 0,
  lastInkAt: 0,
  lastUserSpeechAt: -1e9,
  startedAt: 0,
  timer: 0,
  wake: null,
  tutorLine: null,
  youLine: null,
  vadAbove: 0,
  vadBelow: 0,
  micLevel: 0,
  awaitTimer: 0,
};

const sessionActive = () => S.phase !== 'idle';

audio.addEventListener('speaking', () => {
  S.tutorTalking = true;
  updateStatus();
});
audio.addEventListener('idle', () => {
  S.tutorTalking = false;
  updateStatus();
  nudgeSoon();
});
audio.addEventListener('mic-ended', () => {
  if (sessionActive()) {
    toast('The microphone stopped. Start the tutor again to carry on.', { kind: 'error' });
    endSession({ quiet: true });
  }
});

function buildSetup() {
  const profile = S.profile || modelProfile(settings);
  const generationConfig = {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
    mediaResolution: 'MEDIA_RESOLUTION_HIGH',
  };
  if (profile.thinking) generationConfig.thinkingConfig = { thinkingLevel: settings.thinkingLevel };
  const vad = {};
  if (settings.noisy) vad.startOfSpeechSensitivity = 'START_SENSITIVITY_LOW';
  if (settings.thinkTime) {
    vad.endOfSpeechSensitivity = 'END_SENSITIVITY_LOW';
    vad.silenceDurationMs = 1500;
  }
  const setup = {
    model: `models/${profile.id}`,
    generationConfig,
    systemInstruction: { parts: [{ text: buildSystemPrompt(settings) }] },
    tools: buildTools(profile),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
  };
  if (Object.keys(vad).length) setup.realtimeInputConfig = { automaticActivityDetection: vad };
  return setup;
}

// Identifies which key a remembered sign-in method belongs to, without storing the key twice.
function keyFingerprint(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function connectionNote() {
  const a = prefs.get('auth', null);
  if (!a || !settings.apiKey || a.fp !== keyFingerprint(settings.apiKey)) return '';
  const how = a.mode === 'token' ? 'a short-lived sign-in token made from your key' : 'your key directly';
  return `Last connected using ${how}.`;
}

function micError(err) {
  if (!window.isSecureContext) return 'The microphone only works when Chalkside is opened from an https:// address, such as GitHub Pages.';
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')
    return 'Chalkside needs the microphone. Allow it for this site in the browser settings, then tap Start tutor again.';
  if (err?.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (err?.name === 'NotReadableError') return 'Another app is using the microphone. Close it and try again.';
  return err?.message || 'The microphone could not be started.';
}

async function startSession(thenAsk = null) {
  if (sessionActive()) return;
  if (!settings.apiKey && !MOCK) {
    openSettings('Paste your Gemini API key to start the tutor.');
    return;
  }
  if (!navigator.onLine) {
    toast("You're offline. The tutor needs the internet.", { kind: 'error' });
    return;
  }
  S.pendingAsk = thenAsk;
  S.profile = modelProfile(settings);
  setPhase('connecting');
  try {
    await audio.init();
    await audio.startMic(onMicChunk);
  } catch (err) {
    setPhase('idle');
    toast(micError(err), { kind: 'error', ms: 10000 });
    return;
  }
  const apiKey = settings.apiKey || 'mock';
  const remembered = prefs.get('auth', null);
  const authMode = remembered?.fp === keyFingerprint(apiKey) ? remembered.mode : null;
  const live = new LiveSession({ apiKey, buildSetup, authMode });
  live.addEventListener('auth', (ev) => prefs.set('auth', { fp: keyFingerprint(apiKey), mode: ev.detail.mode, at: Date.now() }));
  S.live = live;
  live.addEventListener('message', (ev) => {
    if (S.live === live) onServer(ev.detail.msg, ev.detail.conn);
  });
  live.addEventListener('state', (ev) => {
    if (S.live !== live) return;
    if (ev.detail.state === 'reconnecting') setPhase('reconnecting');
    if (ev.detail.state === 'live') setPhase('live');
  });
  live.addEventListener('open', (ev) => {
    if (S.live === live) onOpen(ev.detail.resumed);
  });
  live.addEventListener('fail', (ev) => {
    if (S.live !== live) return;
    endSession({ quiet: true });
    toast(ev.detail.message, { kind: 'error', ms: 12000 });
  });
  live.addEventListener('warn', (ev) => console.warn('[chalkside]', ev.detail.message));
  try {
    await live.start();
  } catch (err) {
    if (S.live !== live) return;
    endSession({ quiet: true });
    const fixable = /key|model|Settings/i.test(err.message);
    toast(err.message, { kind: 'error', ms: 14000, actionLabel: fixable ? 'Settings' : undefined, onAction: () => openSettings() });
  }
}

function onOpen(resumed) {
  setPhase('live');
  if (resumed) {
    // Anything written while reconnecting goes over now.
    frameSoon();
    return;
  }
  prefs.set('welcomed', true);
  S.startedAt = Date.now();
  startTimer();
  requestWake();
  S.lastFrameKey = '';
  const ask = S.pendingAsk;
  S.pendingAsk = null;
  // With "see my page" off, the page only goes over with an explicit ask.
  const showPage = settings.autoSend || !!ask;
  if (showPage) sendFrame({ force: true });
  const earlier = board.isEmpty() ? '' : ` Earlier in this lesson you wrote these blocks on the board (newest last):\n${board.summary().join('\n')}\n`;
  const pageNote = showPage
    ? " The newest image shows the student's page."
    : " The student has chosen to share their page only when they ask you to check it, so you can't see it yet.";
  setTimeout(() => {
    if (!S.live) return;
    if (ask) {
      const said = ASKS[ask] || ask;
      sendRaw(`[The lesson has started.${earlier}${pageNote}] ${said}`);
      logYou(said);
    } else {
      sendRaw(
        `[The lesson has started.${earlier}${pageNote} Greet the student in one short sentence and ask what they would like to work on${earlier ? ', or whether to carry on from where you left off' : ''}.]`,
      );
    }
    setAwaiting();
  }, 450);
}

function restartSession() {
  endSession({ quiet: true });
  startSession();
}

function endSession({ quiet = false } = {}) {
  const live = S.live;
  S.live = null;
  live?.close();
  audio.stopMic();
  audio.flush();
  stopTimer();
  releaseWake();
  clearTimeout(S.awaitTimer);
  Object.assign(S, { tutorTalking: false, awaiting: false, hearing: false, dropAudio: false, pendingAsk: null, muted: false });
  finishTutorLine();
  S.youLine = null;
  setPhase('idle');
  saveNow();
  if (!quiet) toast('Lesson paused. Your page and board are saved.', { ms: 3000 });
}

function setPhase(p) {
  S.phase = p;
  sessionEl.dataset.phase = p;
  startBtn.hidden = p !== 'idle';
  liveCtl.hidden = p === 'idle';
  seenTag.hidden = !(p === 'live' && settings.autoSend);
  if (p === 'idle') {
    statusMeta.textContent = '';
    levelLoopStop();
  } else levelLoopStart();
  updateStatus();
}

function updateStatus() {
  let text = '';
  if (S.phase === 'connecting') text = 'Connecting…';
  else if (S.phase === 'reconnecting') text = 'Reconnecting…';
  else if (S.phase === 'live') {
    if (S.tutorTalking) text = 'Tutor is talking';
    else if (S.awaiting) text = 'Thinking…';
    else if (S.muted) text = 'Mic off';
    else if (S.hearing) text = 'Listening…';
    else text = 'Listening';
  }
  statusText.textContent = text;
  sessionEl.dataset.speaking = String(S.tutorTalking);
  sessionEl.dataset.hearing = String(S.hearing && !S.muted && S.phase === 'live');
  skipBtn.hidden = !(S.phase === 'live' && S.tutorTalking);
  micBtn.setAttribute('aria-pressed', String(S.muted));
  micBtn.setAttribute('aria-label', S.muted ? 'Turn the microphone back on' : 'Mute the microphone');
}

function startTimer() {
  stopTimer();
  const tick = () => {
    const label = S.profile ? S.profile.label : '';
    statusMeta.textContent = `${fmtClock((Date.now() - S.startedAt) / 1000)}${label ? ' · ' + label : ''}`;
  };
  tick();
  S.timer = setInterval(tick, 1000);
}
function stopTimer() {
  clearInterval(S.timer);
  S.timer = 0;
}

async function requestWake() {
  try {
    S.wake = await navigator.wakeLock?.request('screen');
    S.wake?.addEventListener('release', () => (S.wake = null));
  } catch {
    /* the screen may still sleep; not fatal */
  }
}
function releaseWake() {
  try {
    S.wake?.release();
  } catch {
    /* ignore */
  }
  S.wake = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSoon.flush();
  else {
    audio.ctx?.resume?.().catch(() => {});
    if (sessionActive() && !S.wake) requestWake();
  }
});
window.addEventListener('pagehide', () => saveSoon.flush());

// Controls

startBtn.addEventListener('click', () => startSession());
endBtn.addEventListener('click', () => endSession());
micBtn.addEventListener('click', () => {
  S.muted = !S.muted;
  if (S.muted) S.live?.send({ realtimeInput: { audioStreamEnd: true } });
  updateStatus();
});
skipBtn.addEventListener('click', () => {
  audio.flush();
  S.dropAudio = true;
  finishTutorLine();
  updateStatus();
});

// Microphone

function onMicChunk(int16, rms) {
  S.micLevel = S.micLevel * 0.6 + rms * 0.4;
  vadStep(rms);
  if (S.phase !== 'live' || S.muted || !S.live) return;
  S.live.send({ realtimeInput: { audio: { data: bytesToBase64(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } } });
}

// A rough local voice detector, only for the UI and for refreshing the page image.
function vadStep(rms) {
  if (rms > 0.02) {
    S.vadAbove++;
    S.vadBelow = 0;
  } else {
    S.vadBelow++;
    S.vadAbove = 0;
  }
  if (!S.hearing && S.vadAbove >= 3 && !S.muted) {
    S.hearing = true;
    S.lastUserSpeechAt = performance.now();
    if (S.phase === 'live' && performance.now() - S.lastFrameAt > 20000 && settings.autoSend) sendFrame({ force: true });
    updateStatus();
  } else if (S.hearing && S.vadBelow >= 10) {
    S.hearing = false;
    S.lastUserSpeechAt = performance.now();
    updateStatus();
  }
}

let levelRaf = 0;
function levelLoopStart() {
  if (levelRaf) return;
  const bars = $$('#voiceMeter i');
  const ring = $('#micRing');
  const loop = () => {
    levelRaf = requestAnimationFrame(loop);
    ring.style.setProperty('--lvl', Math.min(1, S.micLevel * 9).toFixed(3));
    const out = Math.min(1, audio.outputLevel() * 6);
    const t = performance.now() / 140;
    bars.forEach((b, i) => b.style.setProperty('--v', (out * (0.55 + 0.45 * Math.abs(Math.sin(t + i * 1.3)))).toFixed(3)));
  };
  levelRaf = requestAnimationFrame(loop);
}
function levelLoopStop() {
  cancelAnimationFrame(levelRaf);
  levelRaf = 0;
}

// Server messages

function onServer(msg, conn) {
  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) {
      audio.flush();
      S.dropAudio = false;
      finishTutorLine();
    }
    const parts = sc.modelTurn?.parts;
    if (parts) {
      for (const p of parts) {
        const d = p.inlineData;
        if (d?.data && (!d.mimeType || d.mimeType.startsWith('audio/'))) {
          clearAwaiting();
          if (!S.dropAudio) {
            const rate = Number(/rate=(\d+)/.exec(d.mimeType || '')?.[1]) || 24000;
            const bytes = base64ToBytes(d.data);
            audio.play(new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1), rate);
          }
        }
      }
    }
    if (sc.inputTranscription?.text) logYouSpeech(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) {
      clearAwaiting();
      if (!S.dropAudio) logTutor(sc.outputTranscription.text);
    }
    if (sc.turnComplete) {
      finishTutorLine();
      S.dropAudio = false;
      clearAwaiting();
    }
  }
  if (msg.toolCall?.functionCalls?.length) handleToolCalls(msg.toolCall.functionCalls, conn);
  updateStatus();
}

function setAwaiting() {
  S.awaiting = true;
  clearTimeout(S.awaitTimer);
  S.awaitTimer = setTimeout(() => {
    S.awaiting = false;
    updateStatus();
  }, 15000);
  updateStatus();
}
function clearAwaiting() {
  if (!S.awaiting) return;
  S.awaiting = false;
  clearTimeout(S.awaitTimer);
}

function sendRaw(text) {
  return S.live?.send({ realtimeInput: { text } });
}

function sendUserText(text) {
  if (!sendRaw(text)) return false;
  logYou(text);
  setAwaiting();
  return true;
}

// Captions and transcript

function logYou(text) {
  S.youLine = null;
  transcript.push({ who: 'you', text, t: Date.now() });
  capYou.textContent = `You: ${text}`;
  saveSoon();
}

function logYouSpeech(chunk) {
  if (!S.youLine) {
    S.youLine = { who: 'you', text: '', t: Date.now() };
    transcript.push(S.youLine);
  }
  S.youLine.text += chunk;
  capYou.textContent = `You: ${S.youLine.text.trim().slice(-160)}`;
}

function logTutor(chunk) {
  S.youLine = null;
  if (!S.tutorLine) {
    S.tutorLine = { who: 'tutor', text: '', t: Date.now() };
    transcript.push(S.tutorLine);
  }
  S.tutorLine.text += chunk;
  capTutor.textContent = S.tutorLine.text.trim().slice(-220);
}

function finishTutorLine() {
  if (S.tutorLine) saveSoon();
  S.tutorLine = null;
}

// Tools the tutor can call

const TOOLS = {
  write_on_board(a) {
    const r = board.write(a);
    const res = { ok: true, id: r.id };
    if (r.replaced) res.replaced = true;
    if (r.errors.length) res.latex_errors = r.errors.slice(0, 3);
    return res;
  },
  new_board_page(a) {
    board.newPage(a.title);
    return { ok: true };
  },
  plot_graph(a) {
    const r = board.plot(a);
    return r.errors.length ? { ok: true, id: r.id, errors: r.errors } : { ok: true, id: r.id };
  },
  mark_student_work(a) {
    const n = page.addMarks(a.marks, S.lastFrameRect);
    return { ok: true, marks_drawn: n };
  },
  clear_marks() {
    page.clearMarks();
    return { ok: true };
  },
};

function handleToolCalls(calls, conn) {
  const profile = S.profile || modelProfile(settings);
  const functionResponses = calls.map((fc) => {
    let response;
    let failed = false;
    try {
      const fn = TOOLS[fc.name];
      if (!fn) throw new Error(`there is no tool called ${fc.name}`);
      response = fn(fc.args || {});
      failed = response.ok === false || !!response.latex_errors || !!response.errors;
    } catch (err) {
      response = { ok: false, error: String(err?.message || err) };
      failed = true;
    }
    const r = { id: fc.id, name: fc.name, response };
    if (profile.scheduling && !S.live?.stripped.has('scheduling')) r.scheduling = failed ? 'WHEN_IDLE' : 'SILENT';
    return r;
  });
  const target = conn && !conn.closed ? conn : S.live;
  target?.send({ toolResponse: { functionResponses } });
}

// What the tutor sees of your page

function frameKey() {
  return `${page.version}|${Math.round(page.scrollY)}|${Math.round(page.viewH)}|${Math.round(page.cssW)}`;
}

function sendFrame({ force = false } = {}) {
  if (S.phase !== 'live' || !S.live) return false;
  if (!force && !settings.autoSend) return false;
  const key = frameKey();
  if (!force && key === S.lastFrameKey) return false;
  const now = performance.now();
  if (now - S.lastFrameAt < 1000) {
    frameRetry();
    return false;
  }
  const snap = page.snapshot({ maxSide: 1024 });
  const data = snap.canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  if (!S.live.send({ realtimeInput: { video: { data, mimeType: 'image/jpeg' } } })) return false;
  S.lastFrameKey = key;
  S.lastFrameAt = now;
  S.lastFrameRect = snap.rect;
  seenTag.classList.remove('is-pulse');
  void seenTag.offsetWidth;
  seenTag.classList.add('is-pulse');
  return true;
}
const frameRetry = debounce(() => sendFrame(), 1100);
const frameSoon = debounce(() => sendFrame(), 1000, 4000);

// Make sure the tutor has the current page before a question about it.
async function freshFrame() {
  const stale = frameKey() !== S.lastFrameKey || performance.now() - S.lastFrameAt > 20000;
  if (!stale) return;
  const wait = 1000 - (performance.now() - S.lastFrameAt);
  if (wait > 0) await sleep(wait);
  if (sendFrame({ force: true })) await sleep(350);
}

page.addEventListener('change', (e) => {
  saveSoon();
  if (e.detail?.kind !== 'image-loaded' && e.detail?.kind !== 'history') {
    S.inkSinceNudge++;
    S.lastInkAt = performance.now();
  }
  frameSoon();
  nudgeSoon();
});
page.addEventListener('viewport', () => frameSoon());

// "Watch my working": after a pause in writing, ask the tutor to look, and to
// stay quiet unless something is wrong.
const nudgeSoon = debounce(() => maybeNudge(), 5000);
function maybeNudge() {
  if (!settings.watch || !settings.autoSend || S.phase !== 'live') return;
  const now = performance.now();
  if (S.tutorTalking || S.awaiting || S.hearing) {
    nudgeSoon();
    return;
  }
  if (S.inkSinceNudge < 4) return;
  if (now - S.lastNudgeAt < 40000) return;
  if (now - S.lastUserSpeechAt < 6000 || now - S.lastInkAt < 4000) {
    nudgeSoon();
    return;
  }
  S.lastNudgeAt = now;
  S.inkSinceNudge = 0;
  freshFrame().then(() =>
    sendRaw(
      '[The student has written more and paused. Look at the newest image of their page. If there is a mistake in the new working, or they seem stuck, say so briefly and mark it. If everything is correct, stay completely silent and do not reply.]',
    ),
  );
}

// One-tap asks

async function ask(what) {
  if (S.phase === 'idle') {
    startSession(what);
    return;
  }
  if (S.phase !== 'live') {
    toast('One moment, the tutor is reconnecting.', { ms: 2500 });
    return;
  }
  await freshFrame();
  sendUserText(ASKS[what] || what);
}

$('#checkBtn').addEventListener('click', () => ask('check'));
$$('[data-ask]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.ask)));
$('#typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#typeInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.blur();
  ask(text);
});

// ---- printing ------------------------------------------------------------------------------

function printLesson() {
  const sheet = $('#printSheet');
  const parts = [`<h1>${escapeHtml(lesson.title)}</h1><p class="print-date">${escapeHtml(fmtDate(Date.now()))}</p>`];
  const pages = board.data.pages.filter((p) => !p.sample && p.blocks.length);
  for (const p of pages) {
    const blocks = p.blocks.map((b) => board.renderBlock(b, p, false).el.outerHTML).join('');
    parts.push(`<section class="print-page"><h2>${p.title ? renderInline(p.title) : 'Board'}</h2><div class="board">${blocks}</div></section>`);
  }
  if (page.items.length) {
    const snap = page.snapshotAll();
    parts.push(`<section class="print-page"><h2>Your page</h2><img class="print-ink" alt="Your handwritten page" src="${snap}"></section>`);
  }
  if (parts.length === 1) {
    toast('There is nothing on the board or your page to print yet.', { ms: 3000 });
    return;
  }
  sheet.innerHTML = parts.join('');
  setTimeout(() => window.print(), 50);
}

// ---- keyboard ----------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) page.redo();
    else page.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    page.redo();
  } else if (!mod && !e.altKey) {
    const tool = { p: 'pen', h: 'hl', e: 'eraser', m: 'move' }[e.key.toLowerCase()];
    if (tool) page.setTool(tool);
  }
});

// ---- start up ----------------------------------------------------------------------------------

async function boot() {
  applyLayout();
  applyTheme();
  page.setGrid(settings.grid);
  page.setFingerMode(settings.finger);
  updateToolbar();
  updateWatch();
  setPhase('idle');

  let data = null;
  const id = prefs.get('currentLesson', null);
  if (id) {
    try {
      data = await lessons.get(id);
    } catch {
      data = null;
    }
  }
  // The welcome board stays until the first real lesson with the tutor.
  if (data) loadLesson(data);
  else startFreshLesson({ welcome: !prefs.get('welcomed', false) });
  $('#clearMarksBtn').disabled = page.marks.length === 0;

  if (!window.isSecureContext) {
    toast('Open Chalkside from an https:// address (such as GitHub Pages) so the microphone works.', { kind: 'error', ms: 0 });
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();

// For the dev harness and debugging in the console.
window.chalkside = { page, board, audio, settings, S, sendFrame, ask, startSession, endSession, handleToolCalls };
