// Pictures for the tutor's notes, kept safe by where they come from: only the main images of
// Wikipedia articles, only freely licensed ones, shown with their credit.

const API = 'https://en.wikipedia.org/w/api.php';
const IMAGE_HOSTS = /^https:\/\/(thumb|upload)\.wikimedia\.org\//;

async function wiki(params) {
  const q = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*', ...params });
  const res = await fetch(`${API}?${q}`);
  if (!res.ok) throw new Error(`Wikipedia didn't answer (HTTP ${res.status})`);
  return res.json();
}

// Articles with their main (free) image.
async function pagesWithImages(params) {
  const data = await wiki({ prop: 'pageimages|description', piprop: 'thumbnail|name', pithumbsize: '960', pilicense: 'free', ...params });
  return (data.query?.pages || []).filter((p) => p.thumbnail?.source && IMAGE_HOSTS.test(p.thumbnail.source) && !p.missing);
}

const strip = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// Who made the image and under what licence, for the credit line.
async function credit(file) {
  try {
    const data = await wiki({ titles: `File:${file}`, prop: 'imageinfo', iiprop: 'extmetadata', iiextmetadatafilter: 'Artist|LicenseShortName' });
    const meta = data.query?.pages?.[0]?.imageinfo?.[0]?.extmetadata || {};
    // Commons often words a missing author as "No machine-readable author provided. Name assumed (based on copyright claims)."
    const artist = strip(meta.Artist?.value)
      .replace(/^No machine-readable author provided\.?\s*/i, '')
      .replace(/\s*assumed \(based on copyright claims\)\.?/i, '')
      .slice(0, 60);
    return { artist, licence: strip(meta.LicenseShortName?.value).slice(0, 40) };
  } catch {
    return { artist: '', licence: '' };
  }
}

/**
 * The best picture for `query`: the article with exactly that title (following redirects), or
 * else the best search result that has a picture. Returns null if none has a free picture.
 */
export async function findPicture(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return null;
  let page = (await pagesWithImages({ titles: q, redirects: '1' }))[0];
  if (!page) {
    const hits = await pagesWithImages({ generator: 'search', gsrsearch: q, gsrlimit: '6' });
    page = hits.sort((a, b) => (a.index ?? 99) - (b.index ?? 99))[0];
  }
  if (!page) return null;
  const { artist, licence } = await credit(page.pageimage);
  const slug = encodeURIComponent(page.title.replace(/ /g, '_'));
  return {
    src: page.thumbnail.source,
    width: page.thumbnail.width,
    height: page.thumbnail.height,
    title: page.title,
    description: String(page.description || '').slice(0, 120),
    page: `https://en.wikipedia.org/wiki/${slug}`,
    file: `https://en.wikipedia.org/wiki/File:${encodeURIComponent(page.pageimage)}`,
    artist,
    licence,
  };
}

/** The picture as a JPEG (base64), at most maxSide pixels, so the tutor can see what it showed. */
export async function pictureForTutor(src, maxSide = 1024) {
  if (!IMAGE_HOSTS.test(src)) throw new Error('not a Wikimedia image');
  const res = await fetch(src);
  if (!res.ok) throw new Error(`the picture didn't download (HTTP ${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * scale));
  c.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; // diagrams are often transparent PNGs
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}
