import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEALS } from '../src/meals.js';
import { planWeek, alternativesForSlot, cleanPlan, usableMeals, prepBatches, rankPrepMeals, shoppingList, mealIngredients, itemsNutrients } from '../src/planner.js';
import { PRICES, SHOPS, priceFor, costShoppingList } from '../src/prices.js';
import { buildVocab, localCoach, applyCoachChanges, parseCoachReply, coachPrompt, describeChanges } from '../src/coach.js';
import { validateState, emptyState } from '../src/store.js';
import { splitState } from '../src/cloud.js';
import { computeTargets } from '../src/targets.js';
import { UK_FOODS } from '../data-src/uk-foods.mjs';
import { loadFoods } from './helpers.js';

const foods = loadFoods();
const targets = computeTargets({ sex: 'female', age: 28, heightCm: 165, weightKg: 75, activity: 'light', goal: 'lose', weeklyLossKg: 0.5 });
const plan = (opts = {}) => planWeek({ targets, foods, meals: MEALS, options: { seed: 11, ...opts } });
const usedFoods = (p) => new Set(p.days.flatMap((d) => d.meals.flatMap((m) => m.items.map((i) => i.foodId))));
const vocab = buildVocab(mealIngredients(MEALS), foods);

test('the meal library is large enough to plan around dislikes', () => {
  for (const slot of ['breakfast', 'lunch', 'dinner', 'snack']) {
    assert.ok(MEALS.filter((m) => m.slots.includes(slot)).length >= 20, slot);
  }
  for (const m of MEALS) if (m.keeps != null) assert.ok(Number.isInteger(m.keeps) && m.keeps >= 1 && m.keeps <= 4, m.id);
});

test('disliked foods never appear in a plan or in swap suggestions', () => {
  const disliked = ['mushrooms', 'salmon-cooked', 'salmon-raw', 'smoked-salmon', 'avocado', 'cottage', 'tuna-tin', 'feta', 'egg'];
  const p = plan({ dislikedFoods: disliked });
  const used = usedFoods(p);
  for (const id of disliked) assert.ok(!used.has(`uk:${id}`), id);
  for (const d of p.days) assert.ok(Math.abs(d.totals.kcal - targets.kcal) / targets.kcal < 0.05);
  for (const slot of ['breakfast', 'lunch', 'dinner', 'snack']) {
    const alts = alternativesForSlot({ plan: p, dayIndex: 2, slot, targets, foods, meals: MEALS, options: { dislikedFoods: disliked } });
    for (const a of alts) for (const it of a.items) assert.ok(!disliked.includes(it.foodId.slice(3)), `${a.name} has ${it.name}`);
  }
});

test('a long list of dislikes still gives a full, on-target week', () => {
  const disliked = ['mushrooms', 'pepper-red', 'pepper-green', 'avocado', 'cottage', 'feta', 'tuna-tin', 'sardines-tin', 'mackerel-cooked',
    'salmon-cooked', 'salmon-raw', 'smoked-salmon', 'prawns-cooked', 'tofu-firm', 'tempeh', 'lentils-cooked', 'chickpeas-tin', 'kidney-beans-tin', 'spinach-raw', 'courgette'];
  const p = plan({ dislikedFoods: disliked });
  assert.equal(p.days.length, 7);
  assert.ok(p.summary.maxDayKcalError < 0.05);
  const used = usedFoods(p);
  for (const id of disliked) assert.ok(!used.has(`uk:${id}`), id);
});

