// Careful thinking for the live tutor, from an ordinary (not live) Gemini model.
//
// The live model answers fast but can slip on anything subtle, and Google's live thinking model
// can't write on the board (every tool call it makes fails). So the live tutor hands hard problems
// to a Flash model with its thinking turned up, through the think_deeply tool, and the answer goes
// on the board. This asks for it and reads the answer as it streams in. It runs on the key's normal
// Gemini allowance, which is separate from the live one.

import { dailyReset } from './live.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Newest first. All of them read code and maths off a screenshot well (tested October 2026);
// what differs is how busy Google is: on a free key, any of them can be turned away or queued.
export const THINKING_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];

const HEDGE_MS = 30000; // nothing back from a model by then: it's probably queued, so ask the next one too
const LIMIT_MS = 150000;

export class ThinkError extends Error {
  constructor(message, { retry = false, busy = false, quota = false, reason = '' } = {}) {
    super(message);
    Object.assign(this, { retry, busy, quota, reason });
  }
}

// "gemini-3.7-flash" → "Gemini 3.7 Flash"
export function modelLabel(model) {
  return String(model)
    .replace(/^gemini-/i, 'Gemini ')
    .replace(/-/g, ' ')
    .replace(/\b(flash|pro|lite|preview|latest)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
}

// What went wrong, and whether another model might do better.
function failure(model, status, body) {
  const e = body?.error || {};
  const ids = (e.details || []).flatMap((d) => d.violations || []).map((v) => v.quotaId).filter(Boolean);
  const reason = `${e.message || `HTTP ${status}`}${ids.length ? ` [${ids.join(', ')}]` : ''}`;
  const name = modelLabel(model);
  if (status === 503 || status === 500 || status === 504 || e.status === 'UNAVAILABLE') return new ThinkError(`${name} is too busy`, { retry: true, busy: true, reason });
  if (status === 429 || e.status === 'RESOURCE_EXHAUSTED') return new ThinkError(`this key has used up its allowance for ${name} for now`, { retry: true, quota: true, reason });
  if (status === 404) return new ThinkError(`${name} isn't available to this key`, { retry: true, reason });
  if (/API key not valid|API_KEY_INVALID|API key expired/i.test(reason)) return new ThinkError('Google rejected the API key', { reason });
  if (status === 401 || status === 403) return new ThinkError(`Google refused this key for ${name}`, { reason });
  return new ThinkError(`${name} failed: ${reason}`, { retry: status >= 500, reason });
}

// The heading of one of the model's thought summaries ("**Tracing the merge**…").
function heading(text = '') {
  const bold = /\*\*([^*\n]{3,80})\*\*/.exec(text);
  const line = (bold ? bold[1] : text.trim().split('\n')[0]).trim();
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

// plain: without a thinking level, for a model (typed in Settings) that won't take one.
function request(model, { system, text, image }, plain) {
  const parts = [{ text }];
  if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
  let thinkingConfig = { thinkingLevel: 'HIGH', includeThoughts: true };
  if (/^gemini-2\./.test(model)) thinkingConfig = { thinkingBudget: -1, includeThoughts: true };
  if (plain) thinkingConfig = { includeThoughts: true };
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { thinkingConfig },
  };
}

// One model, streamed: thought headings as they come, then the answer.
async function ask(model, apiKey, question, signal, hooks, plain = false) {
  const { onStart, onThought } = hooks;
  let res;
  try {
    res = await fetch(`${API}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(request(model, question, plain)),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ThinkError("couldn't reach Google", { retry: false, reason: String(err?.message || err) });
  }
  if (!res.ok) {
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 400 && !plain && /thinking/i.test(body?.error?.message || '')) return ask(model, apiKey, question, signal, hooks, true);
    throw failure(model, res.status, body);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let msg;
      try {
        msg = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (msg.error) throw failure(model, msg.error.code || 500, msg);
      onStart();
      const cand = msg.candidates?.[0];
      for (const p of cand?.content?.parts || []) {
        if (p.thought) {
          const h = heading(p.text);
          if (h) onThought(h);
        } else if (typeof p.text === 'string') text += p.text;
      }
      if (cand?.finishReason) finish = cand.finishReason;
    }
  }
  if (!text.trim()) throw new ThinkError(finish === 'SAFETY' ? 'Google blocked the answer' : `${modelLabel(model)} gave no answer`, { retry: true, reason: finish });
  return text;
}

function summarise(errors) {
  if (!errors.length) return new ThinkError('no thinking model answered');
  const fatal = errors.find((e) => !e.retry);
  if (fatal) return fatal;
  if (errors.length === 1) return errors[0];
  if (errors.every((e) => e.busy)) return new ThinkError("Google's thinking models are all too busy right now", { busy: true });
  const quota = errors.filter((e) => e.quota);
  if (quota.length === errors.length) {
    const daily = quota.every((e) => /PerDay/i.test(e.reason));
    return new ThinkError(`this key has used up its allowance for the thinking models ${daily ? `for today (it resets at ${dailyReset()})` : 'for now'}`, { quota: true, reason: quota[0].reason });
  }
  if (quota.length && errors.every((e) => e.quota || e.busy)) return new ThinkError('this key has used up its allowance for some thinking models, and the others are too busy', { quota: true, reason: quota[0].reason });
  return errors.at(-1);
}

/**
 * Ask the first model; when it's busy, out of allowance or unavailable, the next. If one has sent
 * nothing after HEDGE_MS (queued behind other people's requests), the next is asked as well, and
 * the first answer wins. Resolves to { text, model }.
 * question: { system, text, image } (image: base64 JPEG). onThought(heading, model) shows progress.
 */
export function thinkDeeply({ apiKey, models, question, signal, onThought = () => {} }) {
  return new Promise((resolve, reject) => {
    const runs = new Set();
    const errors = [];
    const timers = [];
    let next = 0;
    let settled = false;
    const settle = (ok, value) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      for (const r of runs) r.ctl.abort();
      if (ok) resolve(value);
      else reject(value);
    };
    const launch = () => {
      if (settled) return;
      if (next >= models.length) {
        if (!runs.size) settle(false, summarise(errors));
        return;
      }
      const model = models[next++];
      const run = { ctl: new AbortController(), heard: false };
      runs.add(run);
      timers.push(setTimeout(() => runs.has(run) && !run.heard && launch(), HEDGE_MS));
      ask(model, apiKey, question, run.ctl.signal, {
        onStart: () => (run.heard = true),
        onThought: (h) => !settled && onThought(h, model),
      }).then(
        (text) => settle(true, { text, model }),
        (err) => {
          runs.delete(run);
          if (settled) return;
          errors.push(err);
          if (err.retry) launch();
          else if (!runs.size) settle(false, err);
        },
      );
    };
    timers.push(setTimeout(() => settle(false, new ThinkError('it took too long, because Google is busy')), LIMIT_MS));
    if (signal?.aborted) return settle(false, new ThinkError('stopped'));
    signal?.addEventListener('abort', () => settle(false, new ThinkError('stopped')), { once: true });
    launch();
  });
}

// The answer is the board text, then a line starting "TUTOR:" and notes only the voice tutor sees.
export function splitAnswer(text) {
  const marks = [...String(text).matchAll(/^[ \t>*_]*TUTOR[*_ \t]*:[*_]*/gm)];
  const at = marks.at(-1);
  let board = at ? text.slice(0, at.index) : String(text);
  const tutor = at ? text.slice(at.index + at[0].length).trim() : '';
  board = board
    .replace(/^\s*\**BOARD\**\s*:\**\s*\n/, '') // in case it labels the board part too
    .replace(/\n\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '') // a rule left before the notes
    .trim();
  return { board, tutor };
}
