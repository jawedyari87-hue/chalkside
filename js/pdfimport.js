// Pick pages from a PDF (lecture slides, problem sheets) to paste onto the page.
// pdf.js is only downloaded the first time a PDF is opened.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_SRI = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let loading = null;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS;
    s.integrity = PDFJS_SRI;
    s.crossOrigin = 'anonymous';
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) {
        reject(new Error('The PDF reader did not load.'));
        return;
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      resolve(lib);
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not download the PDF reader. Check your internet connection.'));
    };
    document.head.append(s);
  });
  return loading;
}

export async function openPdf(file) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  return lib.getDocument({ data }).promise;
}

export async function renderPdfPage(pdf, pageNumber, targetWidth) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: g, viewport }).promise;
  page.cleanup();
  return canvas;
}

/**
 * Fill `grid` with page thumbnails. Thumbnails render lazily as they scroll into view.
 * Returns a function that gives the selected page numbers in order.
 */
export function showThumbnails(pdf, grid, onChange) {
  grid.replaceChildren();
  const selected = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const btn = en.target;
        observer.unobserve(btn);
        renderPdfPage(pdf, Number(btn.dataset.page), 240)
          .then((c) => {
            c.className = 'pdf-thumb__img';
            btn.prepend(c);
          })
          .catch(() => {
            btn.classList.add('is-broken');
          });
      }
    },
    { root: grid, rootMargin: '200px' },
  );
  for (let n = 1; n <= pdf.numPages; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pdf-thumb';
    btn.dataset.page = String(n);
    btn.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span');
    label.className = 'pdf-thumb__n';
    label.textContent = `Page ${n}`;
    btn.append(label);
    btn.addEventListener('click', () => {
      if (selected.has(n)) selected.delete(n);
      else selected.add(n);
      btn.setAttribute('aria-pressed', String(selected.has(n)));
      onChange?.(selected.size);
    });
    grid.append(btn);
    observer.observe(btn);
  }
  return () => {
    observer.disconnect();
    return [...selected].sort((a, b) => a - b);
  };
}
