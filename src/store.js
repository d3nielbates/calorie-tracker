// App state and persistence. State lives in the browser's localStorage on
// this device only; use Export to keep a backup or move to another device.

import { NUTRIENT_KEYS } from './nutrients.js';

export const STORAGE_KEY = 'calorie-tracker.state';
export const SCHEMA_VERSION = 1;

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    acceptedDisclaimer: false,
    profile: null,
    settings: { weightUnit: 'kg', heightUnit: 'cm' },
    diary: {}, // { 'YYYY-MM-DD': [entry] }
    weights: [], // [{ date, kg }]
    customFoods: [],
    productCache: {}, // supermarket products you have used, so they work offline
    recentFoods: [],
    plan: null,
    // dislikedFoods: curated food ids (no "uk:" prefix) never to plan.
    // prep: per slot, false (vary daily), 'auto' (same meal all week, planner
    // picks) or a meal id to keep week after week. shop: price level.
    planOptions: { diet: 'omnivore', exclude: [], dislikedMeals: [], dislikedFoods: [], prep: { breakfast: false, lunch: false }, shop: 'typical' },
    priceOverrides: {}, // food id -> price in pounds the person pays per pack
    stamps: {}, // when each saved document last changed (for account sync)
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Check and repair a state object loaded from storage or a backup file. */
export function validateState(raw) {
  if (!isObj(raw)) throw new Error('Not a tracker backup');
  if (raw.version > SCHEMA_VERSION) throw new Error('This backup is from a newer version of the app');
  const s = { ...emptyState(), ...raw };
  s.settings = { ...emptyState().settings, ...(isObj(raw.settings) ? raw.settings : {}) };
  s.planOptions = { ...emptyState().planOptions, ...(isObj(raw.planOptions) ? raw.planOptions : {}) };
  const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  for (const k of ['exclude', 'dislikedMeals', 'dislikedFoods']) s.planOptions[k] = strings(s.planOptions[k]);
  const prep = isObj(s.planOptions.prep) ? s.planOptions.prep : {};
  s.planOptions.prep = Object.fromEntries(['breakfast', 'lunch'].map((k) => [k, typeof prep[k] === 'string' ? prep[k] : prep[k] === true ? 'auto' : false]));
  s.priceOverrides = isObj(raw.priceOverrides)
    ? Object.fromEntries(Object.entries(raw.priceOverrides).filter(([, v]) => Number.isFinite(v) && v >= 0 && v < 1000))
    : {};
  if (!isObj(s.diary)) s.diary = {};
  for (const [date, entries] of Object.entries(s.diary)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(entries)) { delete s.diary[date]; continue; }
    s.diary[date] = entries.filter((e) => isObj(e) && typeof e.name === 'string' && Number.isFinite(e.grams) && isObj(e.per100));
  }
  s.weights = Array.isArray(s.weights) ? s.weights.filter((w) => isObj(w) && /^\d{4}-\d{2}-\d{2}$/.test(w.date) && Number.isFinite(w.kg) && w.kg > 0) : [];
  s.customFoods = Array.isArray(s.customFoods) ? s.customFoods.filter((f) => isObj(f) && f.id && f.name && isObj(f.n)) : [];
  s.productCache = isObj(s.productCache) ? s.productCache : {};
  s.recentFoods = Array.isArray(s.recentFoods) ? s.recentFoods.filter((x) => typeof x === 'string').slice(0, 50) : [];
  s.stamps = isObj(raw.stamps) ? raw.stamps : {};
  s.version = SCHEMA_VERSION;
  return s;
}

export function loadState(storage) {
  let text = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return { state: emptyState(), error: 'Browser storage is unavailable (private browsing?). Your entries will not be saved.' };
  }
  if (!text) return { state: emptyState(), error: null };
  try {
    return { state: validateState(JSON.parse(text)), error: null };
  } catch (e) {
    try { storage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, text); } catch { /* ignore */ }
    return { state: emptyState(), error: `Saved data could not be read and was set aside (${e.message}).` };
  }
}

