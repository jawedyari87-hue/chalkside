// Safe expression parser (no eval) and an SVG function plotter for the board.

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cosec: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, sgn: Math.sign,
};
const CONSTS = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), 'x'].sort((a, b) => b.length - a.length);

function normalise(src) {
  let s = String(src ?? '').trim();
  s = s.replace(/^\s*(y|f\s*\(\s*x\s*\)|g\s*\(\s*x\s*\))\s*=\s*/i, '');
  s = s.replace(/[−–]/g, '-').replace(/[×·∙]/g, '*').replace(/÷/g, '/').replace(/π/g, 'pi').replace(/√/g, 'sqrt');
  s = s.replace(/\*\*/g, '^').replace(/²/g, '^2').replace(/³/g, '^3');
  // LaTeX leftovers a model might send.
  s = s.replace(/\\left|\\right/g, '').replace(/\\cdot|\\times/g, '*').replace(/\\pi/g, 'pi');
  for (let k = 0; k < 3; k++) s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
  s = s.replace(/\\(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|ln|log|exp)/g, '$1');
  s = s.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\[/g, '(').replace(/\]/g, ')');
  return s;
}

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new Error(`can't read the number near "${s.slice(i, i + 6)}"`);
      toks.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    const logBase = /^log(10|2)(?=\s*\()/i.exec(s.slice(i));
    if (logBase) {
      toks.push({ t: 'fn', v: 'log' + logBase[1] });
      i += logBase[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const word = /^[a-zA-Z]+/.exec(s.slice(i))[0];
      i += word.length;
      toks.push(...splitWord(word));
      continue;
    }
    if ('+-*/^(),|!'.includes(c)) {
      toks.push({ t: c });
      i++;
      continue;
    }
    throw new Error(`unexpected "${c}"`);
  }
  return toks;
}

function splitWord(word) {
  const lower = word.toLowerCase();
  const out = [];
  let i = 0;
  while (i < lower.length) {
    const name = NAMES.find((n) => lower.startsWith(n, i));
    if (!name) throw new Error(`unknown name "${word}" (use x as the variable)`);
    if (name === 'x') out.push({ t: 'var' });
    else if (name in CONSTS) out.push({ t: 'num', v: CONSTS[name] });
    else out.push({ t: 'fn', v: name });
    i += name.length;
  }
  return out;
}

function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

/** Compile an expression in x into a function. Throws a readable Error on bad input. */
export function compile(source) {
  const toks = tokenize(normalise(source));
  if (!toks.length) throw new Error('the expression is empty');
  let i = 0;
  let absDepth = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (t) => {
    const tk = next();
    if (!tk || tk.t !== t) throw new Error(`expected "${t}"`);
  };
  const startsPrimary = (tk) =>
    tk && (tk.t === 'num' || tk.t === 'var' || tk.t === 'fn' || tk.t === '(' || (tk.t === '|' && absDepth === 0));

  function expr() {
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = next().t;
      const a = node;
      const b = term();
      node = op === '+' ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return node;
  }
  function term() {
    let node = unary();
    for (;;) {
      const tk = peek();
      if (tk && (tk.t === '*' || tk.t === '/')) {
        next();
        const a = node;
        const b = unary();
        node = tk.t === '*' ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
      } else if (startsPrimary(tk)) {
        const a = node;
        const b = power();
        node = (x) => a(x) * b(x);
      } else break;
    }
    return node;
  }
  function unary() {
    const tk = peek();
    if (tk && tk.t === '-') {
      next();
      const a = unary();
      return (x) => -a(x);
    }
    if (tk && tk.t === '+') {
      next();
      return unary();
    }
    return power();
  }
  function power() {
    const base = postfix();
    if (peek() && peek().t === '^') {
      next();
      const ex = unary();
      return (x) => Math.pow(base(x), ex(x));
    }
    return base;
  }
  function postfix() {
    let node = primary();
    while (peek() && peek().t === '!') {
      next();
      const a = node;
      node = (x) => factorial(a(x));
    }
    return node;
  }
  function primary() {
    const tk = next();
    if (!tk) throw new Error('the expression ends too early');
    if (tk.t === 'num') {
      const v = tk.v;
      return () => v;
    }
    if (tk.t === 'var') return (x) => x;
    if (tk.t === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    if (tk.t === '|') {
      absDepth++;
      const e = expr();
      expect('|');
      absDepth--;
      return (x) => Math.abs(e(x));
    }
    if (tk.t === 'fn') {
      const f = FUNCS[tk.v];
      let pow = null;
      if (peek() && peek().t === '^') {
        next();
        pow = unary();
      }
      let arg;
      if (peek() && peek().t === '(') {
        next();
        arg = expr();
        expect(')');
      } else {
        arg = power();
      }
      const g = (x) => f(arg(x));
      return pow ? (x) => Math.pow(g(x), pow(x)) : g;
    }
    throw new Error(`unexpected "${tk.t}"`);
  }

  const fn = expr();
  if (i < toks.length) throw new Error(`didn't understand the part starting at "${toks[i].t === 'num' ? toks[i].v : toks[i].t}"`);
  return fn;
}

function niceStep(range, target = 6) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function fmtTick(v, step) {
  if (Math.abs(v) < step / 1e6) return '0';
  // Steps are 1, 2 or 5 × 10^k, so the step's own power of ten gives the decimals needed.
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(6, decimals)).replace('-', '−');
}

