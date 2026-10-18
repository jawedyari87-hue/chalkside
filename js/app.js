// Chalkside: a voice maths tutor (Gemini Live) that watches your handwriting
// and writes the maths on a chalkboard beside your page.

import { $, $$, clamp, debounce, sleep, uid, prefs, bytesToBase64, base64ToBytes, fmtClock, fmtDate, toast, imageToDataUrl, escapeHtml, cleanSpeech } from './util.js';
import { InkPage, PEN_COLOURS, HL_COLOURS, SWATCH } from './ink.js';
import { Board } from './board.js';
import { AudioEngine } from './audio.js';
import { LiveSession } from './live.js';
import { MODELS, VOICES, modelProfile, buildSystemPrompt, buildTools, ASKS, SCREEN_ASKS } from './prompt.js';
import { lessons } from './store.js';
import { openPdf, renderPdfPage, showThumbnails } from './pdfimport.js';
import { renderInline } from './math.js';
import { NotesView } from './notes.js';

const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
// The Android app shows Chalkside in a small floating window over other apps (?overlay),
// and uses ?overlay&settings for its settings screen. Both talk to the app through
// window.ChalksideAndroid. In the floating window the tutor sees the whole screen.
const OVERLAY = params.has('overlay');
const APP_SETTINGS = OVERLAY && params.has('settings');
const SCREEN = OVERLAY && !APP_SETTINGS;
// Straight away, so the full app never flashes up in the app's windows.
if (SCREEN) document.documentElement.classList.add('is-overlay');
if (APP_SETTINGS) document.documentElement.classList.add('is-app-settings');
if (MOCK) {
  try {
    const mock = await import('../dev/mock-live.js');
    mock.installMock();
    if (OVERLAY && !window.ChalksideAndroid) (await import('../dev/mock-native.js')).installMockNative();
  } catch {
    console.warn('[chalkside] ?mock needs the dev folder, which is not deployed here.');
  }
}
const droid = OVERLAY ? window.ChalksideAndroid || null : null;
const asks = SCREEN ? SCREEN_ASKS : ASKS;

// ---- settings --------------------------------------------------------------------

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.8-live',
  customModel: '',
  thinkingLevel: 'LOW',
  voice: 'Kore',
  help: 'balanced',
  about: '',
  replySpeed: 'quick',
  noisy: false,
  autoSend: true,
  watch: true,
  layout: 'board-left',
  grid: 'squares',
  finger: 'auto',
  theme: 'system',
  boardScale: 1,
  notesScale: 1.15,
  split: 0.45,
  splitV: 0.42,
  version: 2,
};
const savedSettings = prefs.get('settings', {});
const settings = { ...DEFAULTS, ...savedSettings };
const saveSettings = () => prefs.set('settings', settings);
// Version 1 waited 1.5 s of silence before replying ("time to think"), which felt slow.
// Saved settings from then have no replySpeed, so they pick up the quick default.
if ((savedSettings.version || 1) < 2) {
  delete settings.thinkTime;
  settings.version = 2;
  saveSettings();
}

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
pdfInput.addEventListener('change', () => {
  const f = pdfInput.files?.[0];
  pdfInput.value = '';
  if (!f) return;
  choosePdfPages(f, { verb: 'Add', busy: 'Adding…', help: 'Tap the pages to add to your page. The tutor will see them too.' }, async (pdf, pages) => {
    for (const n of pages) {
      const c = await renderPdfPage(pdf, n, 1600);
      page.addImage({ src: c.toDataURL('image/jpeg', 0.86), width: c.width, height: c.height });
    }
    toast(pages.length > 1 ? `Added ${pages.length} pages.` : 'Page added.', { ms: 3000 });
  });
});