export function saveState(storage, state) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return null;
  } catch (e) {
    return `Could not save: ${e.name === 'QuotaExceededError' ? 'storage is full' : e.message}`;
  }
}

export function exportState(state) {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 1);
}

export function importState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('That file is not valid JSON'); }
  return validateState(raw);
}

let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Make a diary entry. per100 is copied so the diary never changes if a database value does. */
export function makeEntry({ food, grams, slot, portionLabel }) {
  if (!Number.isFinite(grams) || grams <= 0 || grams > 5000) throw new Error('Enter an amount between 1 and 5000 g');
  const per100 = {};
  for (const k of NUTRIENT_KEYS) per100[k] = food.n[k] ?? null;
  return {
    id: newId(),
    slot,
    foodId: food.id,
    name: food.brand ? `${food.name} (${food.brand})` : food.name,
    src: food.src,
    grams: Math.round(grams * 10) / 10,
    portionLabel: portionLabel ?? null,
    per100,
  };
}

export function addEntry(state, date, entry) {
  const diary = { ...state.diary, [date]: [...(state.diary[date] ?? []), entry] };
  const recentFoods = [entry.foodId, ...state.recentFoods.filter((x) => x !== entry.foodId)].slice(0, 50);
  return { ...state, diary, recentFoods };
}

export function updateEntry(state, date, id, changes) {
  const list = (state.diary[date] ?? []).map((e) => (e.id === id ? { ...e, ...changes } : e));
  return { ...state, diary: { ...state.diary, [date]: list } };
}

export function removeEntry(state, date, id) {
  const list = (state.diary[date] ?? []).filter((e) => e.id !== id);
  const diary = { ...state.diary };
  if (list.length) diary[date] = list; else delete diary[date];
  return { ...state, diary };
}

export function setWeight(state, date, kg) {
  if (!Number.isFinite(kg) || kg < 20 || kg > 400) throw new Error('Enter a weight between 20 and 400 kg');
  const weights = [...state.weights.filter((w) => w.date !== date), { date, kg: Math.round(kg * 100) / 100 }]
    .sort((a, b) => a.date.localeCompare(b.date));
  return { ...state, weights };
}

export function removeWeight(state, date) {
  return { ...state, weights: state.weights.filter((w) => w.date !== date) };
}

/** Latest logged weight, falling back to the profile weight. */
export function currentWeight(state) {
  const w = state.weights[state.weights.length - 1];
  return w ? w.kg : state.profile?.weightKg ?? null;
}

/** Validate and create a custom food from label values per 100 g. */
export function makeCustomFood({ name, brand, kcal, protein, carbs, sugars, fat, satfat, fibre, salt, servingG }) {
  const errors = [];
  if (!name || !String(name).trim()) errors.push('Give the food a name');
  const nums = { kcal, protein, carbs, sugars, fat, satfat, fibre, salt };
  for (const [k, v] of Object.entries(nums)) {
    if (v == null || v === '') continue;
    if (!Number.isFinite(v) || v < 0) errors.push(`${k} must be a number of 0 or more`);
  }
  if (!Number.isFinite(kcal)) errors.push('Calories per 100 g are required');
  else if (kcal > 900) errors.push('Calories per 100 g cannot be above 900');
  if ([protein, carbs, fat, fibre, salt].reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) > 101) errors.push('Nutrients add up to more than 100 g per 100 g');
  if (Number.isFinite(sugars) && Number.isFinite(carbs) && sugars > carbs) errors.push('Sugars cannot be more than carbohydrate');
  if (Number.isFinite(satfat) && Number.isFinite(fat) && satfat > fat) errors.push('Saturates cannot be more than fat');
  if (errors.length) throw new Error(errors.join('. '));
  const n = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null]));
  for (const [k, v] of Object.entries(nums)) if (Number.isFinite(v)) n[k] = v;
  return {
    id: `custom:${newId()}`,
    name: String(name).trim(),
    brand: brand ? String(brand).trim() : '',
    cat: 'My foods',
    src: 'custom',
    portions: Number.isFinite(servingG) && servingG > 0 ? [[`Serving (${servingG} g)`, servingG]] : [],
    n,
  };
}
