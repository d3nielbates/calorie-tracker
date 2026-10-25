// Weekly meal planner.
//
// For each day it scores every allowed breakfast/lunch/dinner/snack
// combination, with portions scaled to the day's calorie target, and keeps the
// best. The score penalises: calories off target, protein and fibre below
// target, saturated fat/salt/sugars above UK limits, micronutrients below the
// UK RNI, and repeating meals. Results are deterministic for a given seed.
//
// To stay fast with a large meal library, each day searches a shortlist per
// slot: the meals that best fit the targets on their own plus a random few.
// Meal prep fixes breakfast and/or lunch (same meal, same portion) all week.

import { NUTRIENT_KEYS, MICRO_KEYS } from './nutrients.js';

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
export const SLOT_SHARES = { breakfast: 0.25, lunch: 0.3, dinner: 0.35, snack: 0.1 };
const SCALE_LIMITS = { breakfast: [0.6, 2.0], lunch: [0.6, 2.0], dinner: [0.6, 2.0], snack: [0.5, 2.5] };
const MAX_USES = { breakfast: 3, lunch: 2, dinner: 2, snack: 3 };
const SHORTLIST = { best: 9, random: 5 }; // candidates searched per slot per day
export const PREP_SLOTS = ['breakfast', 'lunch'];

export const DIETS = {
  omnivore: { label: 'No restrictions', excludeTags: [] },
  pescatarian: { label: 'Pescatarian', excludeTags: ['meat'] },
  vegetarian: { label: 'Vegetarian', excludeTags: ['meat', 'fish', 'shellfish'] },
  vegan: { label: 'Vegan', excludeTags: ['meat', 'fish', 'shellfish', 'dairy', 'egg', 'honey'] },
};

export const EXCLUSIONS = [
  { id: 'gluten', label: 'Gluten (also leaves out oats, which are often cross-contaminated)', tags: ['gluten', 'oats'] },
  { id: 'dairy', label: 'Milk / dairy', tags: ['dairy'] },
  { id: 'egg', label: 'Eggs', tags: ['egg'] },
  { id: 'nuts', label: 'Tree nuts', tags: ['nuts'] },
  { id: 'peanut', label: 'Peanuts', tags: ['peanut'] },
  { id: 'soy', label: 'Soya', tags: ['soy'] },
  { id: 'fish', label: 'Fish', tags: ['fish'] },
  { id: 'shellfish', label: 'Shellfish', tags: ['shellfish'] },
  { id: 'sesame', label: 'Sesame', tags: ['sesame'] },
  { id: 'alcohol', label: 'Alcohol', tags: ['alcohol'] },
];

/** Small seeded PRNG (mulberry32) so plans are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const foodKey = (id) => (id.includes(':') ? id : `uk:${id}`);

export function mealTags(meal, foods) {
  const tags = new Set();
  for (const [id] of meal.items) {
    const f = foods.get(foodKey(id));
    if (!f) throw new Error(`Meal ${meal.id} uses unknown food ${id}`);
    for (const t of f.tags ?? []) tags.add(t);
  }
  return tags;
}

export function excludedTags({ diet = 'omnivore', exclude = [] } = {}) {
  const tags = new Set(DIETS[diet]?.excludeTags ?? []);
  for (const id of exclude) {
    const ex = EXCLUSIONS.find((e) => e.id === id);
    if (ex) ex.tags.forEach((t) => tags.add(t));
  }
  return tags;
}

/** Ingredients (food ids with the "uk:" prefix) used anywhere in the meal library. */
export function mealIngredients(meals) {
  const ids = new Set();
  for (const m of meals) for (const [id] of m.items) ids.add(foodKey(id));
  return ids;
}

export function mealAllowed(meal, foods, options = {}) {
  if (options.dislikedMeals?.includes(meal.id)) return false;
  if (options.dislikedFoods?.length) {
    const no = new Set(options.dislikedFoods.map(foodKey));
    if (meal.items.some(([id]) => no.has(foodKey(id)))) return false;
  }
  const banned = excludedTags(options);
  for (const t of mealTags(meal, foods)) if (banned.has(t)) return false;
  return true;
}

