import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitState, changedDocIds, stamp, mergeRemote, createCloudSync, dayDocId } from '../src/cloud.js';
import { emptyState, addEntry, makeEntry, setWeight } from '../src/store.js';

const food = { id: 'uk:apple', name: 'Apple', src: 'core', n: { kcal: 52 } };
const withDay = (s, date, grams = 100) => addEntry(s, date, makeEntry({ food, grams, slot: 'snack' }));

/** In-memory stand-in for the platform db, enough for the sync engine. */
function fakeDb() {
  const store = new Map();
  const snap = (id, body) => ({ id, exists: !!body, data: () => body });
  const query = (prefix, filters = [], order = null, lim = 1000) => ({
    where: (f, op, v) => query(prefix, [...filters, [f, v]], order, lim),
    orderBy: (f, dir = 'asc') => query(prefix, filters, [f, dir], lim),
    limit: (n) => query(prefix, filters, order, n),
    get: async () => {
      let docs = [...store.entries()].filter(([p]) => p.startsWith(`${prefix}/`)).map(([p, b]) => snap(p.split('/').pop(), b));
      docs = docs.filter((d) => filters.every(([f, v]) => d.data()[f] === v));
      if (order) docs.sort((a, b) => (a.data()[order[0]] < b.data()[order[0]] ? -1 : 1) * (order[1] === 'desc' ? -1 : 1));
      docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length };
    },
  });
  return {
    store,
    writes: [],
    collection(path) {
      const self = this;
      return {
        ...query(path),
        doc: (id) => ({
          get: async () => snap(id, store.get(`${path}/${id}`)),
          set: async (body) => { self.writes.push(id); store.set(`${path}/${id}`, JSON.parse(JSON.stringify(body))); },
        }),
      };
    },
  };
}

test('state splits into core, products and one document per day', () => {
  let s = withDay(emptyState(), '2026-10-24');
  s = withDay(s, '2026-10-25');
  const docs = splitState(s);
  assert.deepEqual(Object.keys(docs).sort(), ['core', 'd-2026-10-24', 'd-2026-10-25', 'products']);
  assert.equal(docs.core.diary, undefined);
  assert.equal(docs['d-2026-10-25'].entries.length, 1);
  assert.ok(JSON.stringify(docs['d-2026-10-25']).length < 256 * 1024);
});

test('a heavy day stays well under the 256 KiB document limit', () => {
  let s = emptyState();
  for (let i = 0; i < 60; i++) s = withDay(s, '2026-10-25', i + 1);
  const full = { ...food, n: Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`k${i}`, 123.456])) };
  s = addEntry(s, '2026-10-25', makeEntry({ food: full, grams: 10, slot: 'snack' }));
  assert.ok(JSON.stringify(splitState(s)[dayDocId('2026-10-25')]).length < 64 * 1024);
});

test('changed documents are detected by reference', () => {
  const a = withDay(emptyState(), '2026-10-24');
  const b = withDay(a, '2026-10-25');
  assert.deepEqual(changedDocIds(a, b), ['core', 'd-2026-10-25']); // recentFoods changed too
  const c = setWeight(b, '2026-10-25', 80);
  assert.deepEqual(changedDocIds(b, c), ['core']);
  assert.deepEqual(changedDocIds(c, c), []);
});

test('merge: newer copy of each document wins; local-only documents are pushed', () => {
  let local = withDay(emptyState(), '2026-10-24');
  local = stamp(local, ['core', 'd-2026-10-24'], 100);
  const remote = {
    core: { ...splitState(setWeight(emptyState(), '2026-10-20', 90)).core, acceptedDisclaimer: true, updatedAt: 200 },
    'd-2026-10-23': { kind: 'day', date: '2026-10-23', entries: [{ id: 'r', name: 'Remote', grams: 1, per100: {} }], updatedAt: 50 },
    'd-2026-10-24': { kind: 'day', date: '2026-10-24', entries: [], updatedAt: 50 },
  };
  const { state, push } = mergeRemote(local, remote);
  assert.equal(state.acceptedDisclaimer, true, 'remote core newer');
  assert.deepEqual(state.weights, [{ date: '2026-10-20', kg: 90 }]);
  assert.equal(state.diary['2026-10-23'][0].name, 'Remote', 'remote-only day added');
  assert.equal(state.diary['2026-10-24'].length, 1, 'local day newer than remote empty copy');
  assert.deepEqual(push.sort(), ['d-2026-10-24', 'products']);
  assert.equal(state.stamps.core, 200);
});

test('merge: a remote deletion (empty day, newer) removes the local day', () => {
  const local = stamp(withDay(emptyState(), '2026-10-24'), ['d-2026-10-24'], 100);
  const { state } = mergeRemote(local, { 'd-2026-10-24': { kind: 'day', date: '2026-10-24', entries: [], updatedAt: 300 } });
  assert.equal(state.diary['2026-10-24'], undefined);
});

test('first sync uploads existing local data', () => {
  const local = withDay(emptyState(), '2026-10-24');
  const { push } = mergeRemote(local, {});
  assert.deepEqual(push.sort(), ['core', 'd-2026-10-24', 'products']);
});

test('sync engine round-trips through the store', async () => {
  const db = fakeDb();
  let s = stamp(withDay(withDay(emptyState(), '2026-10-24'), '2026-10-25'), ['core', 'products', 'd-2026-10-24', 'd-2026-10-25'], 10);
  const sync = createCloudSync({ db, uid: 'u1', getState: () => s });
  sync.queue(['core', 'products', 'd-2026-10-24', 'd-2026-10-25'], 0);
  await sync.flush();
  assert.equal(db.store.size, 4);
  assert.equal(db.store.get('data/users/u1/core').updatedAt, 10);
  // A second device loads it
  const remote = await createCloudSync({ db, uid: 'u1', getState: () => emptyState() }).loadAll();
  const { state } = mergeRemote(emptyState(), remote);
  assert.deepEqual(Object.keys(state.diary).sort(), ['2026-10-24', '2026-10-25']);
  assert.equal(state.diary['2026-10-25'][0].name, 'Apple');
  // Deleting a day writes an empty, newer copy
  const { ['2026-10-25']: _gone, ...rest } = s.diary;
  s = stamp({ ...s, diary: rest }, ['d-2026-10-25'], 20);
  sync.queue(['d-2026-10-25'], 0);
  await sync.flush();
  assert.deepEqual(db.store.get('data/users/u1/d-2026-10-25').entries, []);
  const again = mergeRemote(emptyState(), await sync.loadAll());
  assert.deepEqual(Object.keys(again.state.diary), ['2026-10-24']);
});

test('sync engine reports non-transient errors and keeps going', async () => {
  const db = fakeDb();
  const errors = [];
  const col = db.collection;
  db.collection = (p) => { const c = col.call(db, p); return { ...c, doc: (id) => (id === 'core' ? { set: async () => { throw { code: 'quota_exceeded' }; } } : c.doc(id)) }; };
  const s = withDay(emptyState(), '2026-10-24');
  const sync = createCloudSync({ db, uid: 'u', getState: () => s, onError: (e) => errors.push(e.code) });
  sync.queue(['core', 'd-2026-10-24'], 0);
  await sync.flush();
  assert.deepEqual(errors, ['quota_exceeded']);
  assert.ok(db.store.has('data/users/u/d-2026-10-24'));
});
