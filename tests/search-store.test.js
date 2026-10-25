import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchFoods, buildIndex, normalise, queryGroups } from '../src/search.js';
import { loadState, saveState, validateState, importState, exportState, emptyState, makeEntry, addEntry, updateEntry, removeEntry, setWeight, removeWeight, currentWeight, makeCustomFood, STORAGE_KEY } from '../src/store.js';
import { nutrientsForGrams, sumNutrients, round } from '../src/nutrients.js';
import { mergeFoods } from '../src/fooddb.js';
import { loadFoods, memoryStorage } from './helpers.js';

const foods = loadFoods();
const index = buildIndex([...foods.values()]);
const top = (q, n = 1) => searchFoods(index, q).slice(0, n).map((f) => f.name);

test('normalise and query parsing', () => {
  assert.equal(normalise('  Crème Fraîche & Co!! '), 'creme fraiche and co');
  assert.deepEqual(queryGroups('spring onion'), [['spring onion', 'scallions']]);
  assert.deepEqual(queryGroups('courgette'), [['courgette', 'zucchini']]);
  assert.deepEqual(queryGroups(''), []);
});

test('curated UK foods rank first for common searches', () => {
  assert.equal(top('semi skimmed milk')[0], 'Semi-skimmed milk');
  assert.equal(top('porridge')[0], 'Porridge oats (dry)');
  assert.match(top('chicken breast')[0], /^Chicken breast/);
  assert.equal(top('baked beans')[0], 'Baked beans in tomato sauce');
  assert.equal(top('weetabix')[0], 'Wholewheat biscuit cereal (Weetabix-style)');
});

test('UK words find American-named reference foods', () => {
  const names = (q) => searchFoods(index, q).map((f) => f.name.toLowerCase()).join(' | ');
  assert.match(names('courgette'), /zucchini/);
  assert.match(names('aubergine'), /eggplant/);
  assert.match(names('prawns'), /shrimp/);
  assert.match(names('beef mince'), /ground/);
  assert.match(names('spring onion'), /scallions/);
});

test('search needs every word to match and handles junk', () => {
  for (const f of searchFoods(index, 'salmon smoked')) assert.match(f.name.toLowerCase(), /salmon/);
  assert.deepEqual(searchFoods(index, ''), []);
  assert.deepEqual(searchFoods(index, 'zzzzqqq'), []);
  assert.ok(searchFoods(index, 'egg').length <= 40);
  assert.doesNotThrow(() => searchFoods(index, '((*+?[]\\'));
});

test('recent foods are boosted', () => {
  const plain = searchFoods(index, 'cheese').map((f) => f.id);
  const pick = plain[10];
  const boosted = searchFoods(index, 'cheese', { recent: [pick] }).map((f) => f.id);
  assert.ok(boosted.indexOf(pick) < 10);
});

test('nutrient maths keeps missing values missing', () => {
  const n = nutrientsForGrams({ kcal: 200, protein: 10, vitC: null }, 150);
  assert.equal(n.kcal, 300);
  assert.equal(n.protein, 15);
  assert.equal('vitC' in n, false);
  assert.deepEqual(nutrientsForGrams({ kcal: 1 }, -5), {});
  const s = sumNutrients([{ kcal: 100, vitC: 5 }, { kcal: 50 }]);
  assert.equal(s.totals.kcal, 150);
  assert.equal(s.totals.vitC, 5);
  assert.equal(s.missing.vitC, 1);
  assert.equal(round(1.005, 2), 1.01);
});

const food = { id: 'uk:apple', name: 'Apple', src: 'core', n: { kcal: 52, protein: 0.26 } };

test('diary entries: create, edit, delete', () => {
  assert.throws(() => makeEntry({ food, grams: 0, slot: 'snack' }), /between 1 and 5000/);
  assert.throws(() => makeEntry({ food, grams: NaN, slot: 'snack' }));
  let s = emptyState();
  const e = makeEntry({ food, grams: 150, slot: 'snack' });
  assert.equal(e.per100.kcal, 52);
  assert.equal(e.per100.fat, null);
  s = addEntry(s, '2026-10-25', e);
  assert.equal(s.diary['2026-10-25'].length, 1);
  assert.equal(s.recentFoods[0], 'uk:apple');
  s = updateEntry(s, '2026-10-25', e.id, { grams: 200 });
  assert.equal(s.diary['2026-10-25'][0].grams, 200);
  s = removeEntry(s, '2026-10-25', e.id);
  assert.equal(s.diary['2026-10-25'], undefined);
  const branded = makeEntry({ food: { ...food, id: 'off:1', brand: 'Tesco' }, grams: 10, slot: 'lunch' });
  assert.equal(branded.name, 'Apple (Tesco)');
});

