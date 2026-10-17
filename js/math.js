// Markdown + LaTeX rendering for the board, with repairs for the ways LaTeX
// gets mangled on its way through a JSON function call.

import { escapeHtml } from './util.js';

const KATEX_MACROS = {
  '\\R': '\\mathbb{R}',
  '\\N': '\\mathbb{N}',
  '\\Z': '\\mathbb{Z}',
  '\\Q': '\\mathbb{Q}',
  '\\C': '\\mathbb{C}',
};

// Commands that a stray extra backslash ("\\frac") turns into a line break plus text.
const KNOWN_CMDS = new Set(
  ('frac dfrac tfrac sqrt sum prod int iint oint lim infty partial nabla cdot cdots ldots dots vdots ddots times div pm mp ' +
    'le leq ge geq ne neq approx equiv sim simeq cong propto in notin ni subset subseteq supset supseteq cup cap bigcup bigcap setminus ' +
    'emptyset varnothing forall exists nexists neg lnot land lor implies impliedby iff to mapsto rightarrow leftarrow Rightarrow Leftarrow ' +
    'Leftrightarrow leftrightarrow longrightarrow Longrightarrow uparrow downarrow alpha beta gamma delta epsilon varepsilon zeta eta theta ' +
    'vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda ' +
    'Xi Pi Sigma Upsilon Phi Psi Omega left right big Big bigg Bigg bigl bigr Bigl Bigr begin end text textbf textit textrm mathrm mathbf ' +
    'mathbb mathcal mathit mathsf mathfrak operatorname vec hat bar overline underline widehat widetilde tilde dot ddot binom choose pmod bmod ' +
    'mod log ln lg exp sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh max min sup inf det dim ker deg gcd lcm arg Pr quad ' +
    'qquad hline displaystyle textstyle boxed cancel underbrace overbrace overset underset stackrel color mid nmid parallel perp angle ' +
    'triangle circ bullet star ast oplus otimes odot wedge vee top bot vdash models prime ell hbar Re Im aleph lfloor rfloor lceil rceil ' +
    'langle rangle lvert rvert lVert rVert vert Vert because therefore square blacksquare checkmark dagger cdotp colon').split(' '),
);

/**
 * Undo common damage to LaTeX inside tool-call strings:
 * - "\frac" sent as JSON without escaping arrives as form-feed + "rac", "\beta" as backspace + "eta", etc.
 * - "\\frac" (double-escaped) arrives as a line break followed by "frac".
 */