test('one disliked ingredient is swapped or left out instead of dropping the meal', () => {
  const disliked = ['mushrooms', 'pepper-red', 'salmon-cooked', 'salmon-raw', 'feta', 'avocado', 'tuna-tin', 'chilli'];
  const options = { dislikedFoods: disliked };
  const usable = usableMeals(MEALS, foods, options);
  assert.ok(usable.length >= MEALS.length - 2, `${usable.length} of ${MEALS.length} meals kept`);
  const byId = new Map(usable.map((m) => [m.id, m]));
  const items = (id) => Object.fromEntries(byId.get(id).items);
  assert.ok(items('d-bolognese').courgette > 0 && !items('d-bolognese').mushrooms); // courgette for mushrooms
  assert.ok(items('d-salmon-potatoes')['trout-cooked'] > 0);
  assert.ok(items('l-chickpea-feta')['mozzarella-light'] > 0);
  assert.ok(!items('l-prawn-noodle-pot').chilli && byId.get('l-prawn-noodle-pot').swaps.some(([a, b]) => a === 'uk:chilli' && b === null));
  assert.match(byId.get('d-bolognese').name, /courgette instead of mushrooms/);
  for (const m of usable) for (const [id] of m.items) assert.ok(!disliked.includes(id), `${m.id} still has ${id}`);
  // Swaps never break a diet or allergy choice.
  const veg = usableMeals(MEALS, foods, { diet: 'vegetarian', exclude: ['dairy'], dislikedFoods: ['tofu-firm', 'feta'] });
  for (const m of veg) for (const [id] of m.items) {
    const tags = foods.get(`uk:${id}`).tags;
    assert.ok(!tags.some((t) => ['meat', 'fish', 'shellfish', 'dairy'].includes(t)), `${m.id}: ${id}`);
  }
  // An egg dish without eggs isn't offered.
  assert.ok(!usableMeals(MEALS, foods, { dislikedFoods: ['egg'] }).some((m) => m.id === 'b-veg-omelette'));
  // Planned meals show what changed.
  const p = plan(options);
  const changed = p.days.flatMap((d) => d.meals).filter((m) => m.swaps);
  assert.ok(changed.length > 0);
  for (const m of changed) assert.ok(m.baseName && m.swaps.every((x) => x.from));
});

test('cleanPlan keeps a meal when it can just swap the ingredient', () => {
  const p = plan({ prep: { breakfast: false, lunch: false } });
  const day = p.days.findIndex((d) => d.meals.some((m) => m.items.some((i) => i.foodId === 'uk:onion')));
  assert.ok(day >= 0);
  const res = cleanPlan({ plan: p, targets, foods, meals: MEALS, options: { dislikedFoods: ['onion'] } });
  const before = p.days[day].meals.map((m) => m.mealId);
  assert.deepEqual(res.plan.days[day].meals.map((m) => m.mealId), before);
  assert.ok(!usedFoods(res.plan).has('uk:onion'));
  assert.ok(Math.abs(res.plan.days[day].totals.kcal - targets.kcal) / targets.kcal < 0.06);
});

test('cleanPlan swaps only the meals that contain a new dislike', () => {
  const p = plan();
  const hit = p.days[0].meals[2].items[0].foodId.slice(3); // an ingredient of day 1's dinner
  const before = p.days.map((d) => d.meals.map((m) => m.mealId));
  const res = cleanPlan({ plan: p, targets, foods, meals: MEALS, options: { dislikedFoods: [hit] } });
  assert.ok(res.changed >= 1);
  assert.equal(res.replanned, false);
  assert.ok(!usedFoods(res.plan).has(`uk:${hit}`));
  res.plan.days.forEach((d, i) => d.meals.forEach((m, j) => {
    const old = p.days[i].meals[j];
    if (!old.items.some((it) => it.foodId === `uk:${hit}`)) assert.equal(m.mealId, before[i][j]);
  }));
  const same = cleanPlan({ plan: p, targets, foods, meals: MEALS, options: {} });
  assert.equal(same.plan, p);
  assert.equal(same.changed, 0);
});

test('meal prep: the same breakfast and lunch, at the same portion, every day', () => {
  const p = plan({ prep: { breakfast: 'auto', lunch: 'auto' } });
  assert.ok(p.prepMeals.breakfast && p.prepMeals.lunch);
  for (const slot of ['breakfast', 'lunch']) {
    const ms = p.days.map((d) => d.meals.find((m) => m.slot === slot));
    assert.ok(ms.every((m) => m.mealId === p.prepMeals[slot]), slot);
    assert.ok(ms.every((m) => JSON.stringify(m.items) === JSON.stringify(ms[0].items)), `${slot} portions vary`);
  }
  // Dinners and snacks still vary and every day stays on target.
  assert.ok(new Set(p.days.map((d) => d.meals[2].mealId)).size >= 4);
  for (const d of p.days) assert.ok(Math.abs(d.totals.kcal - targets.kcal) / targets.kcal < 0.05, `${d.totals.kcal}`);
  assert.ok(p.summary.average.protein >= targets.macros.protein.target * 0.9);
});