// Pick pages of a PDF in the page dialog, then onPick(pdf, pageNumbers).
async function choosePdfPages(file, { verb, busy, help }, onPick) {
  $('#pdfTitle').textContent = file.name.replace(/\.pdf$/i, '');
  $('#pdfHelp').textContent = help;
  pdfGrid.innerHTML = '<p class="help">Opening the PDF…</p>';
  pdfAdd.disabled = true;
  pdfAdd.textContent = `${verb} pages`;
  pdfDlg.showModal();
  let pdf;
  try {
    pdf = await openPdf(file);
  } catch (err) {
    pdfGrid.innerHTML = `<p class="help">${escapeHtml(err.message || 'That PDF could not be opened.')}</p>`;
    return;
  }
  const selected = showThumbnails(pdf, pdfGrid, (n) => {
    pdfAdd.disabled = n === 0;
    pdfAdd.textContent = n > 1 ? `${verb} ${n} pages` : `${verb} page`;
  });
  pdfAdd.onclick = async () => {
    const pages = selected();
    pdfAdd.disabled = true;
    pdfAdd.textContent = busy;
    try {
      await onPick(pdf, pages);
    } catch (err) {
      toast(err.message || 'Those pages could not be used.', { kind: 'error' });
    }
    pdfDlg.close();
    pdf.destroy?.();
  };
}

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
  if (notes.isOpen) notes.renderAll();
  prefs.set('currentLesson', lesson.id);
}

function startFreshLesson({ welcome = false } = {}) {
  lesson = { id: uid(), title: 'Untitled lesson', created: Date.now(), updated: Date.now(), titleSet: false };
  page.load(null);
  board.load(welcome ? welcomeBoard() : null);
  transcript = [];
  renderLessonTitle();
  if (notes.isOpen) notes.renderAll();
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

// ---- expanded view: everything the tutor says and writes ---------------------------------------

const notesView = $('#notesView');
const notes = new NotesView({
  root: notesView,
  scroll: $('#notesScroll'),
  feed: $('#notesFeed'),
  pill: $('#notesPill'),
  board,
  getTranscript: () => transcript,
});

function applyNotesScale() {
  notesView.style.setProperty('--notes-scale', String(settings.notesScale));
}

function openNotes() {
  applyNotesScale();
  notes.open();
  app.classList.add('is-notes');
  $('#notesClose').focus({ preventScroll: true });
}

function closeNotes() {
  notes.close();
  app.classList.remove('is-notes');
  $('#expandBtn').focus({ preventScroll: true });
}

$('#expandBtn').addEventListener('click', openNotes);
$('#captions').addEventListener('click', openNotes);
$('#notesClose').addEventListener('click', closeNotes);
$('#notesSmaller').addEventListener('click', () => setNotesScale(settings.notesScale - 0.1));
$('#notesBigger').addEventListener('click', () => setNotesScale(settings.notesScale + 0.1));
function setNotesScale(v) {
  settings.notesScale = Math.round(clamp(v, 0.8, 2) * 10) / 10;
  applyNotesScale();
  saveSettings();
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !notes.isOpen || document.querySelector('dialog[open]')) return;
  if (SCREEN) setOvMode('bubble');
  else closeNotes();
});

// Board notes appear in the feed as they're written. Speech after a note starts
// a new line, so the feed reads in the order things happened.
board.addEventListener('block', (e) => {
  const { block, page, replaced } = e.detail;
  if (!replaced && S.tutorLine) {
    capTutor.dataset.cont = cleanSpeech(S.tutorLine.text).trim().slice(-140);
    finishTutorLine();
  }
  notes.onBlock(block, page, replaced);
  if (SCREEN && !replaced && ov.mode === 'bubble') {
    ov.unseen++;
    renderBadge();
  }
});

// ---- dialogs: shared close buttons ---------------------------------------------------------

