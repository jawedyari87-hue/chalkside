// The expanded view: one big, readable feed of everything the tutor says (live,
// word by word) with its board notes in between, in the order they happened.
//
// Each new exchange scrolls up to the top of the view, with empty space below it for what
// comes next, so earlier notes don't crowd the screen. While the tutor talks and writes, the
// view follows its newest line, unless you've scrolled back to read something.

import { renderInline } from './math.js';
import { cleanSpeech } from './util.js';

// After this long without anything new, the tutor speaking up starts a new exchange.
const NEW_TURN_GAP = 8000;

// Spoken words. The live transcript sometimes spells maths in LaTeX ("a symbol $a$"), so render that.
function setSpeech(p, text) {
  const t = cleanSpeech(text).trim();
  if (/\$|\\\(/.test(t)) p.innerHTML = renderInline(t);
  else p.textContent = t;
}

// The web pages Google Search found for an answer, and Google's search suggestions as it sent
// them (in a sandboxed frame, so its HTML can't touch the app).
function fillSources(li, entry) {
  li.replaceChildren();
  if (entry.links.length) {
    const p = document.createElement('p');
    p.className = 'nt__sources';
    p.append('Sources: ');
    entry.links.forEach((l, i) => {
      if (i) p.append(' · ');
      const a = document.createElement('a');
      a.href = l.uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.title;
      p.append(a);
    });
    li.append(p);
  }
  if (entry.html) {
    const frame = document.createElement('iframe');
    frame.className = 'nt__search';
    frame.title = 'Google Search suggestions';
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.srcdoc = `<base target="_blank">${entry.html}`;
    li.append(frame);
  }
}

export class NotesView {
  constructor({ root, scroll, feed, pill, board, getTranscript }) {
    this.root = root;
    this.scroll = scroll;
    this.feed = feed;
    this.pill = pill;
    this.board = board;
    this.getTranscript = getTranscript;
    this.els = new WeakMap(); // transcript entry -> its <li>
    this.lastPageId = null;
    this.turnStart = null; // the <li> the current exchange starts with
    this.lastAt = 0;
    this.follow = true;
    this.byHand = false;
    pill.addEventListener('click', () => {
      this.follow = true;
      this.showLatest(true);
    });
    // Scrolling by hand stops the view following along, until the newest line is back in view.
    const touched = () => (this.byHand = true);
    scroll.addEventListener('wheel', touched, { passive: true });
    scroll.addEventListener('touchmove', touched, { passive: true });
    scroll.addEventListener(
      'scroll',
      () => {
        if (!this.byHand) return;
        this.follow = this.latestVisible();
        if (this.follow) pill.hidden = true;
      },
      { passive: true },
    );
    scroll.addEventListener('scrollend', () => (this.byHand = false));
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    this.root.hidden = false;
    this.renderAll();
    this.follow = true;
    this.showLatest(false);
  }

  close() {
    this.root.hidden = true;
    this.feed.replaceChildren();
  }

  // Speech and board notes merged into one timeline.
  timeline() {
    const items = this.getTranscript().map((entry) => ({ kind: 'say', entry, t: entry.t || 0 }));
    for (const page of this.board.data.pages) {
      if (page.sample) continue;
      for (const block of page.blocks) items.push({ kind: 'block', block, page, t: block.t || 0 });
    }
    return items.sort((a, b) => a.t - b.t);
  }

  renderAll() {
    const frag = document.createDocumentFragment();
    this.lastPageId = null;
    const items = this.timeline();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'nt nt--empty';
      li.textContent = 'Start the tutor and everything it says and writes appears here, live.';
      frag.append(li);
    }
    for (const it of items) {
      if (it.kind === 'say') frag.append(this.sayEl(it.entry));
      else frag.append(...this.blockEls(it.block, it.page, false));
    }
    this.feed.replaceChildren(frag);
    // The latest exchange starts with the last thing you said.
    const lis = [...this.feed.children];
    this.turnStart = lis.findLast((li) => li.classList.contains('nt--you')) || lis.at(-1) || null;
  }

  sayEl(entry) {
    const li = document.createElement('li');
    if (entry.who === 'sources') {
      li.className = 'nt nt--sources';
      fillSources(li, entry);
    } else {
      li.className = `nt nt--${entry.who === 'tutor' ? 'tutor' : 'you'}`;
      const p = document.createElement('p');
      p.className = 'nt__text';
      setSpeech(p, entry.text);
      li.append(p);
    }
    this.els.set(entry, li);
    return li;
  }

  blockEls(block, page, animate) {
    const out = [];
    if (page.id !== this.lastPageId) {
      this.lastPageId = page.id;
      if (page.title) {
        const h = document.createElement('li');
        h.className = 'nt nt--page';
        h.innerHTML = `<h3>${renderInline(page.title)}</h3>`;
        out.push(h);
      }
    }
    const li = document.createElement('li');
    li.className = 'nt nt--block';
    li.dataset.id = String(block.id);
    li.append(this.board.renderBlock(block, page, animate).el);
    this.whenPicturesLoad(li);
    out.push(li);
    return out;
  }

  // A picture arriving makes the feed taller after it has scrolled, so settle it again.
  whenPicturesLoad(el) {
    for (const img of el.querySelectorAll('img')) {
      img.addEventListener('load', () => this.follow && this.isOpen && this.showLatest(false), { once: true });
    }
  }

  // A tutor or student line was created or grew.
  onSpeech(entry) {
    if (!this.isOpen) return;
    this.feed.querySelector('.nt--empty')?.remove();
    const now = Date.now();
    let li = this.els.get(entry);
    if (!li) {
      li = this.sayEl(entry);
      this.feed.append(li);
      // Anything you say starts a new exchange; so does the tutor speaking up after a quiet spell.
      const quiet = now - this.lastAt > NEW_TURN_GAP || !this.turnStart?.isConnected;
      if (entry.who === 'you' || (entry.who === 'tutor' && quiet)) {
        this.turnStart = li;
        this.follow = true;
      }
    } else if (entry.who === 'sources') {
      fillSources(li, entry);
    } else {
      setSpeech(li.firstElementChild, entry.text);
    }
    this.lastAt = now;
    this.update();
  }

  onBlock(block, page, replaced) {
    if (!this.isOpen) return;
    this.feed.querySelector('.nt--empty')?.remove();
    this.lastAt = Date.now();
    if (replaced) {
      const old = this.feed.querySelector(`.nt--block[data-id="${block.id}"]`);
      if (old) {
        old.replaceChildren(this.board.renderBlock(block, page, true).el);
        this.whenPicturesLoad(old);
        return;
      }
    }
    this.feed.append(...this.blockEls(block, page, true));
    this.update();
  }

  // A block taken off the board (a picture Wikipedia didn't have).
  onRemoved(id) {
    this.feed.querySelector(`.nt--block[data-id="${id}"]`)?.remove();
  }

  update() {
    if (this.follow) this.showLatest(true);
    else this.pill.hidden = false;
  }

  // Where an element sits in the scrolled content.
  offset(el) {
    return el.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop;
  }

  // The current exchange at the top of the view, with empty space below it; once it is
  // taller than the view, its newest lines.
  showLatest(smooth) {
    this.pill.hidden = true;
    requestAnimationFrame(() => {
      const last = this.feed.lastElementChild;
      if (!last) return;
      const start = this.turnStart?.isConnected ? this.turnStart : last;
      const s = this.scroll;
      const bottom = this.offset(last) + last.offsetHeight + 24;
      const top = Math.max(0, Math.max(this.offset(start) - 12, bottom - s.clientHeight));
      if (Math.abs(top - s.scrollTop) < 2) return;
      s.scrollTo({ top, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    });
  }

  latestVisible() {
    const last = this.feed.lastElementChild;
    if (!last) return true;
    const s = this.scroll;
    return this.offset(last) + last.offsetHeight <= s.scrollTop + s.clientHeight + 40;
  }
}