test('meal prep: a chosen meal is kept; a now-disliked one is replaced', () => {
  const p = plan({ prep: { breakfast: 'b-overnight-oats', lunch: false } });
  assert.equal(p.prepMeals.breakfast, 'b-overnight-oats');
  assert.ok(!p.prepMeals.lunch);
  assert.ok(p.days.every((d) => d.meals[0].mealId === 'b-overnight-oats'));
  // A disliked ingredient is swapped, so the chosen prep meal is kept.
  const q = plan({ prep: { breakfast: 'b-overnight-oats' }, dislikedFoods: ['apple'] });
  assert.equal(q.prepMeals.breakfast, 'b-overnight-oats');
  assert.ok(q.days.every((d) => d.meals[0].items.some((i) => i.foodId === 'uk:pear') && !d.meals[0].items.some((i) => i.foodId === 'uk:apple')));
  // A meal that can't work without the ingredient is replaced, still the same every day.
  const r = plan({ prep: { breakfast: 'b-scrambled-toast' }, dislikedFoods: ['egg'] });
  assert.notEqual(r.prepMeals.breakfast, 'b-scrambled-toast');
  assert.ok(r.days.every((d) => d.meals[0].mealId === r.prepMeals.breakfast));
  // cleanPlan re-plans when the prep meal is hit, keeping prep consistent.
  const res = cleanPlan({ plan: p, targets, foods, meals: MEALS, options: { prep: { breakfast: 'b-overnight-oats' }, dislikedFoods: ['apple'] } });
  assert.equal(res.replanned, true);
  assert.ok(res.plan.days.every((d) => d.meals[0].mealId === 'b-overnight-oats'));
  assert.equal(new Set(res.plan.days.map((d) => JSON.stringify(d.meals[0].items))).size, 1);
});

test('meal prep options are ranked and respect dislikes', () => {
  const ranked = rankPrepMeals({ targets, foods, meals: MEALS, options: { dislikedFoods: ['porridge-oats'] }, slot: 'breakfast', limit: 5 });
  assert.equal(ranked.length, 5);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i].score >= ranked[i - 1].score);
  for (const r of ranked) assert.ok(!r.cand.meal.items.some(([id]) => id === 'porridge-oats'));
});

test('batch-cooking guide: batches fit the fridge time and add up to the week', () => {
  const p = plan({ prep: { breakfast: 'b-overnight-oats', lunch: 'l-lentil-soup' } });
  const [b, l] = prepBatches(p, MEALS);
  assert.equal(b.slot, 'breakfast');
  for (const x of [b, l]) {
    assert.equal(x.portions, 7);
    assert.equal(x.batches.reduce((s, y) => s + y.portions, 0), 7);
    for (const y of x.batches) {
      assert.ok(y.portions <= x.keeps);
      y.items.forEach((it, i) => assert.equal(it.grams, x.portion.items[i].grams * y.portions));
    }
  }
  assert.deepEqual(l.batches.map((y) => [y.startDay, y.portions]), [[0, 4], [4, 3]]);
  const fresh = prepBatches(plan({ prep: { breakfast: 'b-scrambled-toast' } }), MEALS)[0];
  assert.equal(fresh.batches.length, 0); // made fresh daily
});

test('every curated food has a sensible estimated price', () => {
  for (const f of UK_FOODS) {
    const p = PRICES[f.id];
    assert.ok(p, `no price for ${f.id}`);
    assert.ok(p[0] > 0 && Number.isInteger(p[1]) && p[1] >= 0 && p[1] < 2000 && typeof p[2] === 'string', f.id);
  }
  // Spot checks against typical UK prices (pence per kg as eaten).
  const perKg = (id) => (priceFor(id).pence / priceFor(id).packGrams) * 1000;
  assert.ok(perKg('milk-semi') > 40 && perKg('milk-semi') < 120);
  assert.ok(perKg('chicken-breast-raw') > 400 && perKg('chicken-breast-raw') < 1200);
  assert.ok(perKg('porridge-oats') > 50 && perKg('porridge-oats') < 300);
  assert.ok(perKg('salmon-raw') > 1000 && perKg('salmon-raw') < 3000);
});