/** Nutrient totals for a list of [foodId, grams]. Missing values count as 0. */
export function itemsNutrients(items, foods) {
  const out = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0]));
  for (const [id, grams] of items) {
    const f = foods.get(foodKey(id));
    if (!f) throw new Error(`Unknown food ${id}`);
    for (const k of NUTRIENT_KEYS) {
      const v = f.n[k];
      if (v != null) out[k] += (v * grams) / 100;
    }
  }
  return out;
}

export function roundGrams(g) {
  if (g <= 0) return 0;
  if (g < 20) return Math.max(1, Math.round(g));
  return Math.round(g / 5) * 5;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Nutrient vectors inside the search are plain number arrays in NUTRIENT_KEYS
// order, which keeps the exhaustive search fast enough for a phone.
const IDX = Object.fromEntries(NUTRIENT_KEYS.map((k, i) => [k, i]));
const NK = NUTRIENT_KEYS.length;
const SCORED_MICROS = MICRO_KEYS.filter((k) => k !== 'vitD'); // vitamin D: NHS advises a supplement instead

function makeScorer(targets) {
  const m = targets.macros;
  const microIdx = SCORED_MICROS.map((k) => IDX[k]);
  const microRni = SCORED_MICROS.map((k) => targets.micros[k]);
  const { kcal, protein, fibre, satfat, salt, sugars, fat } = IDX;
  return (t, r) => {
    let s = ((t[kcal] * r - targets.kcal) / targets.kcal) ** 2 * 400;
    s += Math.max(0, 1 - (t[protein] * r) / m.protein.target) ** 2 * 150;
    s += Math.max(0, 1 - (t[fibre] * r) / m.fibre.target) ** 2 * 60;
    s += Math.max(0, (t[satfat] * r) / m.satfat.max - 1) ** 2 * 80;
    s += Math.max(0, (t[salt] * r) / m.salt.max - 1) ** 2 * 80;
    s += Math.max(0, (t[sugars] * r) / m.sugars.max - 1) ** 2 * 30;
    s += Math.max(0, (t[fat] * r) / m.fat.max - 1) ** 2 * 40;
    s += Math.max(0, (t[protein] * r * 4) / targets.kcal - 0.35) ** 2 * 100;
    for (let i = 0; i < microIdx.length; i++) {
      s += Math.max(0, 1 - (t[microIdx[i]] * r) / microRni[i]) ** 2 * 8;
    }
    return s;
  };
}

/** Score a day's totals (object form) against targets. Lower is better. */
export function scoreDay(totals, targets) {
  return makeScorer(targets)(NUTRIENT_KEYS.map((k) => totals[k] ?? 0), 1);
}

const toArr = (obj, f = 1) => NUTRIENT_KEYS.map((k) => obj[k] * f);

function addVec(a, b, f = 1) {
  for (const k of NUTRIENT_KEYS) a[k] += b[k] * f;
  return a;
}

const zeroVec = () => Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0]));

/** Build the concrete meal (scaled, rounded grams, exact nutrients). */
export function buildMeal(meal, slot, scale, foods) {
  const items = meal.items.map(([id, g]) => {
    const f = foods.get(foodKey(id));
    return { foodId: foodKey(id), name: f.name, grams: roundGrams(g * scale) };
  }).filter((i) => i.grams > 0);
  return {
    slot,
    mealId: meal.id,
    name: meal.name,
    method: meal.method,
    mins: meal.mins,
    scale: Math.round(scale * 100) / 100,
    items,
    n: itemsNutrients(items.map((i) => [i.foodId, i.grams]), foods),
  };
}

export function dayTotals(meals) {
  const t = zeroVec();
  for (const m of meals) addVec(t, m.n);
  return t;
}

