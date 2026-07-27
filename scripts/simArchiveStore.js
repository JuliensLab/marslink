// simArchiveStore.js — IndexedDB-backed archive with a synchronous in-memory view.
//
// The config archive previously lived in localStorage ("marslinkArchive"), whose
// ~5 MB origin quota silently capped it: once full, save() threw and new sweep
// results were DISCARDED. IndexedDB is disk-quota-backed (typically GBs), so the
// cap disappears — but its API is async, while every archive call site does
// synchronous whole-array load()/save(). This store bridges the two: the full
// array lives in memory (load() stays synchronous), and writes diff against what
// is already persisted and flush to IndexedDB in the background.
//
// Entry identity: entries are treated as IMMUTABLE once saved — call sites
// unshift new objects and filter deletions, they don't mutate in place. The one
// exception is measurement SETS (kind: "set"), whose `items` array grows during
// a run — call touch(entry) after any in-place mutation so it is re-persisted.
//
// Migration: on first init, if the DB is empty and localStorage has the old
// archive, it is copied into IndexedDB. The localStorage copy is LEFT INTACT as
// a frozen backup (nothing writes it anymore); a marker key prevents re-merging.

const DB_NAME = "marslink";
const STORE = "archive";
const LS_KEY = "marslinkArchive";
const LS_MIGRATED = "marslinkArchiveMigratedToIdb";

class ArchiveStore {
  constructor() {
    this._db = null;
    this._mem = [];            // newest-first, the synchronous truth
    this._persisted = new WeakSet(); // entry objects already written to IDB
    this._ready = null;        // init() promise
  }

  init() {
    if (this._ready) return this._ready;
    this._ready = this._init().catch((e) => {
      // IDB unavailable (private mode, quota, corruption): fall back to a pure
      // in-memory archive seeded from localStorage so the UI still works; saves
      // beyond the session are then best-effort back to localStorage.
      console.error("[ArchiveStore] IndexedDB unavailable — falling back to localStorage", e);
      this._db = null;
      this._mem = this._loadLocalStorage();
      for (const e2 of this._mem) this._persisted.add(e2);
      return this._mem;
    });
    return this._ready;
  }

  async _init() {
    this._db = await new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    let rows = await this._idbAll();
    // One-time migration from localStorage (kept there untouched as a backup).
    if (!rows.length && !localStorage.getItem(LS_MIGRATED)) {
      const legacy = this._loadLocalStorage();
      if (legacy.length) {
        this._restampDupes(legacy);
        await this._idbPutMany(legacy);
        rows = legacy;
        console.log(`[ArchiveStore] migrated ${legacy.length} entries from localStorage to IndexedDB`);
      }
      try { localStorage.setItem(LS_MIGRATED, new Date().toISOString()); } catch {}
    }
    // Newest-first, matching the old array order (entries were unshifted).
    rows.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    this._mem = rows;
    for (const e of rows) this._persisted.add(e);
    return this._mem;
  }

  _loadLocalStorage() {
    try { const a = JSON.parse(localStorage.getItem(LS_KEY)); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  _restampDupes(arr) {
    const seen = new Set();
    let bump = 0;
    for (const e of arr) {
      while (e.id == null || seen.has(String(e.id))) e.id = Date.now() + (bump++);
      seen.add(String(e.id));
    }
  }

  _idbAll() {
    return new Promise((res, rej) => {
      const tx = this._db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  _idbPutMany(entries, removeIds = []) {
    if (!this._db) {
      // localStorage fallback: best effort, whole array.
      try { localStorage.setItem(LS_KEY, JSON.stringify(this._mem)); } catch (e) { console.error("[ArchiveStore] fallback save failed", e); }
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = this._db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      for (const e of entries) os.put(e);
      for (const id of removeIds) os.delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  /** Synchronous view of the archive (newest-first). Do not mutate entries in place. */
  all() { return this._mem; }

  /**
   * Re-read the store from disk — for a tab that is OBSERVING writes made by
   * another tab (the measurement runner window). Replaces the in-memory entry
   * objects, so never call this in a tab that holds live references into the
   * archive (i.e. while this tab is itself running a measurement).
   */
  async refresh() {
    if (!this._db) return this._mem;
    const rows = await this._idbAll();
    rows.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    this._mem = rows;
    this._persisted = new WeakSet();
    for (const e of rows) this._persisted.add(e);
    return this._mem;
  }

  /**
   * Replace the archive with `arr` (the load-mutate-save pattern of the call
   * sites). New entry objects are persisted; ids no longer present are deleted.
   */
  replaceAll(arr) {
    this._restampDupes(arr);
    const newIds = new Set(arr.map((e) => String(e.id)));
    // Delete with the ORIGINAL key type: IndexedDB keys are typed, so deleting
    // the numeric id 1769… with the string "1769…" silently matches nothing and
    // the entry reappears on the next load.
    const removed = this._mem.filter((e) => !newIds.has(String(e.id))).map((e) => e.id);
    const added = arr.filter((e) => !this._persisted.has(e));
    this._mem = arr;
    for (const e of added) this._persisted.add(e);
    this._idbPutMany(added, removed).catch((e) => console.error("[ArchiveStore] persist failed", e));
  }

  /** Re-persist an entry after an in-place mutation (measurement sets growing). */
  touch(entry) {
    this._persisted.add(entry);
    this._idbPutMany([entry]).catch((e) => console.error("[ArchiveStore] persist failed", e));
  }
}

export const archiveStore = new ArchiveStore();
