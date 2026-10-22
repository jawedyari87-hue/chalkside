// Development only: a fake Gemini Live server, loaded when the URL has ?mock.
// It answers setup, streams a short tone as "speech", sends captions and calls
// the board tools, so the whole app can be exercised without an API key.
// window.__mock exposes what the app sent and a few levers (goAway, drop, reject).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

// Loud and high enough to hear through tablet speakers.
function toneBase64(seconds, freq = 523) {
  const rate = 24000;
  const n = Math.round(seconds * rate);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 600, (n - i) / 600);
    pcm[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 7000 * env);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function installMock() {
  const RealWS = window.WebSocket;
  const mock = {
    sockets: [],
    setups: [],
    frames: [],
    texts: [],
    audioIn: 0,
    audioEnds: 0,
    toolResponses: [],
    handles: 0,
    rejectOnce: null, // e.g. 'behavior': the next setup is refused naming that field
    active: null,
    urls: [],
    mints: 0,
    // Sign-in behaviour: 'ok', 'reject' (closed 1008 after setup) or 'handshake' (refused with no reason).
    keyAuth: 'ok',
    tokenAuth: 'ok',
    tokenMint: 'ok', // 'ok', 'fail' (HTTP 403) or 'network' (fetch throws, like a CORS block)
    // The slower model behind think_deeply: 'ok', 'busy' (503), 'quota' (429), 'silent' (sends
    // nothing for 40 s, like a queued request) or 'empty'; or per model, e.g. { 'gemini-3.8-flash': 'busy', '*': 'ok' }.
    thinker: 'ok',
    thinkMs: 3000,
    thinks: [], // what the app asked it: { model, body }
    goAway() {
      this.active?._server({ goAway: { timeLeft: '5s' } });
    },
    drop(code = 1011, reason = 'Internal error') {
      this.active?.close(code, reason);
    },
    say(text) {
      return this.active?._say(text);
    },
    call(name, args) {
      this.active?._server({ toolCall: { functionCalls: [{ id: 'm' + Math.random().toString(36).slice(2, 7), name, args }] } });
    },
  };
  window.__mock = mock;

  class FakeLiveSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      mock.sockets.push(this);
      mock.urls.push(url.replace(/(key|access_token)=[^&]+/, '$1=…'));
      this.viaToken = /\.BidiGenerateContentConstrained\?access_token=/.test(url);
      const auth = this.viaToken ? mock.tokenAuth : mock.keyAuth;
      if (auth === 'handshake') {
        // How a browser reports an HTTP 401 during the WebSocket upgrade: error, then close 1006 with no reason.
        setTimeout(() => {
          this.readyState = 3;
          this.onerror?.(new Event('error'));
          this.onclose?.(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
        }, 30);
        return;
      }
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      }, 30);
    }

    send(data) {
      const msg = JSON.parse(data);
      if (msg.setup) return this._setup(msg.setup);
      if (msg.realtimeInput) {
        const r = msg.realtimeInput;
        if (r.audio) mock.audioIn++;
        if (r.audioStreamEnd) mock.audioEnds++;
        if (r.video) mock.frames.push({ ...r.video, t: Date.now() });
        if (r.text) {
          mock.texts.push(r.text);
          this._reply(r.text);
        }
      }
      if (msg.toolResponse) {
        mock.toolResponses.push(msg.toolResponse);
        // Careful working comes back WHEN_IDLE, and the tutor talks about it.
        const fr = msg.toolResponse.functionResponses?.find((r) => r.name === 'think_deeply');
        if (fr && fr.scheduling !== 'SILENT') this._afterThinking(fr.response);
      }
    }

    async _afterThinking(r) {
      await sleep(200);
      await this._say(r?.ok ? "It's on the board now. The trick is to divide by n, which turns it into a simple sum. " : "I couldn't get the careful working, so let's do it together. ");
      this._done();
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      if (mock.active === this) mock.active = null;
      setTimeout(() => this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 })), 10);
    }

    _server(obj) {
      if (this.readyState !== 1) return;
      const bytes = enc.encode(JSON.stringify(obj));
      const data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
      this.onmessage?.(new MessageEvent('message', { data }));
    }

    _setup(setup) {
      mock.setups.push(setup);
      if ((this.viaToken ? mock.tokenAuth : mock.keyAuth) === 'reject') {
        setTimeout(
          () =>
            this.close(
              1008,
              'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. ACCESS_TOKEN_TYPE_UNSUPPORTED',
            ),
          20,
        );
        return;
      }
      if (mock.rejectOnce) {
        const field = mock.rejectOnce;
        mock.rejectOnce = null;
        setTimeout(() => this.close(1007, `Invalid JSON payload received. Unknown name "${field}" at 'setup': Cannot find field.`), 20);
        return;
      }
      if (!/^models\/gemini/.test(setup.model || '')) {
        setTimeout(() => this.close(1008, `${setup.model} is not found for API version v1beta, or is not supported for bidiGenerateContent.`), 20);
        return;
      }
      mock.active = this;
      setTimeout(() => {
        this._server({ setupComplete: {} });
        this._server({ sessionResumptionUpdate: { newHandle: 'handle-' + ++mock.handles, resumable: true } });
      }, 60);
    }

    async _say(text, seconds = 0.5) {
      this._server({ serverContent: { outputTranscription: { text } } });
      this._server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: toneBase64(seconds) } }] } } });
      await sleep(120);
    }

    _tool(name, args) {
      this._server({ toolCall: { functionCalls: [{ id: 'fc' + Math.random().toString(36).slice(2, 7), name, args }] } });
    }

    _done() {
      this._server({ serverContent: { generationComplete: true } });
      this._server({ serverContent: { turnComplete: true } });
    }

    async _reply(text) {
      await sleep(250);
      if (/stay completely silent/.test(text)) {
        this._done();
        return;
      }
      if (/^\[.*think_deeply/.test(text)) {
        // The answer arrived after a reconnect, so the app said it in words.
        await this._afterThinking({ ok: !/couldn't finish/.test(text) });
        return;
      }
      if (/prove|properly|think (it )?through|recurrence/i.test(text)) {
        await this._say('Let me work that through properly. ');
        this._tool('think_deeply', { question: 'Q4 on the problem sheet: why case 2 of the master theorem fails for T(n) = 2T(n/2) + n log n, and a tight bound with proof.', goal: 'solve', title: 'Q4(b)' });
        await this._say('While that works, what have you tried so far? ');
        this._done();
        return;
      }
      if (/lesson has started/i.test(text) && !/\]\s*\S/.test(text)) {
        await this._say("Hi! I can see your page. What shall we work on today? ");
        this._done();
        return;
      }
      if (/check my working/i.test(text)) {
        await this._say('Let me have a look at your working. ');
        this._tool('mark_student_work', {
          marks: [
            { box_2d: [80, 60, 300, 640], verdict: 'correct', label: 'good start' },
            { box_2d: [420, 60, 640, 760], verdict: 'mistake', label: 'sign error: $-2x$' },
          ],
        });
        await this._say('Your first line is right, but look at the sign in the second line. ');
        this._tool('write_on_board', {
          kind: 'warning',
          title: 'Careful with signs',
          content: 'When you expand $-(x - 2)^2$ the brackets come first:\n$$-(x^2 - 4x + 4) = -x^2 + 4x - 4$$',
        });
        this._done();
        return;
      }
      if (/diagram|automat|tree/i.test(text) && !/picture/i.test(text)) {
        await this._say("I've drawn it on the board. ");
        this._tool('draw_diagram', {
          title: 'A binary search tree',
          code: 'graph TD\n  A((8)) --> B((3))\n  A --> C((10))\n  B --> D((1))\n  B --> E((6))\n  C --> F((14))',
        });
        this._done();
        return;
      }
      if (/code|function|bug/i.test(text)) {
        await this._say("The fix is on the board: look at the second line. ");
        this._tool('write_on_board', {
          kind: 'step',
          title: 'Guard the empty list',
          content: 'Check for an empty list before dividing:\n```python\ndef mean(xs):\n    if not xs:\n        return 0\n    return sum(xs) / len(xs)\n```\nThat makes it $O(n)$, and `mean([])` returns `0`.',
        });
        this._done();
        return;
      }
      if (/picture/i.test(text)) {
        await this._say("Here's a picture of one from Wikipedia. ");
        this._tool('show_picture', { query: /tree/i.test(text) ? 'Binary search tree' : 'Unit circle', caption: 'From Wikipedia' });
        this._done();
        return;
      }
      if (/look (it )?up|search/i.test(text)) {
        // What a grounded answer carries: the pages Google Search used, and its suggestion chips.
        this._server({
          serverContent: {
            groundingMetadata: {
              webSearchQueries: ['eigenvalues definition'],
              groundingChunks: [
                { web: { uri: 'https://en.wikipedia.org/wiki/Eigenvalues_and_eigenvectors', title: 'wikipedia.org' } },
                { web: { uri: 'https://www.mathsisfun.com/algebra/eigenvalue.html', title: 'mathsisfun.com' } },
              ],
              searchEntryPoint: {
                renderedContent:
                  '<style>.chip{display:inline-block;padding:6px 12px;border:1px solid #ddd;border-radius:16px;font:14px sans-serif;color:#1a0dab;text-decoration:none}</style><a class="chip" href="https://www.google.com/search?q=eigenvalues+definition">eigenvalues definition</a>',
              },
            },
          },
        });
        await this._say('I looked it up: an eigenvalue is how much the eigenvector is stretched. ');
        this._done();
        return;
      }
      // Anything else: a short worked explanation that exercises every board feature.
      await this._say("Sure. Let's do it on the board, one step at a time. ");
      this._tool('new_board_page', { title: 'Integration by parts' });
      this._tool('write_on_board', {
        kind: 'definition',
        title: 'Integration by parts',
        // The second "\frac" is deliberately unescaped, so it arrives as a form feed + "rac", like a bad JSON escape.
        content: '$$\\int u\\,\\frac{dv}{dx}\\,dx = uv - \\int v\\,\frac{du}{dx}\\,dx$$',
      });
      await this._say('First pick u and dv. ');
      this._tool('write_on_board', { kind: 'step', content: 'Let $u = x$ and $\\dfrac{dv}{dx} = e^{x}$, so $\\dfrac{du}{dx} = 1$ and $v = e^{x}$.' });
      this._tool('write_on_board', {
        kind: 'step',
        content: '$$\\begin{aligned} \\int x e^{x}\\,dx &= x e^{x} - \\int e^{x}\\,dx \\\\ &= x e^{x} - e^{x} + C \\end{aligned}$$',
      });
      this._tool('write_on_board', { kind: 'answer', content: '$$\\int x e^{x}\\,dx = e^{x}(x - 1) + C$$' });
      this._tool('plot_graph', {
        functions: [{ expr: 'x*e^x', label: '$y = xe^x$' }, { expr: 'e^x(x-1)', label: '$y = e^x(x-1)$' }],
        x_min: -4,
        x_max: 2,
        points: [{ x: 0, y: -1, label: '(0, −1)' }],
        title: 'The integrand and its antiderivative',
      });
      this._tool('write_on_board', {
        kind: 'example',
        title: 'Truth table',
        content: '| $p$ | $q$ | $p \\Rightarrow q$ |\n|---|---|---|\n| T | T | T |\n| T | F | F |\n| F | T | T |\n| F | F | T |',
      });
      this._tool('write_on_board', { kind: 'your_turn', content: 'Now try $\\displaystyle\\int x\\cos x\\,dx$ on your page.' });
      this._tool('write_on_board', { kind: 'hint', content: 'Choose $u$ to be the part that gets **simpler** when you differentiate it.' });
      this._tool('write_on_board', { kind: 'note', content: 'A broken formula for testing: $\\frac{1}{$' });
      await this._say('Have a go at the one on the yellow note. ', 0.6);
      this._done();
    }
  }

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      if (/generativelanguage\.googleapis\.com/.test(url)) return new FakeLiveSocket(url);
      return new RealWS(url, protocols);
    }
  }
  window.WebSocket = MockWebSocket;

  // The token endpoint, for the short-lived sign-in route.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/generativelanguage\.googleapis\.com\/v1beta\/auth_tokens/.test(url)) {
      mock.mints++;
      mock.mintSentKeyHeader = !!init?.headers?.['x-goog-api-key'];
      await sleep(40);
      if (mock.tokenMint === 'network') throw new TypeError('Failed to fetch');
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (mock.tokenMint === 'fail') return json(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } });
      return json(200, { name: `auth_tokens/mock-${mock.mints}`, uses: 1 });
    }
    const think = /generativelanguage\.googleapis\.com\/v1beta\/models\/([^:/]+):streamGenerateContent/.exec(url);
    if (think) return fakeThinker(decodeURIComponent(think[1]), init);
    return realFetch(input, init);
  };

  // The slower model (think_deeply), streaming thought headings and then its answer, as Google
  // sends them: "data: {...}" lines, split at awkward places.
  async function fakeThinker(model, init) {
    mock.thinks.push({ model, body: JSON.parse(init?.body || '{}') });
    const plan = typeof mock.thinker === 'object' ? (mock.thinker[model] ?? mock.thinker['*'] ?? 'ok') : mock.thinker;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    await sleep(80);
    if (plan === 'busy') return json(503, { error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } });
    if (plan === 'quota')
      return json(429, {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
        },
      });
    const sse = (parts) => `data: ${JSON.stringify({ candidates: [{ content: { parts, role: 'model' } }] })}\r\n\r\n`;
    const answer = [
      '**(a)** Here $a = b = 2$, so $n^{\\log_b a} = n$. Case 2 needs $f(n) = \\Theta(n)$, but $\\frac{n \\log_2 n}{n} = \\log_2 n \\to \\infty$.\n\n',
      '**(b)**\n1. Divide by $n$:\n$$\\frac{T(n)}{n} = \\frac{T(n/2)}{n/2} + \\log_2 n$$\n2. With $n = 2^k$ and $S(k) = T(2^k)/2^k$: $S(k) = S(k-1) + k$, $S(0) = 1$.\n',
      '3. So $S(k) = 1 + \\frac{k(k+1)}{2}$, and\n$$T(n) = n + \\tfrac{1}{2} n \\log_2 n \\,(\\log_2 n + 1)$$\n\n$$\\boxed{T(n) = \\Theta(n \\log^2 n)}$$\n\n',
      'TUTOR: Dividing by n turns the recurrence into an arithmetic series, which is where the second log comes from.',
    ].join('');
    const step = mock.thinkMs / 4;
    const stream = new ReadableStream({
      async start(c) {
        init?.signal?.addEventListener('abort', () => c.error(new DOMException('The user aborted a request.', 'AbortError')), { once: true });
        const put = (s) => !init?.signal?.aborted && c.enqueue(enc.encode(s));
        if (plan === 'silent') await sleep(40000);
        for (const h of ['Analysing the recurrence', 'Checking the master theorem', 'Proving the bound']) {
          await sleep(step);
          put(sse([{ text: `**${h}**\n\nI'm working through ${h.toLowerCase()}.`, thought: true }]));
        }
        await sleep(step);
        if (plan === 'empty') {
          put(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\r\n\r\n`);
        } else {
          const body = sse([{ text: answer }]);
          const cut = Math.floor(body.length / 2); // a line split across two reads
          put(body.slice(0, cut));
          await sleep(30);
          put(body.slice(cut));
        }
        if (!init?.signal?.aborted) c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  // A quiet synthetic microphone, so the capture pipeline runs without a real one.
  // ?mock&realmic keeps the real microphone, to test audio routing on a device without using Gemini.
  if (navigator.mediaDevices && !new URLSearchParams(location.search).has('realmic')) {
    const real = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints?.audio) return real(constraints);
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.004;
      osc.frequency.value = 180;
      osc.connect(gain);
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      osc.start();
      ctx.resume().catch(() => {});
      mock.micCtx = ctx;
      return dest.stream;
    };
  }
  console.info('[mock] Fake Gemini Live installed');
}
