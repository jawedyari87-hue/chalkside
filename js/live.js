// Gemini Live API over a raw WebSocket, with session resumption so a lesson can
// outlast Google's ~10 minute connection limit.

import { sleep } from './util.js';

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService';
const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';

// Swap the API key for a single-use, short-lived token (Google's recommended way
// for apps running in a browser). New AI Studio keys ("AQ." auth keys) may only
// work with the live voice API this way.
export async function mintToken(apiKey) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ uses: 1 }),
    });
  } catch {
    throw Object.assign(new Error('Could not ask Google for a sign-in token.'), { reason: '', network: true });
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok || typeof body.name !== 'string') {
    const reason = body?.error?.message || `sign-in token request failed (HTTP ${res.status})`;
    throw Object.assign(new Error(reason), { reason, status: res.status });
  }
  return body.name;
}

// Did Google refuse who we are, rather than what we asked for?
export function isAuthFailure(err) {
  if (!err) return false;
  if (err.network || err.status === 401 || err.status === 403 || err.code === 1008) return true;
  if (err.code === 1006 && !err.reason) return true; // a refused handshake looks like this in browsers
  return /API key|API_KEY|ACCESS_TOKEN|access token|credential|authenticat|unauthori[sz]ed|auth.?token/i.test(err.reason || '');
}

// Fields we can drop if a model or API version rejects them.
const OPTIONAL_FIELDS = [
  'mediaResolution', 'thinkingConfig', 'behavior', 'scheduling', 'realtimeInputConfig',
  'contextWindowCompression', 'inputAudioTranscription', 'outputAudioTranscription', 'speechConfig',
  'languageCodes',
];

const decoder = new TextDecoder();

function camel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Work out which field the server objected to, from its close reason.
export function rejectedField(reason) {
  if (!reason) return null;
  const unknown = /Unknown name "([A-Za-z_]+)"/.exec(reason);
  if (unknown) return camel(unknown[1]);
  const at = /Invalid value at '([^']+)'/.exec(reason);
  if (at) {
    const parts = at[1].split('.').map((p) => camel(p.replace(/\[\d+\]/g, '')));
    for (let i = parts.length - 1; i >= 0; i--) if (OPTIONAL_FIELDS.includes(parts[i])) return parts[i];
  }
  for (const f of OPTIONAL_FIELDS) {
    const snake = f.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    if (reason.includes(f) || reason.includes(snake)) return f;
  }
  if (/thinking/i.test(reason)) return 'thinkingConfig';
  return null;
}

export function stripFields(obj, fields) {
  if (!fields.size) return obj;
  if (Array.isArray(obj)) return obj.map((v) => stripFields(v, fields));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (!fields.has(k)) out[k] = stripFields(v, fields);
    return out;
  }
  return obj;
}

// Problems that retrying will not fix.
export function isFatal(reason = '') {
  return /API key|API_KEY|PERMISSION_DENIED|permission|billing|quota|RESOURCE_EXHAUSTED|exceeded|not found for API version|not supported for bidiGenerateContent|is not found|location is not supported|not available in your country/i.test(
    reason,
  );
}

const isInvalidArgument = (err) => err?.code === 1007 || /invalid argument|INVALID_ARGUMENT/i.test(err?.reason || '');

// When the server says "invalid argument" without naming a field, drop the
// newest optional settings one at a time, most likely culprit first.
const BLIND_STRIP_ORDER = ['languageCodes', 'mediaResolution', 'thinkingConfig', 'behavior', 'realtimeInputConfig', 'contextWindowCompression', 'outputAudioTranscription', 'inputAudioTranscription'];

function hasField(obj, field) {
  if (Array.isArray(obj)) return obj.some((v) => hasField(v, field));
  if (obj && typeof obj === 'object') return Object.keys(obj).some((k) => k === field || hasField(obj[k], field));
  return false;
}