test('shopping list costs: whole packs, eaten share, shop level and own prices', () => {
  const rows = [
    { foodId: 'uk:milk-semi', name: 'Milk', cat: 'Dairy & eggs', grams: 2500 },
    { foodId: 'uk:olive-oil', name: 'Olive oil', cat: 'Oils', grams: 50 },
    { foodId: 'uk:banana', name: 'Banana', cat: 'Fruit', grams: 250 },
    { foodId: 'x:custom', name: 'Mystery', cat: 'Other', grams: 100 },
  ];
  const c = costShoppingList(rows);
  assert.equal(c.rows[0].price.packs, 2);
  assert.equal(c.rows[0].price.buyPence, 310);
  assert.equal(c.rows[0].price.usedPence, Math.round((2500 / 2272) * 155));
  assert.equal(c.buyPence, 310 + 90); // olive oil is a cupboard staple
  assert.equal(c.staplesPence, 600);
  assert.deepEqual(c.unpriced, ['Mystery']);
  const cheap = costShoppingList(rows, { shop: 'discount' });
  assert.equal(cheap.rows[2].price.packPence, Math.round(90 * SHOPS.discount.factor));
  const own = costShoppingList(rows, { shop: 'premium', overrides: { banana: 1.1 } });
  assert.equal(own.rows[2].price.packPence, 110);
  assert.equal(own.rows[2].price.custom, true);
  // A real plan has every item priced and a plausible weekly cost for one person.
  const week = costShoppingList(shoppingList(plan(), foods));
  assert.deepEqual(week.unpriced, []);
  assert.ok(week.usedPence > 1500 && week.usedPence < 6000, `${week.usedPence}`);
  assert.ok(week.buyPence >= week.usedPence * 0.8);
});

test('coach understands plain sentences', () => {
  const ask = (s) => localCoach(s, { vocab, meals: MEALS });
  let r = ask("She hates mushrooms and won't eat fish");
  assert.ok(r.dislikeFoods.includes('uk:mushrooms'));
  for (const id of ['uk:salmon-cooked', 'uk:tuna-tin', 'uk:cod-cooked', 'uk:sardines-tin']) assert.ok(r.dislikeFoods.includes(id), id);
  assert.ok(!r.dislikeFoods.includes('uk:prawns-cooked'));
  r = ask("she doesn't like peppers, avocado or cottage cheese but she loves chicken");
  assert.deepEqual(new Set(r.dislikeFoods), new Set(['uk:pepper-red', 'uk:pepper-green', 'uk:avocado', 'uk:cottage']));
  assert.ok(r.allowFoods.includes('uk:chicken-breast-cooked'));
  r = ask('No spicy food please. She likes salmon actually.');
  assert.ok(r.dislikeFoods.includes('uk:chilli') && r.dislikeFoods.includes('uk:curry-powder'));
  assert.ok(r.allowFoods.includes('uk:salmon-cooked'));
  r = ask('she hates red meat');
  assert.ok(r.dislikeFoods.includes('uk:beef-mince-5-raw') && r.dislikeFoods.includes('uk:bacon-back'));
  assert.ok(!r.dislikeFoods.some((id) => /chicken|turkey/.test(id)));
  r = ask("won't eat eggs or tomatoes");
  assert.ok(r.dislikeFoods.includes('uk:egg') && r.dislikeFoods.includes('uk:tomato'));
  assert.ok(!r.dislikeFoods.includes('uk:baked-beans') && !r.dislikeFoods.includes('uk:egg-noodles-cooked'));
  assert.deepEqual(ask('Same breakfast and lunch every day').prep, { breakfast: true, lunch: true });
  assert.deepEqual(ask('a different lunch each day please').prep, { lunch: false });
  assert.deepEqual(ask('hello').dislikeFoods, []);
});