const toNum = (v, fallback) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
};

const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const PLOT_COLOURS = ['#f2d479', '#9fcbef', '#f0a6b8', '#a8dba0', '#e8b98c', '#c9b5f0'];

/**
 * Draw functions of x as an SVG string.
 * spec: { functions: [{expr, label}], x_min, x_max, y_min, y_max, points: [{x, y, label}] }
 */
export function plotSVG(spec = {}) {
  const errors = [];
  let fns = spec.functions;
  if (!Array.isArray(fns)) fns = fns ? [fns] : [];
  fns = fns
    .map((f) => (typeof f === 'string' ? { expr: f } : f))
    .filter((f) => f && typeof f.expr === 'string' && f.expr.trim())
    .slice(0, 6);
  const curves = [];
  fns.forEach((f, k) => {
    try {
      curves.push({ expr: f.expr, label: f.label, fn: compile(f.expr), colour: PLOT_COLOURS[k % PLOT_COLOURS.length] });
    } catch (err) {
      errors.push(`"${f.expr}": ${err.message}`);
    }
  });
  const points = (Array.isArray(spec.points) ? spec.points : [])
    .map((p) => ({ x: toNum(p?.x, NaN), y: toNum(p?.y, NaN), label: p?.label }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .slice(0, 20);

  let x0 = toNum(spec.x_min, -5);
  let x1 = toNum(spec.x_max, 5);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (x1 - x0 < 1e-9) {
    x0 -= 5;
    x1 += 5;
  }

  const N = 480;
  const samples = curves.map((c) => {
    const ys = new Float64Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const x = x0 + ((x1 - x0) * k) / N;
      let y;
      try {
        y = c.fn(x);
      } catch {
        y = NaN;
      }
      ys[k] = Number.isFinite(y) ? y : NaN;
    }
    return ys;
  });

  let y0 = toNum(spec.y_min, NaN);
  let y1 = toNum(spec.y_max, NaN);
  if (!(Number.isFinite(y0) && Number.isFinite(y1) && y1 > y0)) {
    const vals = [];
    for (const ys of samples) for (const y of ys) if (Number.isFinite(y) && Math.abs(y) < 1e7) vals.push(y);
    for (const p of points) vals.push(p.y);
    vals.sort((a, b) => a - b);
    if (vals.length) {
      const lo = vals[Math.floor(vals.length * 0.02)];
      const hi = vals[Math.min(vals.length - 1, Math.ceil(vals.length * 0.98))];
      const pad = Math.max((hi - lo) * 0.12, 0.5);
      y0 = Math.min(lo - pad, ...points.map((p) => p.y - pad * 0.5));
      y1 = Math.max(hi + pad, ...points.map((p) => p.y + pad * 0.5));
      if (y1 - y0 < 1e-6) {
        y0 -= 1;
        y1 += 1;
      }
    } else {
      y0 = -5;
      y1 = 5;
    }
  }

  const W = 640;
  const H = 400;
  const L = 50;
  const R = 18;
  const T = 16;
  const B = 32;
  const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y) => T + ((y1 - y) / (y1 - y0)) * (H - T - B);
  const out = [];
  out.push(`<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(spec.title || 'Graph')}">`);
  const clipId = 'clip' + Math.random().toString(36).slice(2, 8);
  out.push(`<defs><clipPath id="${clipId}"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs>`);

  const xs = niceStep(x1 - x0);
  const ys = niceStep(y1 - y0, 5);
  for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + xs * 1e-9; v += xs) {
    const px = sx(v).toFixed(1);
    out.push(`<line class="pl-grid" x1="${px}" y1="${T}" x2="${px}" y2="${H - B}"/>`);
    out.push(`<text class="pl-tick" x="${px}" y="${H - B + 20}" text-anchor="middle">${fmtTick(v, xs)}</text>`);
  }
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + ys * 1e-9; v += ys) {
    const py = sy(v).toFixed(1);
    out.push(`<line class="pl-grid" x1="${L}" y1="${py}" x2="${W - R}" y2="${py}"/>`);
    out.push(`<text class="pl-tick" x="${L - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${fmtTick(v, ys)}</text>`);
  }
  const axX = y0 <= 0 && y1 >= 0 ? sy(0) : H - B;
  const axY = x0 <= 0 && x1 >= 0 ? sx(0) : L;
  out.push(`<line class="pl-axis" x1="${L}" y1="${axX.toFixed(1)}" x2="${W - R}" y2="${axX.toFixed(1)}"/>`);
  out.push(`<line class="pl-axis" x1="${axY.toFixed(1)}" y1="${T}" x2="${axY.toFixed(1)}" y2="${H - B}"/>`);
  out.push(`<text class="pl-name" x="${W - R - 4}" y="${(axX - 8).toFixed(1)}" text-anchor="end">x</text>`);
  out.push(`<text class="pl-name" x="${(axY + 8).toFixed(1)}" y="${T + 14}">y</text>`);

  const span = y1 - y0;
  curves.forEach((c, k) => {
    const yv = samples[k];
    let d = '';
    let pen = false;
    for (let j = 0; j <= N; j++) {
      const y = yv[j];
      const x = x0 + ((x1 - x0) * j) / N;
      if (!Number.isFinite(y)) {
        pen = false;
        continue;
      }
      // Break the line across asymptotes instead of drawing a vertical spike.
      if (pen && j > 0 && Number.isFinite(yv[j - 1]) && Math.abs(y - yv[j - 1]) > span * 1.5) pen = false;
      const py = Math.max(-1e4, Math.min(1e4, sy(y)));
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)} ${py.toFixed(1)}`;
      pen = true;
    }
    if (d) out.push(`<path class="pl-curve" clip-path="url(#${clipId})" d="${d}" stroke="${c.colour}"/>`);
  });
  for (const p of points) {
    const px = sx(p.x);
    const py = sy(p.y);
    if (px < L - 1 || px > W - R + 1 || py < T - 1 || py > H - B + 1) continue;
    out.push(`<circle class="pl-point" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5"/>`);
    if (p.label) {
      const anchor = px > W - 140 ? 'end' : 'start';
      const dx = anchor === 'end' ? -9 : 9;
      out.push(`<text class="pl-label" x="${(px + dx).toFixed(1)}" y="${(py - 9).toFixed(1)}" text-anchor="${anchor}">${escapeXml(String(p.label).slice(0, 40))}</text>`);
    }
  }
  out.push('</svg>');
  return {
    svg: out.join(''),
    errors,
    legend: curves.map((c) => ({ colour: c.colour, label: c.label || `y = ${c.expr.replace(/^\s*y\s*=\s*/i, '')}` })),
  };
}