/** Prepare candidates per slot: allowed meals with base nutrients and slot scale. */
export function prepareCandidates({ targets, foods, meals, options = {} }) {
  const bySlot = {};
  const score = makeScorer(targets);
  for (const slot of SLOTS) {
    const slotKcal = targets.kcal * SLOT_SHARES[slot];
    const [lo, hi] = SCALE_LIMITS[slot];
    bySlot[slot] = meals
      .filter((m) => m.slots.includes(slot) && mealAllowed(m, foods, options))
      .map((m) => {
        const base = itemsNutrients(m.items, foods);
        const scale = clamp(slotKcal / base.kcal, lo, hi);
        const vec = addVec(zeroVec(), base, scale);
        // How well this meal fits the targets on its own (as if the whole day
        // looked like it): used to shortlist candidates for the search.
        const solo = score(toArr(vec), 1 / SLOT_SHARES[slot]);
        return { meal: m, base, scale, vec, solo };
      });
  }
  return bySlot;
}

function shortlist(opts, used, prevDay, random, noise) {
  if (opts.length <= SHORTLIST.best + SHORTLIST.random) return opts;
  const ranked = opts
    .map((c) => ({ c, s: c.solo + (used.get(c.meal.id) ?? 0) * 2 + (prevDay?.has(c.meal.id) ? 4 : 0) + random() * noise * 4 }))
    .sort((a, b) => a.s - b.s)
    .map((x) => x.c);
  const out = ranked.slice(0, SHORTLIST.best);
  const rest = ranked.slice(SHORTLIST.best);
  for (let i = 0; i < SHORTLIST.random && rest.length; i++) out.push(...rest.splice(Math.floor(random() * rest.length), 1));
  return out;
}

function bestCombos({ bySlot, targets, used, prevDay, random, noise, fixed = {}, limit = 1 }) {
  const slotOpts = SLOTS.map((slot) => (fixed[slot]
    ? [fixed[slot]]
    : shortlist(bySlot[slot].filter((c) => (used.get(c.meal.id) ?? 0) < MAX_USES[slot]), used, prevDay, random, noise)));
  if (slotOpts.some((o) => o.length === 0)) return [];
  const isFixed = SLOTS.map((slot) => Boolean(fixed[slot]));
  const fixedTot = new Float64Array(NK);
  SLOTS.forEach((slot, l) => { if (isFixed[l]) toArr(fixed[slot].vec).forEach((v, k) => { fixedTot[k] += v; }); });
  const mix = new Float64Array(NK);
  const score = makeScorer(targets);
  const arrs = slotOpts.map((opts) => opts.map((c) => toArr(c.vec)));
  const pens = slotOpts.map((opts, l) => opts.map((c) => (isFixed[l] ? 0 : (used.get(c.meal.id) ?? 0) * 2 + (prevDay?.has(c.meal.id) ? 4 : 0))));
  const ids = slotOpts.map((opts) => opts.map((c) => c.meal.id));
  // How far each candidate's portion can still be scaled within its slot limits.
  // Fixed (meal prep) portions never change, so they don't limit it.
  const rHi = slotOpts.map((opts, l) => opts.map((c) => (isFixed[l] ? Infinity : SCALE_LIMITS[SLOTS[l]][1] / c.scale)));
  const rLo = slotOpts.map((opts, l) => opts.map((c) => (isFixed[l] ? 0 : SCALE_LIMITS[SLOTS[l]][0] / c.scale)));
  const anyFixed = isFixed.some(Boolean);
  const top = []; // sorted ascending by score, at most `limit` long
  const tot = new Float64Array(NK);
  const pick = [0, 0, 0, 0];
  const kcalI = IDX.kcal;
  const consider = (s, r) => {
    if (top.length === limit && s >= top[top.length - 1].score) return;
    const entry = { score: s, idx: [...pick], r };
    let i = top.length;
    top.push(entry);
    while (i > 0 && top[i - 1].score > s) { top[i] = top[i - 1]; i--; }
    top[i] = entry;
    if (top.length > limit) top.pop();
  };
  const recurse = (level, pen, hiCap, loCap) => {
    if (level === SLOTS.length) {
      for (let a = 0; a < SLOTS.length; a++) {
        for (let b = a + 1; b < SLOTS.length; b++) if (ids[a][pick[a]] === ids[b][pick[b]]) return;
      }
      // Uniform correction so the day lands on target, without pushing any
      // portion outside its slot's limits (so the score matches the real plan).
      let s;
      let r;
      if (anyFixed) {
        // Only the flexible meals are scaled; fixed ones stay as they are.
        r = clamp((targets.kcal - fixedTot[kcalI]) / tot[kcalI], Math.max(0.85, loCap), Math.min(1.15, hiCap));
        for (let k = 0; k < NK; k++) mix[k] = fixedTot[k] + tot[k] * r;
        s = score(mix, 1) + pen;
      } else {
        r = clamp(targets.kcal / tot[kcalI], Math.max(0.85, loCap), Math.min(1.15, hiCap));
        s = score(tot, r) + pen;
      }
      if (noise) s += random() * noise;
      consider(s, r);
      return;
    }
    const opts = arrs[level];
    if (isFixed[level]) {
      pick[level] = 0;
      recurse(level + 1, pen + pens[level][0], hiCap, loCap);
      return;
    }
    for (let j = 0; j < opts.length; j++) {
      const v = opts[j];
      for (let k = 0; k < NK; k++) tot[k] += v[k];
      pick[level] = j;
      recurse(level + 1, pen + pens[level][j], Math.min(hiCap, rHi[level][j]), Math.max(loCap, rLo[level][j]));
      for (let k = 0; k < NK; k++) tot[k] -= v[k];
    }
  };
  recurse(0, 0, Infinity, 0);
  return top.map((t) => ({ score: t.score, pick: t.idx.map((j, level) => slotOpts[level][j]), r: t.r }));
}