export function repairLatex(src) {
  let s = typeof src === 'string' ? src : String(src ?? '');
  s = s.replace(/\f/g, '\\f').replace(/\x08/g, '\\b');
  s = s.replace(/\t(?=(imes|heta|au|ext|an\b|anh|frac|o\b|op\b|riangle|ilde|herefore|extbf|extit|extrm|imes))/g, '\\t');
  s = s.replace(/\r(?=(ightarrow|ho\b|ight\b|ight[(|.[\]\\]|angle|floor|ceil|vert|Vert|m\b))/g, '\\r');
  return s;
}

function repairInsideMath(tex) {
  let s = tex;
  // A real newline followed by one of these can only be a lost backslash.
  s = s.replace(/\n(?=(eq(?![a-z])|abla|otin|eg(?![a-z])|exists|mid(?![a-z])|leq|geq|subseteq|parallel))/g, '\\n');
  s = s.replace(/\\\\([A-Za-z]+)/g, (m, name) => (KNOWN_CMDS.has(name) ? '\\' + name : m));
  return s;
}

// Split text into prose and maths segments.
export function splitMath(src) {
  const out = [];
  let buf = '';
  let i = 0;
  const pushText = () => {
    if (buf) out.push({ type: 'text', value: buf });
    buf = '';
  };
  const pushMath = (value, display) => {
    pushText();
    out.push({ type: 'math', value, display });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '$') {
      buf += '\\$';
      i += 2;
      continue;
    }
    if (src.startsWith('$$', i)) {
      const j = src.indexOf('$$', i + 2);
      if (j > i + 2) {
        pushMath(src.slice(i + 2, j), true);
        i = j + 2;
        continue;
      }
    }
    if (src.startsWith('\\[', i)) {
      const j = src.indexOf('\\]', i + 2);
      if (j > -1) {
        pushMath(src.slice(i + 2, j), true);
        i = j + 2;
        continue;
      }
    }
    if (src.startsWith('\\(', i)) {
      const j = src.indexOf('\\)', i + 2);
      if (j > -1) {
        pushMath(src.slice(i + 2, j), false);
        i = j + 2;
        continue;
      }
    }
    if (src.startsWith('\\begin{', i)) {
      // A bare environment such as \begin{aligned}...\end{aligned} with no $$ around it.
      const m = /^\\begin\{([a-zA-Z*]+)\}/.exec(src.slice(i));
      if (m) {
        const endTag = `\\end{${m[1]}}`;
        const j = src.indexOf(endTag, i);
        if (j > -1) {
          pushMath(src.slice(i, j + endTag.length), true);
          i = j + endTag.length;
          continue;
        }
      }
    }
    if (c === '$') {
      const j = findInlineClose(src, i + 1);
      if (j > -1) {
        pushMath(src.slice(i + 1, j), false);
        i = j + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  pushText();
  return out;
}

// Pandoc's rule: no space just inside the dollars, and a closing $ is not followed by a digit.
function findInlineClose(s, start) {
  if (start >= s.length || /\s/.test(s[start])) return -1;
  for (let k = start; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '\n' && s[k + 1] === '\n') return -1;
    if (ch === '$') {
      if (/\s/.test(s[k - 1])) continue;
      if (/\d/.test(s[k + 1] || '')) continue;
      return k;
    }
  }
  return -1;
}

// Content with LaTeX commands but no delimiters at all is almost certainly one formula.
function looksLikeBareLatex(s) {
  if (/\$|\\\(|\\\[|\\begin\{/.test(s)) return false;
  if (/\n\s*\n/.test(s)) return false;
  if (/^\s*([#>*-]|\d+\.)\s/m.test(s)) return false;
  const cmds = (s.match(/\\[a-zA-Z]+/g) || []).length;
  const prose = s.replace(/\\(text|textbf|textit|mathrm|operatorname|mathbf)\{[^{}]*\}/g, ' ').replace(/\\[a-zA-Z]+/g, ' ');
  const words = (prose.match(/[a-zA-Z]{4,}/g) || []).length;
  return cmds >= 1 && words === 0;
}

const TEX_FENCE = /```[ \t]*(latex|tex|math|katex)?[ \t]*\n([\s\S]*?)```/gi;
const looksTexy = (s) => /\\[a-zA-Z]{2,}|[\^_]\{/.test(s);

// Models sometimes put maths in code blocks or forget the dollar signs, which
// shows as raw LaTeX "code". Turn those back into maths.
export function rescueMaths(src) {
  let s = src.replace(TEX_FENCE, (whole, lang, body) => (lang || looksLikeBareLatex(body.trim()) ? `\n$$${body.trim()}$$\n` : whole));
  s = s.replace(/`([^`\n]+)`/g, (whole, body) => (looksTexy(body) ? `$${body}$` : whole));
  return s
    .split('\n')
    .map((line) => {
      if (!looksTexy(line) || /\$|\\\(|\\\[|```/.test(line)) return line;
      // Table rows: fix each cell on its own.
      if (/^\s*\|/.test(line)) return line.split('|').map((cell) => (looksTexy(cell) ? ` $${cell.trim()}$ ` : cell)).join('|');
      // Keep list bullets, numbers and headings outside the maths.
      const lead = /^(?:\s*(?:[-*+>]|\d+\.)\s+|\s*#{1,6}\s+)?/.exec(line)[0];
      const rest = line.slice(lead.length);
      if (looksLikeBareLatex(rest)) return lead ? `${lead}$${rest.trim()}$` : `$$${rest.trim()}$$`;
      // "Prose: formula" or "Prose = formula" with the formula left bare.
      const m = /^(.*?(?::|=|—|–| -)\s+)(.+)$/.exec(rest);
      if (m && looksLikeBareLatex(m[2])) return `${lead}${m[1]}$${m[2].trim()}$`;
      return line;
    })
    .join('\n');
}

function renderTex(tex, display, errors) {
  const k = window.katex;
  const clean = repairInsideMath(tex).trim();
  if (!k) return `<code class="tex-raw">${escapeHtml(clean)}</code>`;
  const opts = { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, macros: { ...KATEX_MACROS }, output: 'htmlAndMathml' };
  try {
    return k.renderToString(clean, opts);
  } catch (err) {
    errors.push(`${String(err.message || err).replace(/^KaTeX parse error: /, '')} in: ${clean.slice(0, 80)}`);
    try {
      return k.renderToString(clean, { ...opts, throwOnError: false, errorColor: '#ff9d8f' });
    } catch {
      return `<code class="tex-raw">${escapeHtml(clean)}</code>`;
    }
  }
}

function sanitize(html) {
  const P = window.DOMPurify;
  if (!P) return html;
  return P.sanitize(html, {
    FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'textarea', 'select', 'button', 'video', 'audio', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
}

function markdown(md, inline) {
  const m = window.marked;
  if (!m) {
    return escapeHtml(md).replace(/\n/g, '<br>');
  }
  const opts = { gfm: true, breaks: true, async: false };
  return inline ? m.parseInline(md, opts) : m.parse(md, opts);
}

/**
 * Render Markdown + LaTeX to safe HTML.
 * Returns { html, errors } where errors lists LaTeX the renderer could not parse.
 */
export function renderRich(src, { inline = false } = {}) {
  const errors = [];
  let text = repairLatex(src).replace(/\r\n?/g, '\n');
  if (!inline && looksLikeBareLatex(text)) text = `$$${text}$$`;
  else text = rescueMaths(text);
  const parts = splitMath(text);
  const maths = [];
  let md = '';
  for (const p of parts) {
    if (p.type === 'text') {
      md += p.value;
    } else {
      maths.push({ html: renderTex(p.value, p.display && !inline, errors), display: p.display && !inline });
      md += `⟦${maths.length - 1}⟧`;
    }
  }
  // Links open in a new tab so they never replace the app mid-lesson.
  let html = sanitize(markdown(md, inline)).replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  // A display formula alone in a paragraph does not need the paragraph's margins.
  html = html.replace(/<p>\s*⟦(\d+)⟧\s*<\/p>/g, (whole, n) => (maths[Number(n)]?.display ? maths[Number(n)].html : whole));
  html = html.replace(/⟦(\d+)⟧/g, (_, n) => maths[Number(n)]?.html ?? '');
  return { html, errors };
}

export function renderInline(src) {
  return renderRich(src, { inline: true }).html;
}

// Plain-text version of board content, for summaries sent back to the model.
export function plainText(src, max = 400) {
  const s = String(src ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
