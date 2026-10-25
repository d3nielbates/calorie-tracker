// Optional sync to a per-person private store (used when the app runs as a
// claude.ai Artifact, where browser storage can be cleared). The state is
// split into documents: "core" (profile, weights, plan...), "products"
// (supermarket products you've used) and one document per diary day. Each
// document carries a timestamp; on load the newer copy of each one wins.

export const CORE_KEYS = ['version', 'acceptedDisclaimer', 'profile', 'settings', 'weights', 'customFoods', 'recentFoods', 'plan', 'planOptions'];
export const DAY_PREFIX = 'd-';
export const RECENT_DAYS = 400; // diary days loaded at start; older days load when opened

export const dayDocId = (date) => `${DAY_PREFIX}${date}`;

/** The documents a state is stored as, keyed by document id. */
export function splitState(state) {
  const docs = { core: {}, products: { items: state.productCache ?? {} } };
  for (const k of CORE_KEYS) docs.core[k] = state[k] ?? null;
  for (const [date, entries] of Object.entries(state.diary ?? {})) {
    if (entries.length) docs[dayDocId(date)] = { kind: 'day', date, entries };
  }
  return docs;
}

/** Document ids whose content differs between two states. */
export function changedDocIds(prev, next) {
  const ids = [];
  if (CORE_KEYS.some((k) => prev[k] !== next[k])) ids.push('core');
  if (prev.productCache !== next.productCache) ids.push('products');
  const dates = new Set([...Object.keys(prev.diary ?? {}), ...Object.keys(next.diary ?? {})]);
  for (const d of dates) if ((prev.diary ?? {})[d] !== (next.diary ?? {})[d]) ids.push(dayDocId(d));
  return ids;
}

/** Record that these documents changed now. */
export function stamp(state, ids, now = Date.now()) {
  if (!ids.length) return state;
  const stamps = { ...(state.stamps ?? {}) };
  for (const id of ids) stamps[id] = now;
  return { ...state, stamps };
}

/**
 * Merge remote documents into the local state. `remote` maps doc id ->
 * body (with `updatedAt`). Returns the merged state and the ids where the
 * local copy is newer and should be uploaded.
 */
export function mergeRemote(local, remote) {
  const localDocs = splitState(local);
  const stamps = { ...(local.stamps ?? {}) };
  const merged = { ...local, diary: { ...local.diary } };
  const push = [];
  const ids = new Set([...Object.keys(localDocs), ...Object.keys(remote), ...Object.keys(stamps)]);
  for (const id of ids) {
    const r = remote[id];
    const lt = stamps[id] ?? 0;
    const rt = r?.updatedAt ?? 0;
    if (r && rt > lt) {
      if (id === 'core') for (const k of CORE_KEYS) { if (k in r && r[k] !== null) merged[k] = r[k]; else if (k in r) merged[k] = local[k]; }
      else if (id === 'products') merged.productCache = r.items ?? {};
      else if (id.startsWith(DAY_PREFIX)) {
        const date = id.slice(DAY_PREFIX.length);
        if (Array.isArray(r.entries) && r.entries.length) merged.diary[date] = r.entries; else delete merged.diary[date];
      }
      stamps[id] = rt;
    } else if (lt > rt || (!r && localDocs[id])) {
      push.push(id);
    }
  }
  return { state: { ...merged, stamps }, push };
}

/**
 * Sync engine over the platform db. `getState` returns the current state.
 * Writes are queued and sent one at a time per document.
 */
export function createCloudSync({ db, uid, getState, onError = () => {} }) {
  const col = db.collection(`data/users/${uid}`);
  const pending = new Set();
  let timer = null;
  let running = false;

  async function loadAll() {
    const remote = {};
    const [core, products, days] = await Promise.all([
      col.doc('core').get(),
      col.doc('products').get(),
      col.where('kind', '==', 'day').orderBy('date', 'desc').limit(RECENT_DAYS).get(),
    ]);
    if (core.exists) remote.core = core.data();
    if (products.exists) remote.products = products.data();
    for (const d of days.docs) if (d.exists) remote[d.id] = d.data();
    return remote;
  }

  async function loadDay(date) {
    const snap = await col.doc(dayDocId(date)).get();
    return snap.exists ? snap.data() : null;
  }

  async function flush() {
    if (running) return;
    running = true;
    try {
      while (pending.size) {
        const [id] = pending;
        pending.delete(id);
        const state = getState();
        const docs = splitState(state);
        const updatedAt = state.stamps?.[id] ?? Date.now();
        try {
          if (docs[id]) await col.doc(id).set({ ...docs[id], updatedAt });
          else await col.doc(id).set({ kind: 'day', date: id.slice(DAY_PREFIX.length), entries: [], updatedAt });
        } catch (e) {
          if (e?.code === 'unavailable') { pending.add(id); await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000)); continue; }
          onError(e);
        }
      }
    } finally {
      running = false;
    }
  }

  function queue(ids, delay = 800) {
    for (const id of ids) pending.add(id);
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  return { loadAll, loadDay, queue, flush, pending };
}