test('coach changes apply to options and can be undone', () => {
  let o = { diet: 'omnivore', exclude: [], dislikedMeals: [], dislikedFoods: ['feta'], prep: { breakfast: false, lunch: 'l-lentil-soup' } };
  o = applyCoachChanges(o, { dislikeFoods: ['uk:mushrooms'], dislikeMeals: ['d-chilli'], prep: { breakfast: true, lunch: true } });
  assert.deepEqual(o.dislikedFoods.sort(), ['feta', 'mushrooms']);
  assert.deepEqual(o.dislikedMeals, ['d-chilli']);
  assert.deepEqual(o.prep, { breakfast: 'auto', lunch: 'l-lentil-soup' });
  o = applyCoachChanges(o, { allowFoods: ['uk:feta'], allowMeals: ['d-chilli'], prep: { lunch: false } });
  assert.deepEqual(o.dislikedFoods, ['mushrooms']);
  assert.deepEqual(o.dislikedMeals, []);
  assert.equal(o.prep.lunch, false);
  assert.deepEqual(describeChanges({ dislikeFoods: ['mushrooms'] }, { foods, meals: MEALS }), ["Swapped out or left out of meals: Mushrooms, raw"]);
});

test('AI coach answers are validated against real ids', () => {
  const prompt = coachPrompt('she hates olives and mushrooms', { vocab, meals: MEALS, options: { dislikedFoods: ['feta'] } });
  assert.match(prompt, /mushrooms: Mushrooms/);
  assert.match(prompt, /d-chilli: /);
  assert.match(prompt, /Currently disliked ingredients: feta/);
  const r = parseCoachReply('```json\n{"dislikeFoods":["mushrooms","uk:tuna-tin","olives","rm -rf"],"allowFoods":[],"dislikeMeals":["d-chilli","x"],"prep":{"breakfast":true,"lunch":"yes"},"unmatched":["olives"],"reply":"Done"}\n```', { vocab, meals: MEALS });
  assert.deepEqual(r.dislikeFoods, ['mushrooms', 'tuna-tin']);
  assert.deepEqual(r.dislikeMeals, ['d-chilli']);
  assert.deepEqual(r.prep, { breakfast: true });
  assert.deepEqual(r.unmatched, ['olives']);
  assert.equal(r.reply, 'Done');
  assert.throws(() => parseCoachReply('not json', { vocab, meals: MEALS }));
});

test('saved state: new preferences have safe defaults and are synced', () => {
  const old = validateState({ version: 1, planOptions: { diet: 'vegetarian', exclude: ['nuts'], dislikedMeals: ['d-chilli'] } });
  assert.deepEqual(old.planOptions.dislikedFoods, []);
  assert.deepEqual(old.planOptions.prep, { breakfast: false, lunch: false });
  assert.equal(old.planOptions.shop, 'typical');
  assert.deepEqual(old.priceOverrides, {});
  const bad = validateState({ version: 1, planOptions: { dislikedFoods: ['egg', 5, null], prep: { breakfast: true, lunch: 7 } }, priceOverrides: { egg: 2.5, milk: -1, x: 'a' } });
  assert.deepEqual(bad.planOptions.dislikedFoods, ['egg']);
  assert.deepEqual(bad.planOptions.prep, { breakfast: 'auto', lunch: false });
  assert.deepEqual(bad.priceOverrides, { egg: 2.5 });
  const docs = splitState({ ...emptyState(), priceOverrides: { egg: 2 } });
  assert.deepEqual(docs.core.priceOverrides, { egg: 2 });
});

test('new meals are realistic: base portions and kcal per gram', () => {
  for (const m of MEALS) {
    const n = itemsNutrients(m.items, foods);
    const grams = m.items.reduce((s, [, g]) => s + g, 0);
    assert.ok(n.kcal / grams < 6.5, `${m.id} is ${Math.round(n.kcal / grams * 100)} kcal/100 g`);
    assert.ok(n.protein > 0, m.id);
  }
});
