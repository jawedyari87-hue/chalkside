// Colours for code on the board, by highlight.js (its common languages: Python, Java, C, C++,
// JavaScript, SQL, shell and more). It loads the first time code appears.

import { loadScript } from './diagram.js';

const HLJS = {
  src: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js',
  integrity: 'sha512-6yoqbrcLAHDWAdQmiRlHG4+m0g/CT/V9AGyxabG8j7Jk8j3r3K6due7oqpiRMZqcYe9WM2gPcaNNxnl2ux+3tA==',
};
const THEME = {
  href: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/atom-one-dark.min.css',
  integrity: 'sha512-Jk4AqjWsdSzSWCSuQTfYRIF84Rq/eV0G2+tu07byYwHcbTGfdmLrHjUSwvzp5HvbiqK4ibmNwdcG49Y5RGYPTg==',
};

let loading = null;

function hljs() {
  if (window.hljs) return Promise.resolve(window.hljs);
  loading ||= (() => {
    const css = document.createElement('link');
    Object.assign(css, { rel: 'stylesheet', href: THEME.href, integrity: THEME.integrity, crossOrigin: 'anonymous', referrerPolicy: 'no-referrer' });
    document.head.append(css);
    return loadScript(HLJS).then(
      () => window.hljs,
      (err) => {
        loading = null;
        throw err;
      },
    );
  })();
  return loading;
}

// Colour the code blocks inside an element (on the board, or in the notes). Resolves when done.
export function highlightCode(root) {
  const blocks = [...root.querySelectorAll('pre code:not(.hljs)')];
  if (!blocks.length) return Promise.resolve();
  return hljs()
    .then((h) => {
      for (const b of blocks) {
        // A language highlight.js doesn't know: let it guess instead of warning.
        const lang = /language-(\S+)/.exec(b.className)?.[1];
        if (lang && !h.getLanguage(lang)) b.classList.remove(`language-${lang}`);
        try {
          h.highlightElement(b);
        } catch {
          /* left plain */
        }
      }
    })
    .catch(() => {});
}
