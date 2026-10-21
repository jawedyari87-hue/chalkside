// Diagrams on the board: trees, graphs, automata, flowcharts, sequence and class diagrams.
// The tutor writes them in Mermaid, and the Mermaid library turns that into a picture. It is
// large (3 MB), so it loads the first time a diagram is drawn.

const MERMAID = {
  src: 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js',
  integrity: 'sha512-6a80OTZVmEJhqYJUmYd5z8yHUCDlYnj6q9XwB/gKOEyNQV/Q8u+XeSG59a2ZKFEHGTYzgfOQKYEBtrZV7vBr+Q==',
};

let loading = null;

export function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onload = resolve;
    s.onerror = () => {
      s.remove();
      reject(new Error(`${src.split('/').at(-1)} could not be loaded`));
    };
    document.head.append(s);
  });
}

function mermaid() {
  loading ||= loadScript(MERMAID)
    .then(() => {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict', // no links, clicks or scripts inside a diagram
        theme: 'dark',
        themeVariables: { background: 'transparent', fontSize: '16px' },
      });
      return window.mermaid;
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

let count = 0;

// The diagram as { svg, id } (SVG markup, and the id its styles and arrowheads hang on), or an
// error saying what's wrong, for the tutor to fix.
export async function diagramSVG(code) {
  const src = String(code ?? '')
    .replace(/^\s*```(?:mermaid)?[ \t]*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  if (!src) throw new Error('the diagram was empty');
  const m = await mermaid();
  try {
    await m.parse(src);
  } catch (err) {
    throw new Error(`Mermaid couldn't read it: ${String(err?.message || err).split('\n').slice(0, 3).join(' ')}`);
  }
  const id = `chalk-diagram-${Date.now().toString(36)}-${++count}`;
  const { svg } = await m.render(id, src);
  return { svg, id };
}

// The same diagram can be on the board and in the notes at once. Each copy gets its own ids,
// or a copy's arrowheads could point at markers inside a hidden one.
let copies = 0;
export function diagramCopy(svg, id) {
  if (!svg || !id) return svg || '';
  return svg.replace(new RegExp(`${id}(?![\\w-])`, 'g'), `${id}-c${++copies}`).replace(new RegExp(`${id}_`, 'g'), `${id}-c${copies}_`);
}
