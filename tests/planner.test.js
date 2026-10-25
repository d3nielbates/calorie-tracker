import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEALS } from '../src/meals.js';
import { planWeek, alternativesForSlot, replaceMeal, shoppingList, mealTags, itemsNutrients, excludedTags, roundGrams, rng, SLOTS, DIETS, EXCLUSIONS, scoreDay } from '../src/planner.js';
import { computeTargets } from '../src/targets.js';
import { loadFoods } from './helpers.js';

const foods = loadFoods();
const profile = { sex: 'male', age: 40, heightCm: 180, weightKg: 100, activity: 'light', goal: 'lose', weeklyLossKg: 0.5 };
const targets = computeTargets(profile);
const plan = (opts = {}, t = targets) => planWeek({ targets: t, foods, meals: MEALS, options: { seed: 7, ...opts } });
const ANIMAL = new Set(['meat', 'fish', 'shellfish', 'dairy', 'egg', 'honey']);

test('meal library: unique ids, known foods, sensible base sizes', () => {
  const ids = new Set();
  const range = { breakfast: [200, 500], lunch: [300, 650], dinner: [380, 750], snack: [60, 320] };
  for (const m of MEALS) {
    assert.ok(!ids.has(m.id), `duplicate ${m.id}`);
    ids.add(m.id);
    assert.ok(m.items.length > 0 && m.slots.length > 0);
    for (const [id, g] of m.items) {
      assert.ok(foods.has(`uk:${id}`), `${m.id} uses unknown ${id}`);
      assert.ok(g > 0 && g <= 600, `${m.id} ${id} ${g} g`);
    }
    const n = itemsNutrients(m.items, foods);
    const [lo, hi] = range[m.slots[0]];
    assert.ok(n.kcal >= lo && n.kcal <= hi, `${m.name}: ${Math.round(n.kcal)} kcal`);
    for (const s of m.slots) assert.ok(SLOTS.includes(s));
  }
  for (const diet of Object.keys(DIETS)) {
    for (const slot of SLOTS) {
      const ok = MEALS.filter((m) => m.slots.includes(slot) && ![...mealTags(m, foods)].some((t) => excludedTags({ diet }).has(t)));
      assert.ok(ok.length >= 4, `${diet} ${slot} has only ${ok.length} meals`);
    }
  }
});

test('a week plan has 7 days, each within 5% of the calorie target', () => {
  const p = plan();
  assert.equal(p.days.length, 7);
  for (const d of p.days) {
    assert.equal(d.meals.length, 4);
    assert.deepEqual(d.meals.map((m) => m.slot), SLOTS);
    assert.ok(Math.abs(d.totals.kcal - targets.kcal) / targets.kcal < 0.05, `${d.totals.kcal} vs ${targets.kcal}`);
    assert.equal(new Set(d.meals.map((m) => m.mealId)).size, 4, 'no meal twice in a day');
  }
  assert.ok(p.summary.maxDayKcalError < 0.05);
});

test('day totals equal the sum of the rounded ingredient grams', () => {
  const p = plan();
  for (const d of p.days) {
    const items = d.meals.flatMap((m) => m.items.map((i) => [i.foodId, i.grams]));
    const n = itemsNutrients(items, foods);
    assert.ok(Math.abs(n.kcal - d.totals.kcal) < 1e-6);
    assert.ok(Math.abs(n.protein - d.totals.protein) < 1e-6);
    for (const m of d.meals) for (const i of m.items) assert.ok(Number.isInteger(i.grams) && i.grams > 0, `${i.name} ${i.grams}`);
  }
});

test('plans meet protein, fibre, salt and saturated fat goals on average for typical adults', () => {
  const people = [
    profile,
    { sex: 'female', age: 35, heightCm: 165, weightKg: 85, activity: 'moderate', goal: 'lose', weeklyLossKg: 0.5 },
    { sex: 'female', age: 55, heightCm: 160, weightKg: 70, activity: 'light', goal: 'maintain', weeklyLossKg: 0.5 },
    { sex: 'male', age: 25, heightCm: 190, weightKg: 120, activity: 'active', goal: 'lose', weeklyLossKg: 1 },
  ];
  for (const pr of people) {
    const t = computeTargets(pr);
    const p = plan({}, t);
    const a = p.summary.average;
    assert.ok(a.protein >= t.macros.protein.target * 0.9, `protein ${a.protein} vs ${t.macros.protein.target} at ${t.kcal} kcal`);
    assert.ok(a.fibre >= 30, `fibre ${a.fibre}`);
    assert.ok(a.salt <= 6, `salt ${a.salt}`);
    assert.ok(a.satfat <= t.macros.satfat.max, `satfat ${a.satfat}`);
    for (const d of p.days) assert.ok(Math.abs(d.totals.kcal - t.kcal) / t.kcal < 0.05, `${d.totals.kcal} vs ${t.kcal}`);
  }
});

test('plans meet UK micronutrient RNIs on average at a moderate calorie target (except vitamin D)', () => {
  const p = plan();
  assert.deepEqual(p.summary.belowRni, []);
});

test('the same seed gives the same plan; different seeds vary', () => {
  const a = plan({ seed: 42 });
  const b = plan({ seed: 42 });
  assert.deepEqual(a.days, b.days);
  const names = (p) => p.days.map((d) => d.meals.map((m) => m.mealId).join()).join('|');
  const variants = new Set([1, 2, 3, 4, 5].map((s) => names(plan({ seed: s }))));
  assert.ok(variants.size >= 3, `only ${variants.size} distinct plans`);
});