function materialise(combo, foods, fixed = {}) {
  return combo.pick.map((c, i) => {
    const slot = SLOTS[i];
    if (fixed[slot]) return buildMeal(c.meal, slot, c.scale, foods);
    const [lo, hi] = SCALE_LIMITS[slot];
    return buildMeal(c.meal, slot, clamp(c.scale * combo.r, lo, hi), foods);
  });
}

/**
 * Meal-prep choices for a slot, best first: each candidate is fixed for the
 * day and the rest of the day is planned around it. Meals that keep in the
 * fridge get a small bonus.
 */
export function rankPrepMeals({ targets, foods, meals, options = {}, slot, fixed = {}, limit = 8, bySlot }) {
  bySlot ??= prepareCandidates({ targets, foods, meals, options });
  const random = rng(options.seed ?? 1);
  const taken = new Set(Object.values(fixed).map((c) => c.meal.id));
  const ranked = [];
  for (const c of bySlot[slot]) {
    if (taken.has(c.meal.id)) continue;
    const [best] = bestCombos({ bySlot, targets, used: new Map(), prevDay: null, random, noise: 0, fixed: { ...fixed, [slot]: c } });
    if (!best) continue;
    ranked.push({ cand: c, score: best.score - (c.meal.keeps >= 3 ? 1 : 0) });
  }
  ranked.sort((a, b) => a.score - b.score);
  return ranked.slice(0, limit);
}

/** Resolve options.prep ({breakfast, lunch}: false | true/'auto' | meal id) to fixed candidates. */
function resolvePrep({ targets, foods, meals, options, bySlot, random }) {
  const fixed = {};
  for (const slot of PREP_SLOTS) {
    const want = options.prep?.[slot];
    if (!want) continue;
    if (typeof want === 'string' && want !== 'auto') {
      const c = bySlot[slot].find((x) => x.meal.id === want);
      if (c) { fixed[slot] = c; continue; }
      // The chosen meal is no longer allowed (e.g. a new dislike): pick another.
    }
    const top = rankPrepMeals({ targets, foods, meals, options, slot, fixed, limit: 3, bySlot });
    if (!top.length) continue;
    fixed[slot] = top[Math.floor(random() * top.length)].cand;
  }
  return fixed;
}

/**
 * Plan a week. Returns { days, summary, warnings }. Throws if targets are
 * blocked, or if the diet/exclusions leave a slot with no meals.
 */