test('weights: one per day, sorted, validated', () => {
  let s = emptyState();
  s = setWeight(s, '2026-10-02', 90);
  s = setWeight(s, '2026-10-01', 91);
  s = setWeight(s, '2026-10-02', 89.5);
  assert.deepEqual(s.weights, [{ date: '2026-10-01', kg: 91 }, { date: '2026-10-02', kg: 89.5 }]);
  assert.equal(currentWeight(s), 89.5);
  assert.throws(() => setWeight(s, '2026-10-03', 5));
  s = removeWeight(s, '2026-10-02');
  assert.equal(currentWeight(s), 91);
  assert.equal(currentWeight({ ...emptyState(), profile: { weightKg: 70 } }), 70);
});

test('custom foods are validated like a label', () => {
  const f = makeCustomFood({ name: ' Lasagne ', kcal: 150, fat: 5, satfat: 2, protein: 8, carbs: 15, sugars: 3, servingG: 350 });
  assert.equal(f.name, 'Lasagne');
  assert.equal(f.n.kcal, 150);
  assert.equal(f.n.vitC, null);
  assert.deepEqual(f.portions, [['Serving (350 g)', 350]]);
  assert.throws(() => makeCustomFood({ name: '', kcal: 100 }), /name/);
  assert.throws(() => makeCustomFood({ name: 'x' }), /Calories/);
  assert.throws(() => makeCustomFood({ name: 'x', kcal: 950 }), /900/);
  assert.throws(() => makeCustomFood({ name: 'x', kcal: 100, fat: 2, satfat: 3 }), /Saturates/);
  assert.throws(() => makeCustomFood({ name: 'x', kcal: 100, carbs: 2, sugars: 3 }), /Sugars/);
  assert.throws(() => makeCustomFood({ name: 'x', kcal: 100, protein: 60, carbs: 60 }), /more than 100 g/);
  assert.throws(() => makeCustomFood({ name: 'x', kcal: 100, protein: -1 }), /0 or more/);
});

test('storage: save, load, corrupt data and unavailable storage', () => {
  const st = memoryStorage();
  assert.deepEqual(loadState(st), { state: emptyState(), error: null });
  let s = addEntry(emptyState(), '2026-10-25', makeEntry({ food, grams: 100, slot: 'snack' }));
  assert.equal(saveState(st, s), null);
  assert.deepEqual(loadState(st).state, s);
  st.setItem(STORAGE_KEY, '{not json');
  const r = loadState(st);
  assert.match(r.error, /set aside/);
  assert.ok(Object.keys(st.data).some((k) => k.startsWith(`${STORAGE_KEY}.corrupt-`)), 'bad data kept for recovery');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); } };
  assert.match(loadState(broken).error, /unavailable/);
  assert.match(saveState(broken, s), /storage is full/);
});

test('backups: export, import, and repair of bad fields', () => {
  let s = setWeight(emptyState(), '2026-10-01', 80);
  s = addEntry(s, '2026-10-01', makeEntry({ food, grams: 100, slot: 'snack' }));
  const back = importState(exportState(s));
  assert.deepEqual(back.weights, s.weights);
  assert.deepEqual(back.diary, s.diary);
  assert.throws(() => importState('nope'), /not valid JSON/);
  assert.throws(() => importState('[1,2]'), /Not a tracker backup/);
  assert.throws(() => importState(JSON.stringify({ version: 99 })), /newer version/);
  const repaired = validateState({ version: 1, diary: { bad: [], '2026-10-01': [{ name: 'x', grams: 5, per100: {} }, { junk: true }] }, weights: [{ date: '2026-10-01', kg: -1 }, { date: '2026-10-02', kg: 80 }], settings: null, recentFoods: 'x' });
  assert.deepEqual(Object.keys(repaired.diary), ['2026-10-01']);
  assert.equal(repaired.diary['2026-10-01'].length, 1);
  assert.deepEqual(repaired.weights, [{ date: '2026-10-02', kg: 80 }]);
  assert.equal(repaired.settings.weightUnit, 'kg');
  assert.deepEqual(repaired.recentFoods, []);
});

test('merging foods: your foods win over cached products and the base database', () => {
  const base = [{ id: 'a', name: 'base' }, { id: 'off:1', name: 'pack' }];
  const m = mergeFoods(base, { offPack: [{ id: 'off:1', name: 'pack2' }], productCache: { 'off:1': { id: 'off:1', name: 'cached' } }, customFoods: [{ id: 'custom:1', name: 'mine' }] });
  assert.equal(m.get('off:1').name, 'cached');
  assert.equal(m.size, 3);
});