export function friendlyError(reason = '', code = 0) {
  if (/API key not valid|API_KEY_INVALID|API key expired/i.test(reason)) return 'Gemini rejected the API key. Check it in Settings.';
  if (/ACCESS_TOKEN_TYPE_UNSUPPORTED|Expected OAuth 2 access token|invalid authentication credentials/i.test(reason))
    return `Google didn't accept this key for live voice, either directly or as a sign-in token. Google said: ${reason}`;
  if (/quota|RESOURCE_EXHAUSTED|exceeded|rate limit/i.test(reason))
    return "You've hit your Gemini usage limit for now. Wait a few minutes, or check the limits in Google AI Studio.";
  if (/location is not supported|not available in your country/i.test(reason)) return "Google doesn't offer this Gemini model where you are.";
  if (/not found|not supported for bidiGenerateContent/i.test(reason)) return 'That model is not available for this API key. Pick another model in Settings.';
  if (/PERMISSION_DENIED|permission|billing/i.test(reason)) return `Google refused access: ${reason}`;
  if (reason) return `Gemini closed the connection: ${reason}`;
  if (code === 1006) return 'Could not reach Gemini. Check your internet connection.';
  return `The connection to Gemini closed (code ${code}).`;
}

// Report the most useful of several failures: a bad key says more than "connection closed".
function bestError(errors) {
  const pick =
    errors.find((e) => /API key not valid|API_KEY_INVALID|API key expired/i.test(e.reason || '')) ||
    errors.find((e) => /quota|RESOURCE_EXHAUSTED/i.test(e.reason || '')) ||
    errors.find((e) => isFatal(e.reason)) ||
    [...errors].reverse().find((e) => e.reason) ||
    errors.at(-1);
  let message;
  if (pick?.timeout) message = 'Gemini took too long to answer. Check your internet connection and try again.';
  else if (pick?.network && !pick.reason) message = 'Could not reach Google. Check your internet connection.';
  else message = friendlyError(pick?.reason, pick?.code);
  return Object.assign(new Error(message), { reason: pick?.reason || '', fatal: true });
}

class LiveConnection {
  constructor(url, setup, owner) {
    this.owner = owner;
    this.setupDone = false;
    this.closed = false;
    this.closeInfo = null;
    this.ready = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.ws.send(JSON.stringify({ setup }));
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data));
      } catch {
        return;
      }
      if (msg.setupComplete !== undefined && !this.setupDone) {
        this.setupDone = true;
        this._resolve();
      }
      owner._onMessage(msg, this);
    };
    this.ws.onclose = (ev) => {
      this.closed = true;
      this.closeInfo = { code: ev.code, reason: ev.reason || '' };
      if (!this.setupDone) {
        this._reject(Object.assign(new Error(ev.reason || `closed (${ev.code})`), { code: ev.code, reason: ev.reason || '' }));
      }
      owner._onClose(this);
    };
    this.ws.onerror = () => {
      /* a close event always follows */
    };
  }

  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close(code = 1000, reason = '') {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }
}

/**
 * Events: 'message' {msg, conn}, 'state' {state}, 'open' {resumed}, 'fail' {message, reason},
 * 'warn' {message}, 'auth' {mode} when a sign-in method works for the first time.
 * States: connecting, live, reconnecting, closed.
 * Sign-in modes: 'key' sends the API key itself; 'token' swaps it for a short-lived token first.
 */
export class LiveSession extends EventTarget {
  constructor({ apiKey, buildSetup, authMode = null }) {
    super();
    this.apiKey = apiKey;
    this.buildSetup = buildSetup;
    this.authMode = authMode;
    this.conn = null;
    this.handle = null;
    this.stripped = new Set();
    this.state = 'idle';
    this.reconnecting = false;
  }

  // Try what worked last time first. Otherwise new "AQ." keys start with a token.
  authOrder() {
    if (this.authMode) return [this.authMode, this.authMode === 'key' ? 'token' : 'key'];
    return /^AQ\./.test(this.apiKey) ? ['token', 'key'] : ['key', 'token'];
  }

  async urlFor(mode) {
    if (mode === 'token') {
      const token = await mintToken(this.apiKey);
      return `${WS_BASE}.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;
    }
    return `${WS_BASE}.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { state });
  }

  async start() {
    this.setState('connecting');
    this.conn = await this.connect();
    this.setState('live');
    this.emit('open', { resumed: false });
  }

