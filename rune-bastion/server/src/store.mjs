import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny persistent document store: the whole state lives in memory and is flushed to one JSON
 * file with an atomic rename. It keeps the reference backend dependency-free; for production
 * traffic swap this module for a real database behind the same accessors.
 */
export function createStore(file) {
  let db = { users: {}, tokens: {}, emails: {}, identities: {}, devices: {}, saves: {}, purchases: {}, tickets: [] };
  if (file && fs.existsSync(file)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { console.error('store: could not read db, starting empty', e.message); }
  }
  let timer = null;
  const flush = () => {
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (e) { console.error('store: flush failed', e.message); }
  };
  return {
    get db() { return db; },
    /** schedule a write (coalesced). */
    touch() { if (file && !timer) timer = setTimeout(flush, 200); },
    flushNow() { if (timer) clearTimeout(timer); flush(); },
  };
}
