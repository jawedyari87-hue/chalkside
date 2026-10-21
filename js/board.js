// The tutor's chalkboard: pages of blocks written through tool calls.

import { renderRich, renderInline, plainText, repairLatex } from './math.js';
import { plotSVG } from './plot.js';
import { escapeHtml } from './util.js';
import { highlightCode } from './codehl.js';
import { diagramCopy } from './diagram.js';

const KIND_LABELS = {
  step: 'Step',
  definition: 'Definition',
  example: 'Example',
  hint: 'Hint',
  your_turn: 'Your turn',
  answer: 'Answer',
  warning: 'Watch out',
  summary: 'Summary',
  note: '',
  graph: 'Graph',
  picture: 'Picture',
  diagram: 'Diagram',
};

// Blocks drawn by their own tools, which write_on_board can't make or rewrite.
const DRAWN = new Set(['graph', 'picture', 'diagram']);

const KIND_ALIASES = {
  yourturn: 'your_turn', 'your turn': 'your_turn', question: 'your_turn', exercise: 'your_turn', practice: 'your_turn', try: 'your_turn',
  final: 'answer', result: 'answer', solution: 'answer',
  mistake: 'warning', caution: 'warning', pitfall: 'warning', error: 'warning',
  explanation: 'note', text: 'note', comment: 'note',
  working: 'step', method: 'step',
  recap: 'summary',
  theorem: 'definition', rule: 'definition', formula: 'definition', law: 'definition', identity: 'definition',
};

function normKind(k) {
  const s = String(k || 'note').toLowerCase().trim();
  if (s in KIND_LABELS && !DRAWN.has(s)) return s;
  return KIND_ALIASES[s] || KIND_ALIASES[s.replace(/[_-]+/g, ' ')] || 'note';
}

export function emptyBoard() {
  return { pages: [{ id: 1, title: '', blocks: [] }], nextId: 1, nextPageId: 2 };
}

export class Board extends EventTarget {
  constructor(els) {
    super();
    this.els = els; // { scroll, board, pill, pageLabel, pageTitle, prev, next }
    this.data = emptyBoard();
    this.view = 0;
    els.prev.addEventListener('click', () => this.go(this.view - 1));
    els.next.addEventListener('click', () => this.go(this.view + 1));
    els.pill.addEventListener('click', () => {
      if (this.view !== this.lastIndex) this.go(this.lastIndex);
      this.scrollToEnd();
      this.hidePill();
    });
    els.scroll.addEventListener(
      'scroll',
      () => {
        if (this.view === this.lastIndex && this.nearBottom()) this.hidePill();
      },
      { passive: true },
    );
  }

  get lastIndex() {
    return this.data.pages.length - 1;
  }
  get current() {
    return this.data.pages[this.lastIndex];
  }
  allBlocks() {
    return this.data.pages.flatMap((p) => p.blocks);
  }
  isEmpty() {
    return !this.data.pages.some((p) => p.blocks.length && !p.sample);
  }

  load(data) {
    const ok = data && Array.isArray(data.pages) && data.pages.length;
    this.data = ok ? structuredClone(data) : emptyBoard();
    this.data.nextId = Math.max(this.data.nextId || 1, 1 + Math.max(0, ...this.allBlocks().map((b) => b.id || 0)));
    this.data.nextPageId = Math.max(this.data.nextPageId || 2, 1 + Math.max(0, ...this.data.pages.map((p) => p.id || 0)));
    this.view = this.lastIndex;
    this.hidePill();
    this.render();
  }

  serialize() {
    return structuredClone(this.data);
  }

  firstTitle() {
    return this.data.pages.find((p) => p.title && !p.sample)?.title || '';
  }

  // Board content as plain text, so a fresh connection can pick up where the lesson left off.
  summary(maxBlocks = 14) {
    const blocks = this.data.pages.filter((p) => !p.sample).flatMap((p) => p.blocks.map((b) => ({ ...b, page: p.title })));
    return blocks.slice(-maxBlocks).map((b) => {
      let what = plainText(b.content, 300);
      if (b.kind === 'graph') what = `graph of ${(b.spec?.functions || []).map((f) => f.expr).join(', ')}`;
      if (b.kind === 'picture') what = `picture of ${b.pic?.title || b.query} from Wikipedia`;
      if (b.kind === 'diagram') what = `diagram: ${plainText(b.code, 200)}`;
      return `#${b.id} ${b.kind}${b.title ? ` "${b.title}"` : ''}: ${what}`;
    });
  }

  // The tutor's first real write replaces the welcome page.
  leaveSample() {
    const cur = this.current;
    if (!cur.sample) return;
    if (this.data.pages.length === 1) {
      this.data.pages = [{ id: this.data.nextPageId++, title: '', blocks: [], t: Date.now() }];
    } else {
      this.data.pages.push({ id: this.data.nextPageId++, title: '', blocks: [], t: Date.now() });
    }
    this.view = this.lastIndex;
    this.render();
  }