  async connect() {
    const errors = [];
    const modes = this.authOrder();
    let m = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.state === 'closed') throw new Error('Session ended');
      const mode = modes[m];
      let url;
      try {
        url = await this.urlFor(mode);
      } catch (err) {
        // The token request failed (blocked, refused, or offline): try the key itself.
        errors.push(err);
        if (m + 1 < modes.length && !/quota|RESOURCE_EXHAUSTED/i.test(err.reason || '')) {
          m++;
          continue;
        }
        break;
      }
      if (this.state === 'closed') throw new Error('Session ended');
      const setup = stripFields(this.buildSetup(), this.stripped);
      setup.sessionResumption = this.handle ? { handle: this.handle } : {};
      const conn = new LiveConnection(url, setup, this);
      try {
        await Promise.race([
          conn.ready,
          sleep(20000).then(() => {
            throw Object.assign(new Error('Gemini took too long to answer.'), { code: 0, reason: '', timeout: true });
          }),
        ]);
        if (this.authMode !== mode) {
          this.authMode = mode;
          this.emit('auth', { mode });
        }
        return conn;
      } catch (err) {
        errors.push(err);
        conn.close();
        let field = rejectedField(err.reason);
        if (!field && isInvalidArgument(err)) field = BLIND_STRIP_ORDER.find((f) => !this.stripped.has(f) && hasField(setup, f)) || null;
        if (field && !this.stripped.has(field)) {
          this.stripped.add(field);
          this.emit('warn', { message: `Gemini didn't accept "${field}", so Chalkside is carrying on without it.` });
          continue;
        }
        if (this.handle && /handle|resum|session/i.test(err.reason || '')) {
          this.handle = null;
          continue;
        }
        // A refused sign-in won't fix itself: try the other method, or stop.
        if (isAuthFailure(err)) {
          if (m + 1 < modes.length) {
            m++;
            continue;
          }
          break;
        }
        if (isFatal(err.reason) || isInvalidArgument(err) || err.timeout) break;
        await sleep(400 * (attempt + 1));
      }
    }
    throw bestError(errors);
  }

  send(obj) {
    return this.conn ? this.conn.send(obj) : false;
  }

  _onMessage(msg, conn) {
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.handle = u.newHandle;
    }
    if (msg.goAway && conn === this.conn) this.reconnect();
    this.emit('message', { msg, conn });
  }

  _onClose(conn) {
    if (conn !== this.conn || !conn.setupDone) return;
    if (this.state === 'closed' || this.state === 'idle') return;
    const reason = conn.closeInfo?.reason || '';
    // A field the server only objects to mid-session (for example in a tool response).
    const field = rejectedField(reason);
    if (field && !this.stripped.has(field)) {
      this.stripped.add(field);
      this.emit('warn', { message: `Gemini didn't accept "${field}", so Chalkside is carrying on without it.` });
    } else if (isFatal(reason)) {
      this.fail(friendlyError(reason, conn.closeInfo?.code), reason);
      return;
    }
    this.reconnect();
  }

  // Open a replacement connection with the resumption handle. The old one keeps
  // working (after goAway) until the new one is ready.
  async reconnect() {
    if (this.reconnecting || this.state === 'closed') return;
    if (!this.handle) {
      const info = this.conn?.closeInfo;
      this.fail(friendlyError(info?.reason, info?.code), info?.reason);
      return;
    }
    this.reconnecting = true;
    this.setState('reconnecting');
    const old = this.conn;
    let err = null;
    for (let i = 0; i < 5 && this.state !== 'closed'; i++) {
      try {
        const conn = await this.connect();
        if (this.state === 'closed') {
          conn.close();
          return;
        }
        this.conn = conn;
        if (old && !old.closed) setTimeout(() => old.close(1000, 'replaced'), 1500);
        this.reconnecting = false;
        this.setState('live');
        this.emit('open', { resumed: true });
        return;
      } catch (e) {
        err = e;
        if (isFatal(e.reason)) break;
        await sleep(800 * 2 ** i);
      }
    }
    this.reconnecting = false;
    if (this.state !== 'closed') this.fail(err?.message || 'Lost the connection to Gemini.', err?.reason);
  }

  fail(message, reason = '') {
    if (this.state === 'closed') return;
    this.setState('closed');
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.emit('fail', { message, reason });
  }

  close() {
    if (this.state === 'closed') return;
    this.setState('closed');
    this.conn?.close(1000, 'lesson ended');
  }
}
