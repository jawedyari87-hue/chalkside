// The expanded view: one big, readable feed of everything the tutor says (live,
// word by word) with its board notes in between, in the order they happened.

import { renderInline } from './math.js';
import { cleanSpeech } from './util.js';

// Spoken words. The live transcript sometimes spells maths in LaTeX ("a symbol $a$"), so render that.
function setSpeech(p, text) {
  const t = cleanSpeech(text).trim();
  if (/\$|\\\(/.test(t)) p.innerHTML = renderInline(t);
  else p.textContent = t;
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
    pill.addEventListener('click', () => this.toEnd(true));
    scroll.addEventListener(
      'scroll',
      () => {
        if (this.nearBottom()) pill.hidden = true;
      },
      { passive: true },
    );
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    this.root.hidden = false;
    this.renderAll();
    this.toEnd(false);
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
  }

  sayEl(entry) {
    const li = document.createElement('li');
    li.className = `nt nt--${entry.who === 'tutor' ? 'tutor' : 'you'}`;
    const p = document.createElement('p');
    p.className = 'nt__text';
    setSpeech(p, entry.text);
    li.append(p);
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
    out.push(li);
    return out;
  }

  // A tutor or student line was created or grew.
  onSpeech(entry) {
    if (!this.isOpen) return;
    const stick = this.nearBottom();
    this.feed.querySelector('.nt--empty')?.remove();
    let li = this.els.get(entry);
    if (!li) {
      li = this.sayEl(entry);
      this.feed.append(li);
    } else {
      setSpeech(li.firstElementChild, entry.text);
    }
    this.after(stick);
  }

  onBlock(block, page, replaced) {
    if (!this.isOpen) return;
    const stick = this.nearBottom();
    this.feed.querySelector('.nt--empty')?.remove();
    if (replaced) {
      const old = this.feed.querySelector(`.nt--block[data-id="${block.id}"]`);
      if (old) {
        old.replaceChildren(this.board.renderBlock(block, page, true).el);
        return;
      }
    }
    this.feed.append(...this.blockEls(block, page, true));
    this.after(stick);
  }

  after(stick) {
    if (stick) this.toEnd(true);
    else this.pill.hidden = false;
  }

  nearBottom() {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  }

  toEnd(smooth) {
    this.pill.hidden = true;
    const s = this.scroll;
    requestAnimationFrame(() =>
      s.scrollTo({ top: s.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' }),
    );
  }
}