test('variety: no lunch or dinner more than twice a week, and no dinner on consecutive days', () => {
  for (const seed of [1, 2, 3]) {
    const p = plan({ seed });
    const count = new Map();
    p.days.forEach((d, i) => {
      for (const m of d.meals) count.set(m.mealId, (count.get(m.mealId) ?? 0) + 1);
      if (i > 0) assert.notEqual(d.meals[2].mealId, p.days[i - 1].meals[2].mealId, 'same dinner two days running');
    });
    for (const m of MEALS) {
      const c = count.get(m.id) ?? 0;
      if (m.slots.includes('dinner') || m.slots.includes('lunch')) assert.ok(c <= 2 || m.slots.includes('breakfast') || m.slots.includes('snack'), `${m.id} used ${c} times`);
    }
  }
});

test('diets and exclusions are respected', () => {
  const check = (opts, banned) => {
    const p = plan(opts);
    for (const d of p.days) for (const m of d.meals) for (const i of m.items) {
      for (const t of foods.get(i.foodId).tags) assert.ok(!banned.includes(t), `${opts.diet ?? ''} ${opts.exclude ?? ''}: ${i.name} has ${t}`);
    }
  };
  check({ diet: 'vegan' }, [...ANIMAL]);
  check({ diet: 'vegetarian' }, ['meat', 'fish', 'shellfish']);
  check({ diet: 'pescatarian' }, ['meat']);
  check({ exclude: ['gluten'] }, ['gluten', 'oats']);
  check({ exclude: ['nuts', 'peanut'] }, ['nuts', 'peanut']);
  check({ exclude: ['dairy', 'egg'] }, ['dairy', 'egg']);
  check({ diet: 'vegetarian', exclude: ['soy', 'sesame'] }, ['meat', 'fish', 'shellfish', 'soy', 'sesame']);
  check({ dislikedMeals: ['d-chilli'] }, []);
  assert.ok(!plan({ dislikedMeals: ['d-chilli', 'd-bolognese'] }).days.some((d) => d.meals.some((m) => ['d-chilli', 'd-bolognese'].includes(m.mealId))));
});

test('impossible restrictions give a clear error instead of a bad plan', () => {
  assert.throws(() => plan({ diet: 'vegan', exclude: ['soy', 'gluten', 'nuts', 'peanut'] }), /No .*meals fit/);
  assert.throws(() => planWeek({ targets: { ok: false }, foods, meals: MEALS }), /profile/);
  const blocked = computeTargets({ ...profile, weightKg: 55 });
  assert.throws(() => plan({}, blocked), /healthy range/);
});

test('every diet/exclusion combination either plans 7 valid days or explains why', () => {
  const exclusions = EXCLUSIONS.map((e) => e.id);
  let planned = 0;
  for (const diet of Object.keys(DIETS)) {
    for (let i = 0; i < exclusions.length; i++) for (let j = i; j < exclusions.length; j++) {
      const exclude = [...new Set([exclusions[i], exclusions[j]])];
      try {
        const p = plan({ diet, exclude, seed: i * 31 + j });
        assert.equal(p.days.length, 7);
        for (const d of p.days) assert.ok(Number.isFinite(d.totals.kcal) && d.totals.kcal > targets.kcal * 0.8);
        planned++;
      } catch (e) {
        assert.match(e.message, /No .*meals fit your diet/);
      }
    }
  }
  assert.ok(planned > 150, `planned ${planned}`);
});

test('swap alternatives respect diet, exclude the current meal and are ranked', () => {
  const p = plan({ diet: 'vegetarian' });
  const current = p.days[0].meals[2].mealId;
  const alts = alternativesForSlot({ plan: p, dayIndex: 0, slot: 'dinner', targets, foods, meals: MEALS, options: { diet: 'vegetarian' } });
  assert.ok(alts.length >= 3);
  assert.ok(alts.every((m) => m.mealId !== current && m.slot === 'dinner'));
  for (const m of alts) for (const i of m.items) assert.ok(!['meat', 'fish', 'shellfish'].some((t) => foods.get(i.foodId).tags.includes(t)));
  const next = replaceMeal(p, 0, alts[0], targets);
  assert.equal(next.days[0].meals[2].mealId, alts[0].mealId);
  assert.notDeepEqual(next.days[0].totals, p.days[0].totals);
  assert.deepEqual(next.days[1], p.days[1]);
  const sum = next.days[0].meals.reduce((s, m) => s + m.n.kcal, 0);
  assert.ok(Math.abs(sum - next.days[0].totals.kcal) < 1e-6);
});

test('shopping list adds up all planned grams', () => {
  const p = plan();
  const rows = shoppingList(p, foods);
  const planned = p.days.flatMap((d) => d.meals.flatMap((m) => m.items)).reduce((s, i) => s + i.grams, 0);
  const listed = rows.reduce((s, r) => s + r.grams, 0);
  assert.ok(listed >= planned && listed <= planned + rows.length * 5);
  assert.equal(new Set(rows.map((r) => r.foodId)).size, rows.length);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].cat <= rows[i].cat);
});

test('helpers', () => {
  assert.equal(roundGrams(4.5), 5);
  assert.equal(roundGrams(0.4), 1);
  assert.equal(roundGrams(0), 0);
  assert.equal(roundGrams(123), 125);
  const r1 = rng(5); const r2 = rng(5);
  for (let i = 0; i < 5; i++) { const v = r1(); assert.equal(v, r2()); assert.ok(v >= 0 && v < 1); }
  const good = plan().days[0].totals;
  assert.ok(scoreDay(good, targets) < scoreDay({ ...good, kcal: good.kcal * 1.4 }, targets));
});

test('planning a week is fast enough for a phone', () => {
  const t0 = performance.now();
  plan({ seed: 99 });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `${ms} ms`);
});