export function planWeek({ targets, foods, meals, options = {} }) {
  if (!targets?.ok) throw new Error('Set up your profile first so the planner has targets');
  if (targets.blocked) throw new Error(targets.blocked);
  const days = options.days ?? 7;
  const seed = options.seed ?? 1;
  const random = rng(seed);
  const noise = options.noise ?? 1.5;
  const bySlot = prepareCandidates({ targets, foods, meals, options });
  const empty = SLOTS.filter((s) => bySlot[s].length === 0);
  if (empty.length) {
    throw new Error(`No ${empty.join(' or ')} meals fit your diet and exclusions. Try removing an exclusion.`);
  }
  const fixed = resolvePrep({ targets, foods, meals, options, bySlot, random });
  const used = new Map();
  const out = [];
  let prevDay = null;
  for (let d = 0; d < days; d++) {
    let [best] = bestCombos({ bySlot, targets, used, prevDay, random, noise, fixed });
    if (!best) {
      // Ran out of variety: allow repeats rather than fail.
      used.clear();
      [best] = bestCombos({ bySlot, targets, used, prevDay, random, noise, fixed });
    }
    const dayMeals = materialise(best, foods, fixed);
    for (const m of dayMeals) used.set(m.mealId, (used.get(m.mealId) ?? 0) + 1);
    prevDay = new Set(dayMeals.map((m) => m.mealId));
    out.push({ meals: dayMeals, totals: dayTotals(dayMeals) });
  }
  const prepMeals = Object.fromEntries(Object.entries(fixed).map(([slot, c]) => [slot, c.meal.id]));
  const plan = { createdWith: { seed, options: { ...options } }, prepMeals, days: out };
  return { ...plan, ...summarisePlan(plan, targets) };
}

/** Weekly averages and warnings for a plan. */
export function summarisePlan(plan, targets) {
  const avg = zeroVec();
  for (const d of plan.days) addVec(avg, d.totals, 1 / plan.days.length);
  const warnings = [];
  const m = targets.macros;
  const below = [];
  for (const k of MICRO_KEYS) {
    if (k === 'vitD') continue;
    if (avg[k] < targets.micros[k]) below.push(k);
  }
  if (avg.protein < m.protein.target * 0.9) warnings.push('protein');
  if (avg.fibre < m.fibre.target * 0.9) warnings.push('fibre');
  if (avg.salt > m.salt.max) warnings.push('salt');
  if (avg.satfat > m.satfat.max) warnings.push('satfat');
  const maxDayDiff = Math.max(...plan.days.map((d) => Math.abs(d.totals.kcal - targets.kcal) / targets.kcal));
  return { summary: { average: avg, belowRni: below, flags: warnings, maxDayKcalError: maxDayDiff } };
}

/**
 * Ranked alternatives for one slot on one day, keeping the other meals as
 * they are. Each alternative is portioned so the day still meets the target.
 */
export function alternativesForSlot({ plan, dayIndex, slot, targets, foods, meals, options = {}, limit = 6 }) {
  const day = plan.days[dayIndex];
  const others = zeroVec();
  for (const m of day.meals) if (m.slot !== slot) addVec(others, m.n);
  const current = day.meals.find((m) => m.slot === slot)?.mealId;
  const sameDay = new Set(day.meals.map((m) => m.mealId));
  const weekUse = new Map();
  for (const d of plan.days) for (const m of d.meals) weekUse.set(m.mealId, (weekUse.get(m.mealId) ?? 0) + 1);
  const [lo, hi] = SCALE_LIMITS[slot];
  const scored = [];
  for (const meal of meals) {
    if (!meal.slots.includes(slot) || meal.id === current || sameDay.has(meal.id) || !mealAllowed(meal, foods, options)) continue;
    const base = itemsNutrients(meal.items, foods);
    const scale = clamp((targets.kcal - others.kcal) / base.kcal, lo, hi);
    const built = buildMeal(meal, slot, scale, foods);
    const s = scoreDay(addVec({ ...others }, built.n), targets) + (weekUse.get(meal.id) ?? 0) * 2;
    scored.push({ s, built });
  }
  scored.sort((a, b) => a.s - b.s);
  return scored.slice(0, limit).map((x) => x.built);
}

