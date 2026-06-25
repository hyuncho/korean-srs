// Tiny IndexedDB wrapper. Stores: cards, days, meta.
import { SEED } from "./seed.js";

const DB_NAME = "korean-srs";
const DB_VERSION = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  getAll: (store) => tx(store, "readonly", (s) => reqP(s.getAll())),
  get: (store, key) => tx(store, "readonly", (s) => reqP(s.get(key))),
  put: (store, val) => tx(store, "readwrite", (s) => reqP(s.put(val))),
  bulkPut: (store, vals) => tx(store, "readwrite", (s) => { vals.forEach((v) => s.put(v)); }),
  del: (store, key) => tx(store, "readwrite", (s) => reqP(s.delete(key))),
  clear: (store) => tx(store, "readwrite", (s) => reqP(s.clear())),
};

// ── Settings & state ──
export const DEFAULT_SETTINGS = {
  firstDayCount: 20,   // words introduced on the very first day
  newPerDay: 5,        // words introduced on each subsequent day
  sessionMinutes: 10,  // target session length (soft)
  typingThreshold: 4,  // interval (days) at which a word graduates from MC to typing
  passGoal: 95,        // % pass rate (over the rolling window) that ends a drill
  lang: "en",          // UI language: "en" | "ko" (vocabulary content is unaffected)
};

export async function getSettings() {
  const m = await db.get("meta", "settings");
  return Object.assign({}, DEFAULT_SETTINGS, m ? m.value : {});
}
export async function saveSettings(value) {
  await db.put("meta", { key: "settings", value });
}
export async function getState() {
  const m = await db.get("meta", "state");
  return m ? m.value : { lastIntroDate: null, firstDayDone: false };
}
export async function saveState(value) {
  await db.put("meta", { key: "state", value });
}

// ── Seeding ──
function newId() {
  return "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function blankCard(fields) {
  return Object.assign({
    id: newId(),
    ko: "", en: "", ex: "", exEn: "", topic: "general",
    introduced: false,
    suspended: false,
    status: "new",          // new | learning | review
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    due: 0,
    introducedAt: 0,
    seen: 0, correct: 0, wrong: 0,
    lastSeen: 0,
    createdAt: Date.now(),
  }, fields || {});
}

export async function seedIfEmpty() {
  const cards = await db.getAll("cards");
  if (cards.length > 0) return cards;
  const seeded = SEED.map((w) => blankCard(w));
  await db.bulkPut("cards", seeded);
  return seeded;
}

// Add any SEED words not already present. New words enter as "upcoming" (not
// introduced) and get introduced over the following days. Tracks every seed
// word ever added in meta.seededKo so deleting one keeps it gone.
export async function mergeSeed() {
  const cards = await db.getAll("cards");
  const present = new Set(cards.map((c) => c.ko));
  const meta = await db.get("meta", "seededKo");
  const known = new Set(meta ? meta.value : []);

  const toAdd = [];
  for (const w of SEED) {
    if (present.has(w.ko) || known.has(w.ko)) continue;
    toAdd.push(blankCard(w));
  }
  if (toAdd.length) await db.bulkPut("cards", toAdd);

  // mark all current seed words as known (so future deletes stick, re-runs no-op)
  for (const w of SEED) known.add(w.ko);
  await db.put("meta", { key: "seededKo", value: [...known] });
  return toAdd.length;
}
