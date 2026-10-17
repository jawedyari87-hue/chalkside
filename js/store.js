// Lessons saved in IndexedDB on this device: the page, the board and the transcript.

const DB_NAME = 'chalkside';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('No IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lessons')) db.createObjectStore('lessons', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is blocked'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run(stores, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        Promise.resolve(fn(tx, (r) => (result = r))).catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Save cancelled'));
      }),
  );
}

const reqValue = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export const lessons = {
  async list() {
    return run(['meta'], 'readonly', async (tx, done) => {
      const all = await reqValue(tx.objectStore('meta').getAll());
      done(all.sort((a, b) => (b.updated || 0) - (a.updated || 0)));
    });
  },

  async get(id) {
    return run(['lessons'], 'readonly', async (tx, done) => {
      done(await reqValue(tx.objectStore('lessons').get(id)));
    });
  },

  async put(lesson) {
    const meta = {
      id: lesson.id,
      title: lesson.title,
      created: lesson.created,
      updated: lesson.updated,
      blocks: (lesson.board?.pages || []).filter((p) => !p.sample).reduce((n, p) => n + p.blocks.length, 0),
      strokes: (lesson.page?.items || []).filter((it) => it.type === 'stroke').length,
      pictures: (lesson.page?.items || []).filter((it) => it.type === 'image').length,
      preview: lesson.preview || '',
    };
    return run(['lessons', 'meta'], 'readwrite', (tx) => {
      tx.objectStore('lessons').put(lesson);
      tx.objectStore('meta').put(meta);
    });
  },

  async remove(id) {
    return run(['lessons', 'meta'], 'readwrite', (tx) => {
      tx.objectStore('lessons').delete(id);
      tx.objectStore('meta').delete(id);
    });
  },
};