$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog')?.close()));
// A tap outside a dialog closes it, except on the app's full-screen settings screen.
$$('dialog').forEach((d) =>
  d.addEventListener('click', (e) => {
    if (e.target === d && !APP_SETTINGS) d.close();
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
  replySpeed: $('#sReplySpeed'),
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
  if (SCREEN) {
    // The floating window has no room for the settings form, so the app opens its settings screen.
    if (reason) toast(reason, { ms: 6000 });
    droid?.openSettings();
    return;
  }
  f.key.value = settings.apiKey;
  f.key.type = 'password';
  $('#sKeyShow').textContent = 'Show';
  f.model.value = settings.model;
  f.custom.value = settings.customModel;
  f.think.value = settings.thinkingLevel;
  f.voice.value = settings.voice;
  f.about.value = settings.about;
  f.replySpeed.value = settings.replySpeed;
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
  settings.replySpeed = f.replySpeed.value;
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
  const { apiKey, model, customModel, thinkingLevel, voice, help, about, replySpeed, noisy } = settings;
  return { apiKey, model, customModel, thinkingLevel, voice, help, about, replySpeed, noisy };
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
  screenSeq: -1, // the newest picture of the screen sent to the tutor (Android app)
  screenPaused: false,
  sharingFile: false, // pictures of a file are going to the tutor, so the screen waits
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

// Whether the tutor is shown the student's page (web app) or screen (Android app) without being asked.
const canSee = () => (SCREEN ? !S.screenPaused : settings.autoSend);

function buildSetup() {
  const profile = S.profile || modelProfile(settings);
  const generationConfig = {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
    mediaResolution: 'MEDIA_RESOLUTION_HIGH',
  };
  if (profile.thinking) generationConfig.thinkingConfig = { thinkingLevel: settings.thinkingLevel };
  // How long a pause ends your turn. Google suggests 500-800 ms; Gemini's own app feels like the low end.
  const vad = {};
  if (settings.noisy) vad.startOfSpeechSensitivity = 'START_SENSITIVITY_LOW';
  if (settings.replySpeed === 'quick') {
    vad.endOfSpeechSensitivity = 'END_SENSITIVITY_HIGH';
    vad.silenceDurationMs = 500;
  } else if (settings.replySpeed === 'patient') {
    vad.endOfSpeechSensitivity = 'END_SENSITIVITY_LOW';
    vad.silenceDurationMs = 1500;
  }
  const setup = {
    model: `models/${profile.id}`,
    generationConfig,
    systemInstruction: { parts: [{ text: buildSystemPrompt(settings, { screen: SCREEN }) }] },
    tools: buildTools(profile, { screen: SCREEN }),
    // Left to guess, the transcript of what you say sometimes comes out in another language.
    inputAudioTranscription: { languageCodes: ['en-GB'] },
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
  const showPage = SCREEN ? canSee() : settings.autoSend || !!ask;
  if (showPage) sendFrame({ force: true });
  const earlier = board.isEmpty() ? '' : ` Earlier in this lesson you wrote these blocks on the board (newest last):\n${board.summary().join('\n')}\n`;
  let pageNote = showPage
    ? " The newest image shows the student's page."
    : " The student has chosen to share their page only when they ask you to check it, so you can't see it yet.";
  if (SCREEN) pageNote = showPage ? " The newest image shows the student's screen." : " The student has hidden their screen for now, so you can't see it.";
  setTimeout(() => {
    if (!S.live) return;
    if (ask) {
      const said = asks[ask] || ask;
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
  if (SCREEN) overlayPhase(p);
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
  // Chunks are 40 ms: about 0.2 s of sound starts "hearing", 0.8 s of quiet ends it.
  if (!S.hearing && S.vadAbove >= 5 && !S.muted) {
    S.hearing = true;
    S.lastUserSpeechAt = performance.now();
    if (S.phase === 'live' && performance.now() - S.lastFrameAt > 20000 && canSee()) sendFrame({ force: true });
    updateStatus();
  } else if (S.hearing && S.vadBelow >= 20) {
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
  const entry = { who: 'you', text, t: Date.now() };
  transcript.push(entry);
  capYou.textContent = `You: ${text}`;
  notes.onSpeech(entry);
  saveSoon();
}

function logYouSpeech(chunk) {
  if (!S.youLine) {
    S.youLine = { who: 'you', text: '', t: Date.now() };
    transcript.push(S.youLine);
  }
  S.youLine.text += chunk;
  capYou.textContent = `You: ${cleanSpeech(S.youLine.text).trim().slice(-160)}`;
  notes.onSpeech(S.youLine);
}

function logTutor(chunk) {
  S.youLine = null;
  const fresh = !S.tutorLine;
  if (fresh) {
    S.tutorLine = { who: 'tutor', text: '', t: Date.now() };
    transcript.push(S.tutorLine);
  }
  S.tutorLine.text += chunk;
  // After a board note the caption carries on from where the sentence was.
  capTutor.textContent = (fresh && capTutor.dataset.cont ? capTutor.dataset.cont + ' ' : '') + cleanSpeech(S.tutorLine.text).trim().slice(-220);
  capTutor.dataset.cont = '';
  notes.onSpeech(S.tutorLine);
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
  if (SCREEN) return sendScreenFrame(force);
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

// The Android app captures the screen and only has a new picture when something on it
// has changed. force sends the newest one again, for when the last was a while ago.
function sendScreenFrame(force) {
  if (!droid || S.screenPaused || S.sharingFile) return false;
  const now = performance.now();
  if (now - S.lastFrameAt < 900) return false; // the app makes at most one a second; this allows for timer jitter
  let frame = null;
  try {
    const raw = droid.frame(force ? -1 : S.screenSeq);
    if (raw) frame = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!frame?.data) return false;
  if (!S.live.send({ realtimeInput: { video: { data: frame.data, mimeType: 'image/jpeg' } } })) return false;
  S.screenSeq = frame.seq;
  S.lastFrameAt = now;
  return true;
}

// Make sure the tutor has the current page before a question about it. forceScreen: the
// question is about the screen, so resend it even if a shared file was shown since.
async function freshFrame(forceScreen = false) {
  if (SCREEN) {
    const wait = 1000 - (performance.now() - S.lastFrameAt);
    if (wait > 0) await sleep(wait);
    if (sendScreenFrame(forceScreen || performance.now() - S.lastFrameAt > 20000)) await sleep(350);
    return;
  }
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
  await freshFrame(what === 'screen');
  sendUserText(asks[what] || what);
}

$('#checkBtn').addEventListener('click', () => ask('check'));
$$('[data-ask]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.ask)));
for (const [formId, inputId] of [
  ['#typeForm', '#typeInput'],
  ['#notesTypeForm', '#notesTypeInput'],
]) {
  $(formId).addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $(inputId);
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.blur();
    ask(text);
  });
}

// ---- the Android app: a floating bar over other apps that opens into the notes ---------------
//
// The app puts this page in a small window that floats over whatever the student is using,
// sized to fit the bar, and sends pictures of the whole screen. Expand grows the window into
// a panel with everything the tutor says and writes.

const ovBar = $('#ovBar');
const OV_MARGIN = 6; // room around the bar for its shadow, in CSS pixels
const ov = { mode: 'bubble', unseen: 0, size: '', poll: 0, closing: false };

function setupOverlay() {
  document.documentElement.classList.add('is-overlay');
  ovBar.hidden = false;
  ovBar.prepend(sessionEl);
  $('#ovTools').prepend($('#notesSmaller'), $('#notesBigger'));
  $('#screenAsks').hidden = false;
  $('#ovExpand').addEventListener('click', () => setOvMode(ov.mode === 'panel' ? 'bubble' : 'panel'));
  $('#ovEye').addEventListener('click', toggleScreen);
  $('#ovClose').addEventListener('click', closeOverlay);
  new ResizeObserver(() => fitBubble()).observe(ovBar);
  // The floating window only takes the keyboard while you type, so it doesn't steal it from other apps.
  const input = $('#notesTypeInput');
  input.addEventListener('pointerdown', () => droid?.setFocusable(true));
  input.addEventListener('focus', () => droid?.setFocusable(true));
  input.addEventListener('blur', () => droid?.setFocusable(false));
  toast.hook = overlayToast;
  window.chalksideNative = onNative;
  $('#shareBtn').hidden = false;
  $('#shareBtn').addEventListener('click', pickFileToShare);
  shareInput.addEventListener('change', onShareFile);
  shareInput.addEventListener('cancel', reopenAfterPick);
  $('#shareStop').addEventListener('click', () => {
    share.stop = true;
    $('#shareStop').hidden = true;
  });
  setOvMode('bubble');
}

function setOvMode(mode) {
  ov.mode = mode;
  document.documentElement.dataset.ov = mode;
  const expand = $('#ovExpand');
  expand.setAttribute('aria-expanded', String(mode === 'panel'));
  expand.setAttribute('aria-label', mode === 'panel' ? 'Shrink back to the small bar' : 'Show everything the tutor says and writes');
  if (mode === 'panel') {
    ov.unseen = 0;
    ov.size = '';
    renderBadge();
    droid?.setMode('panel', 0, 0);
    openNotes();
  } else {
    droid?.setFocusable(false);
    if (notes.isOpen) closeNotes();
    fitBubble();
  }
}

// Tell the app how big the bar is, so the floating window fits it exactly.
function fitBubble() {
  if (ov.mode !== 'bubble' || ovBar.hidden) return;
  const r = ovBar.getBoundingClientRect();
  const w = Math.ceil(r.width) + 2 * OV_MARGIN;
  const h = Math.ceil(r.height) + 2 * OV_MARGIN;
  if (`${w}x${h}` === ov.size) return;
  ov.size = `${w}x${h}`;
  droid?.setMode('bubble', w, h);
}

function renderBadge() {
  const badge = $('#ovBadge');
  badge.hidden = !ov.unseen;
  badge.textContent = ov.unseen > 9 ? '9+' : String(ov.unseen);
}

function overlayPhase(p) {
  droid?.keepScreenOn(p !== 'idle');
  droid?.setCapture(p !== 'idle' && !S.screenPaused);
  // Pictures of the screen go over about once a second, but only when it has changed.
  clearInterval(ov.poll);
  ov.poll = p === 'live' ? setInterval(() => sendFrame(), 1000) : 0;
  fitBubble();
}

function toggleScreen() {
  S.screenPaused = !S.screenPaused;
  const eye = $('#ovEye');
  eye.setAttribute('aria-pressed', String(!S.screenPaused));
  eye.setAttribute('aria-label', S.screenPaused ? 'Let the tutor see your screen again' : 'Hide your screen from the tutor');
  droid?.setCapture(S.phase !== 'idle' && !S.screenPaused);
  toast(S.screenPaused ? 'The tutor can no longer see your screen.' : 'The tutor can see your screen again.', { ms: 2500 });
  if (!S.screenPaused) setTimeout(() => sendFrame({ force: true }), 300);
}

async function closeOverlay() {
  if (ov.closing) return;
  ov.closing = true;
  if (sessionActive()) endSession({ quiet: true });
  await saveNow();
  droid?.stop();
}

// In the small bar there's no room for messages: errors and anything with a button open
// the panel, and the rest show as Android toasts.
function overlayToast(message, { kind, actionLabel }) {
  if (ov.mode === 'panel' || !droid) return false;
  if (kind === 'error' || actionLabel) {
    setOvMode('panel');
    return false;
  }
  droid.toast(message);
  return true;
}

// Messages from the Android app.
function onNative(type) {
  if (type === 'stop') closeOverlay();
  else if (type === 'blur') document.activeElement?.blur?.(); // you tapped another app, or Back, while typing
  else if (type === 'screen-started') {
    toast('The tutor can see your screen again.', { ms: 3000 });
    setTimeout(() => sendFrame({ force: true }), 1200);
  } else if (type === 'screen-stopped') {
    toast("Screen sharing has stopped, so the tutor can't see your screen any more. Start a new lesson in the Chalkside app to share it again.", {
      kind: 'error',
      ms: 12000,
    });
  } else if (type === 'settings') {
    // The app's settings screen saved new settings (it shares this page's storage).
    const before = JSON.stringify(setupRelevant());
    Object.assign(settings, DEFAULTS, prefs.get('settings', {}));
    applyNotesScale();
    if (!sessionActive()) {
      if (settings.apiKey) startSession();
    } else if (JSON.stringify(setupRelevant()) !== before) {
      toast('Saved. The tutor picks up the new settings next time you start.', { actionLabel: 'Restart now', onAction: restartSession, ms: 9000 });
    }
  }
}

// ---- showing the tutor a file: a whole PDF, or a picture (Android app) -------------------------
//
// The Live API takes pictures, not documents, so a PDF goes over as a picture of each page,
// about one a second (the same way as the screen), then a note saying what they were.

const shareInput = $('#shareInput');
const SHARE_MAX_PAGES = 60;
const share = { busy: false, stop: false };
let reopenPanel = false;

// The panel shrinks to the bar while Android's file picker is open, and opens again afterwards.
function pickFileToShare() {
  if (!sessionActive()) {
    toast('Start the tutor first, then show it a file.', { ms: 4000 });
    return;
  }
  if (share.busy) return;
  reopenPanel = ov.mode === 'panel';
  setOvMode('bubble');
  shareInput.click();
}

function reopenAfterPick() {
  if (reopenPanel && ov.mode !== 'panel') setOvMode('panel');
  reopenPanel = false;
}

async function onShareFile() {
  const file = shareInput.files?.[0];
  shareInput.value = '';
  reopenAfterPick();
  if (!file || share.busy) return;
  if (S.phase !== 'live' || !S.live) {
    toast('The tutor is not connected. Start it, then show it the file again.', { kind: 'error' });
    return;
  }
  const name = file.name || 'your file';
  share.busy = true;
  share.stop = false;
  $('#shareBtn').disabled = true;
  try {
    if (/pdf$/i.test(file.type) || /\.pdf$/i.test(name)) await sharePdf(file, name);
    else if (/^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) await sharePicture(file, name);
    else toast('Choose a PDF or a picture.', { ms: 4000 });
  } catch (err) {
    toast(err.message || "That file couldn't be opened.", { kind: 'error' });
  } finally {
    share.busy = false;
    $('#shareBtn').disabled = false;
    shareStatus('');
  }
}

async function sharePicture(file, name) {
  const img = await imageToDataUrl(file, 1600, 0.85);
  shareStatus(`Sending ${name}…`);
  if (!(await sendPicture(img.src.split(',')[1]))) throw new Error('The tutor disconnected while the picture was being sent.');
  tellTutor(name, `[The student has shared a picture, ${name}. The newest image shows it, not their screen. Look at it closely.]`);
}

async function sharePdf(file, name) {
  shareStatus(`Opening ${name}…`);
  const pdf = await openPdf(file);
  const total = pdf.numPages;
  const count = Math.min(total, SHARE_MAX_PAGES);
  let sent = 0;
  try {
    for (let n = 1; n <= count && !share.stop; n++) {
      shareStatus(`Sending ${name}: page ${n} of ${count}`, true);
      const picture = labelPage(await renderPdfPage(pdf, n, 1200), `${name}, page ${n} of ${total}`);
      if (!(await sendPicture(picture))) throw new Error(sent ? `The tutor disconnected after page ${sent}.` : 'The tutor disconnected while the PDF was being sent.');
      sent = n;
    }
  } finally {
    pdf.destroy?.();
    if (sent) {
      const part = sent < total ? `the first ${sent} of its ${total} pages` : `all ${total} page${total === 1 ? '' : 's'}`;
      tellTutor(
        `${name} (${sent < total ? `pages 1–${sent} of ${total}` : `${total} page${total === 1 ? '' : 's'}`})`,
        `[The student has shared a PDF, ${name}: ${part}, as the last ${sent} image${sent === 1 ? '' : 's'}, in order. Each page is labelled with its page number at the top. They are a file, not the student's screen. Look at them closely.]`,
      );
    }
  }
  if (total > SHARE_MAX_PAGES && !share.stop) toast(`That PDF has ${total} pages, so the tutor was shown the first ${SHARE_MAX_PAGES}.`, { ms: 6000 });
}

// A strip above the page saying which page it is, so the tutor can say "on page 3".
function labelPage(canvas, label) {
  const strip = 44;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + strip;
  const g = out.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(canvas, 0, strip);
  g.fillStyle = '#444444';
  g.font = '600 24px sans-serif';
  g.textBaseline = 'middle';
  g.fillText(label, 24, strip / 2, out.width - 48);
  g.fillStyle = '#cccccc';
  g.fillRect(0, strip - 2, out.width, 2);
  return out.toDataURL('image/jpeg', 0.85).split(',')[1];
}

// One picture, at least a second after the last (the screen waits meanwhile). Rides out a reconnect.
async function sendPicture(data) {
  S.sharingFile = true;
  try {
    const wait = 1000 - (performance.now() - S.lastFrameAt);
    if (wait > 0) await sleep(wait);
    for (let tries = 0; tries < 20; tries++) {
      if (S.live?.send({ realtimeInput: { video: { data, mimeType: 'image/jpeg' } } })) {
        S.lastFrameAt = performance.now();
        return true;
      }
      if (S.phase !== 'reconnecting') return false;
      await sleep(500);
    }
    return false;
  } finally {
    S.sharingFile = false;
  }
}

// Tell the tutor what it was just shown, and show it in the notes.
function tellTutor(label, note) {
  if (!sendRaw(`${note} Can you take a look at this?`)) return;
  logYou(`Shared ${label}`);
  setAwaiting();
}

function shareStatus(text, canStop = false) {
  $('#shareStatus').hidden = !text;
  $('#shareStatusText').textContent = text;
  $('#shareStop').hidden = !canStop;
}

// ---- the Android app's settings screen (?overlay&settings) ------------------------------------

function setupAppSettings() {
  document.documentElement.classList.add('is-app-settings');
  settingsDlg.addEventListener('close', () => droid?.settingsClosed(!!settings.apiKey));
  openSettings();
}

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
  if (APP_SETTINGS) {
    setupAppSettings();
    return;
  }

  let data = null;
  const id = prefs.get('currentLesson', null);
  if (id) {
    try {
      data = await lessons.get(id);
    } catch {
      data = null;
    }
  }
  // The welcome board stays until the first real lesson with the tutor. In the Android
  // app a lesson carries on if you come back within a couple of hours.
  const recent = (L) => Date.now() - (L.updated || 0) < 2 * 60 * 60 * 1000;
  if (data && (!SCREEN || recent(data))) loadLesson(data);
  else startFreshLesson({ welcome: !SCREEN && !prefs.get('welcomed', false) });
  $('#clearMarksBtn').disabled = page.marks.length === 0;

  if (!window.isSecureContext) {
    toast('Open Chalkside from an https:// address (such as GitHub Pages) so the microphone works.', { kind: 'error', ms: 0 });
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (SCREEN) {
    setupOverlay();
    // You started a lesson in the app, so the tutor starts straight away.
    startSession();
  }
}

boot();

// For the dev harness and debugging in the console.
window.chalkside = { page, board, audio, settings, S, sendFrame, ask, startSession, endSession, handleToolCalls };