/** Return a new plan with one meal replaced. */
export function replaceMeal(plan, dayIndex, newMeal, targets) {
  const days = plan.days.map((d, i) => {
    if (i !== dayIndex) return d;
    const mealsOut = d.meals.map((m) => (m.slot === newMeal.slot ? newMeal : m));
    return { meals: mealsOut, totals: dayTotals(mealsOut) };
  });
  const next = { ...plan, days };
  return { ...next, ...summarisePlan(next, targets) };
}

/** Combined shopping list, grouped by category. */
export function shoppingList(plan, foods) {
  const totals = new Map();
  for (const d of plan.days) for (const m of d.meals) for (const it of m.items) {
    totals.set(it.foodId, (totals.get(it.foodId) ?? 0) + it.grams);
  }
  const rows = [...totals.entries()].map(([id, grams]) => {
    const f = foods.get(id);
    return { foodId: id, name: f.name, cat: f.cat, grams: Math.ceil(grams / 5) * 5 };
  });
  rows.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * Replace planned meals that the options no longer allow (for example after
 * a new dislike), keeping the rest of the plan. If a meal-prep meal is hit,
 * the week is re-planned so prep portions stay the same every day.
 * Returns { plan, changed, replanned }.
 */
export function cleanPlan({ plan, targets, foods, meals, options = {} }) {
  const byId = new Map(meals.map((m) => [m.id, m]));
  const bad = (m) => { const meal = byId.get(m.mealId); return !meal || !mealAllowed(meal, foods, options); };
  const prepSlots = new Set(Object.keys(plan.prepMeals ?? {}));
  let changed = 0;
  for (const d of plan.days) for (const m of d.meals) if (bad(m)) changed++;
  if (!changed) return { plan, changed: 0, replanned: false };
  if (plan.days.some((d) => d.meals.some((m) => prepSlots.has(m.slot) && bad(m)))) {
    const seed = plan.createdWith?.seed;
    const next = planWeek({ targets, foods, meals, options: { ...options, ...(seed != null ? { seed } : {}), days: plan.days.length } });
    return { plan: { ...next, startDate: plan.startDate }, changed, replanned: true };
  }
  let next = plan;
  plan.days.forEach((d, dayIndex) => {
    for (const m of d.meals) {
      if (!bad(m)) continue;
      const [alt] = alternativesForSlot({ plan: next, dayIndex, slot: m.slot, targets, foods, meals, options, limit: 1 });
      if (!alt) throw new Error(`No other ${SLOT_LABELS[m.slot].toLowerCase()} fits these choices. Try removing a dislike.`);
      next = replaceMeal(next, dayIndex, alt, targets);
    }
  });
  return { plan: next, changed, replanned: false };
}

/**
 * Batch-cooking guide for meal-prep slots: the portion, how many days, and
 * batches no bigger than the meal keeps in the fridge. Meals that don't keep
 * (or contain cooked rice, which should be eaten within a day) are made
 * fresh each day from the same weekly shop.
 */
export function prepBatches(plan, meals) {
  const byId = new Map(meals.map((m) => [m.id, m]));
  return Object.entries(plan.prepMeals ?? {}).map(([slot, mealId]) => {
    const days = [];
    plan.days.forEach((d, i) => { const m = d.meals.find((x) => x.slot === slot && x.mealId === mealId); if (m) days.push({ i, m }); });
    const portion = days[0]?.m;
    const keeps = byId.get(mealId)?.keeps ?? 0;
    const batches = [];
    if (portion && keeps >= 2) {
      const count = Math.ceil(days.length / keeps);
      let start = 0;
      for (let b = 0; b < count; b++) {
        const size = Math.ceil((days.length - start) / (count - b));
        batches.push({
          startDay: days[start].i,
          portions: size,
          items: portion.items.map((it) => ({ ...it, grams: it.grams * size })),
        });
        start += size;
      }
    }
    return { slot, mealId, name: portion?.name ?? mealId, method: portion?.method ?? '', portions: days.length, keeps, portion, batches };
  });
}