  write(args = {}) {
    const content = repairLatex(String(args.content ?? '')).trim();
    if (!content) throw new Error('content was empty, so nothing was written');
    const kind = normKind(args.kind);
    const title = repairLatex(String(args.title ?? '')).trim().slice(0, 120);
    const rid = Number(args.replace_id);
    if (rid) {
      const found = this.find(rid);
      if (found && !DRAWN.has(found.block.kind)) {
        // Keep the original time so the block stays in its place in the notes feed.
        Object.assign(found.block, { content, kind, title, edited: true });
        const { errors } = renderRich(content);
        if (found.pageIndex === this.view) this.rerender(found.block);
        this.announce(found.block, this.data.pages[found.pageIndex], true);
        this.changed();
        return { id: rid, replaced: true, errors };
      }
    }
    this.leaveSample();
    const block = { id: this.data.nextId++, kind, title, content, t: Date.now() };
    this.current.blocks.push(block);
    const errors = this.appendLatest(block);
    this.announce(block, this.current, false);
    this.changed();
    return { id: block.id, errors };
  }

  announce(block, page, replaced) {
    this.dispatchEvent(new CustomEvent('block', { detail: { block, page, replaced } }));
  }

  plot(spec = {}) {
    const clean = {
      functions: (Array.isArray(spec.functions) ? spec.functions : spec.functions ? [spec.functions] : [])
        .map((f) => (typeof f === 'string' ? { expr: f } : { expr: String(f?.expr ?? ''), label: f?.label ? String(f.label) : undefined }))
        .filter((f) => f.expr.trim()),
      x_min: spec.x_min,
      x_max: spec.x_max,
      y_min: spec.y_min,
      y_max: spec.y_max,
      points: Array.isArray(spec.points) ? spec.points.slice(0, 20) : [],
      title: spec.title ? String(spec.title).slice(0, 120) : '',
    };
    if (!clean.functions.length) throw new Error('no functions were given to plot');
    const { errors } = plotSVG(clean);
    if (errors.length === clean.functions.length) throw new Error(errors.join('; '));
    this.leaveSample();
    const block = { id: this.data.nextId++, kind: 'graph', title: clean.title, spec: clean, t: Date.now() };
    this.current.blocks.push(block);
    this.appendLatest(block);
    this.announce(block, this.current, false);
    this.changed();
    return { id: block.id, errors };
  }

  // A diagram, already drawn (by diagram.js) from the tutor's Mermaid code.
  addDiagram({ code, title = '', svg, svgId }) {
    this.leaveSample();
    const block = { id: this.data.nextId++, kind: 'diagram', title: repairLatex(String(title ?? '')).trim().slice(0, 120), code: String(code), svg, svgId, t: Date.now() };
    this.current.blocks.push(block);
    this.appendLatest(block);
    this.announce(block, this.current, false);
    this.changed();
    return block;
  }

  // A picture from Wikipedia: in place straight away ("Finding a picture…"), filled in by setPicture.
  addPicture(query, caption = '') {
    this.leaveSample();
    const title = repairLatex(String(caption ?? '')).trim().slice(0, 120);
    const block = { id: this.data.nextId++, kind: 'picture', title, query: String(query).slice(0, 120), pic: null, t: Date.now() };
    this.current.blocks.push(block);
    this.appendLatest(block);
    this.announce(block, this.current, false);
    this.changed();
    return block;
  }

  setPicture(id, pic) {
    const found = this.find(id);
    if (!found) return;
    found.block.pic = pic;
    if (found.pageIndex === this.view) this.rerender(found.block);
    this.announce(found.block, this.data.pages[found.pageIndex], true);
    this.changed();
  }

  // Take a block away again (a picture that couldn't be found).
  removeBlock(id) {
    const found = this.find(id);
    if (!found) return;
    const page = this.data.pages[found.pageIndex];
    page.blocks = page.blocks.filter((b) => b.id !== id);
    if (found.pageIndex === this.view) this.render();
    this.dispatchEvent(new CustomEvent('removed', { detail: { id } }));
    this.changed();
  }

  newPage(title) {
    const t = String(title ?? '').trim().slice(0, 80);
    const cur = this.current;
    if (cur.sample) {
      this.leaveSample();
      this.current.title = t;
    } else if (!cur.blocks.length) {
      cur.title = t;
    } else {
      this.data.pages.push({ id: this.data.nextPageId++, title: t, blocks: [], t: Date.now() });
    }
    this.view = this.lastIndex;
    this.hidePill();
    this.render();
    this.changed();
  }

  find(id) {
    for (let p = 0; p < this.data.pages.length; p++) {
      const block = this.data.pages[p].blocks.find((b) => b.id === id);
      if (block) return { block, pageIndex: p };
    }
    return null;
  }

  go(index) {
    const i = Math.max(0, Math.min(this.lastIndex, index));
    if (i === this.view) return;
    this.view = i;
    this.render();
    this.els.scroll.scrollTop = 0;
    if (i === this.lastIndex) this.hidePill();
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }

  labelFor(block, page) {
    if (block.kind === 'step') {
      if (block.title) return '';
      const n = page.blocks.filter((b) => b.kind === 'step' && !b.title && b.id <= block.id).length;
      return `Step ${n}`;
    }
    return KIND_LABELS[block.kind] || '';
  }

  renderBlock(block, page, animate) {
    const el = document.createElement('article');
    el.className = `blk blk--${block.kind}`;
    el.dataset.id = String(block.id);
    const label = this.labelFor(block, page);
    let errors = [];
    let head = '';
    if (label || block.title) {
      head =
        '<header class="blk__head">' +
        (label ? `<span class="blk__kind">${escapeHtml(label)}</span>` : '') +
        (block.title ? `<span class="blk__title">${renderInline(block.title)}</span>` : '') +
        (block.edited ? '<span class="blk__edited">corrected</span>' : '') +
        '</header>';
    } else if (block.edited) {
      head = '<header class="blk__head"><span class="blk__edited">corrected</span></header>';
    }
    let body;
    if (block.kind === 'picture') {
      const p = block.pic;
      if (!p) {
        body = `<p class="blk__pending">Finding a picture of ${escapeHtml(block.query)}…</p>`;
      } else {
        const credit = [p.artist, p.licence].filter(Boolean).join(', ');
        body =
          `<figure class="blk__pic"><img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.title)}">` +
          `<figcaption>${p.description ? `${escapeHtml(p.description)}. ` : ''}` +
          `<a href="${escapeHtml(p.page)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.title)} on Wikipedia</a>` +
          `${credit ? ` · <a href="${escapeHtml(p.file)}" target="_blank" rel="noopener noreferrer">Image: ${escapeHtml(credit)}</a>` : ''}</figcaption></figure>`;
      }
    } else if (block.kind === 'graph') {
      const r = plotSVG(block.spec);
      errors = r.errors;
      const legend = r.legend.length
        ? `<figcaption class="plot-legend">${r.legend
            .map((l) => `<span class="plot-key"><i style="background:${l.colour}"></i>${renderInline(l.label)}</span>`)
            .join('')}</figcaption>`
        : '';
      body = `<figure class="blk__plot">${r.svg}${legend}</figure>`;
    } else if (block.kind === 'diagram') {
      // Mermaid made this SVG in its strict mode, which strips scripts and links from labels.
      body = `<figure class="blk__diagram">${diagramCopy(block.svg, block.svgId)}</figure>`;
    } else {
      const r = renderRich(block.content);
      errors = r.errors;
      body = `<div class="blk__body">${r.html}</div>`;
    }
    el.innerHTML = head + body;
    highlightCode(el);
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('is-new');
      el.addEventListener('animationend', () => el.classList.remove('is-new'), { once: true });
    }
    return { el, errors };
  }

  rerender(block) {
    const page = this.data.pages[this.view];
    const old = this.els.board.querySelector(`.blk[data-id="${block.id}"]`);
    if (!old) return;
    const { el } = this.renderBlock(block, page, true);
    old.replaceWith(el);
  }

  appendLatest(block) {
    const page = this.current;
    if (this.view !== this.lastIndex) {
      const { errors } = this.renderBlock(block, page, false);
      this.showPill(`Tutor is writing on page ${this.lastIndex + 1}`);
      this.updateHeader();
      return errors;
    }
    const stick = this.nearBottom() || page.blocks.length === 1;
    this.els.board.querySelector('.board-empty')?.remove();
    const { el, errors } = this.renderBlock(block, page, true);
    this.els.board.append(el);
    this.updateHeader();
    if (stick) this.scrollToEnd();
    else this.showPill('New on the board');
    return errors;
  }

  render() {
    const page = this.data.pages[this.view];
    const frag = document.createDocumentFragment();
    if (!page.blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'board-empty';
      empty.innerHTML = '<p>The tutor writes the maths here as they explain it.</p>';
      frag.append(empty);
    }
    for (const b of page.blocks) frag.append(this.renderBlock(b, page, false).el);
    this.els.board.replaceChildren(frag);
    this.updateHeader();
  }

  updateHeader() {
    const n = this.data.pages.length;
    const page = this.data.pages[this.view];
    this.els.pageLabel.textContent = `${this.view + 1} / ${n}`;
    this.els.prev.disabled = this.view === 0;
    this.els.next.disabled = this.view === this.lastIndex;
    this.els.pageTitle.innerHTML = page.title ? renderInline(page.title) : '';
    this.els.pageTitle.hidden = !page.title;
  }

  nearBottom() {
    const s = this.els.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }

  scrollToEnd() {
    const s = this.els.scroll;
    requestAnimationFrame(() => s.scrollTo({ top: s.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  }

  showPill(text) {
    this.els.pill.textContent = text;
    this.els.pill.hidden = false;
  }

  hidePill() {
    this.els.pill.hidden = true;
  }
}
