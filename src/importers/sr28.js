// Parser for the USDA National Nutrient Database for Standard Reference,
// Release 28 (SR28) "abbreviated" ASCII files: ABBREV.txt and FOOD_DES.txt.
// Fields are separated by ^ and text fields are wrapped in ~.

import { NUTRIENT_KEYS, sodiumMgToSaltG } from '../nutrients.js';

// Column positions in ABBREV.txt (SR28 documentation, p. 44).
const COL = {
  ndb: 0, water: 2, kcal: 3, protein: 4, fat: 5, carbByDiff: 7, fibre: 8, sugars: 9,
  calcium: 10, iron: 11, magnesium: 12, phosphorus: 13, potassium: 14, sodium: 15,
  zinc: 16, copper: 17, selenium: 19, vitC: 20, thiamin: 21, riboflavin: 22, niacin: 23,
  b6: 25, folate: 26, b12: 31, vitA: 33, vitE: 40, vitD: 41, vitK: 43, satfat: 44,
  gw1: 48, gw1Desc: 49, gw2: 50, gw2Desc: 51,
};
export const ABBREV_FIELD_COUNT = 53;

// Food groups that are not useful for a UK diary: baby foods, US fast-food
// chains, US branded ready meals, American Indian/Alaska Native foods and US
// restaurant foods.
export const EXCLUDED_GROUPS = new Set(['0300', '2100', '2200', '3500', '3600']);

export const GROUP_NAMES = {
  '0100': 'Dairy & eggs', '0200': 'Herbs & spices', '0400': 'Oils & spreads', '0500': 'Meat & poultry',
  '0600': 'Soups & sauces', '0700': 'Meat & poultry', '0800': 'Bread & cereals', '0900': 'Fruit',
  '1000': 'Meat & poultry', '1100': 'Vegetables', '1200': 'Nuts & seeds', '1300': 'Meat & poultry',
  '1400': 'Drinks', '1500': 'Fish & seafood', '1600': 'Beans, pulses & tofu', '1700': 'Meat & poultry',
  '1800': 'Baked goods', '1900': 'Snacks & sweets', '2000': 'Pasta, rice & grains', '2500': 'Snacks & sweets',
};

export function splitCaretLine(line) {
  return line.replace(/\r$/, '').split('^').map((f) => {
    if (f.startsWith('~') && f.endsWith('~') && f.length >= 2) return f.slice(1, -1);
    return f;
  });
}

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/** Convert one ABBREV row to per-100 g nutrients in this app's units. */
export function abbrevRowToNutrients(fields) {
  if (fields.length < ABBREV_FIELD_COUNT) {
    throw new Error(`ABBREV row has ${fields.length} fields, expected ${ABBREV_FIELD_COUNT}`);
  }
  const g = (k) => num(fields[COL[k]]);
  const carbByDiff = g('carbByDiff');
  const fibre = g('fibre');
  const sodium = g('sodium');
  const n = {
    kcal: g('kcal'),
    protein: g('protein'),
    // US "carbohydrate by difference" includes fibre. UK labels show available
    // carbohydrate, which excludes it, so subtract fibre where we know it.
    // Sugars are part of carbohydrate, so never let carbs fall below sugars
    // (by-difference values can be slightly low for foods such as milk).
    carbs: carbByDiff == null ? null : Math.max(0, carbByDiff - (fibre ?? 0), g('sugars') ?? 0),
    sugars: g('sugars'),
    fat: g('fat'),
    satfat: g('satfat'),
    fibre,
    salt: sodium == null ? null : sodiumMgToSaltG(sodium),
    vitA: g('vitA'),
    thiamin: g('thiamin'),
    riboflavin: g('riboflavin'),
    niacin: g('niacin'),
    b6: g('b6'),
    folate: g('folate'),
    b12: g('b12'),
    vitC: g('vitC'),
    vitD: g('vitD'),
    vitE: g('vitE'),
    vitK: g('vitK'),
    calcium: g('calcium'),
    iron: g('iron'),
    magnesium: g('magnesium'),
    phosphorus: g('phosphorus'),
    potassium: g('potassium'),
    zinc: g('zinc'),
    copper: g('copper'),
    selenium: g('selenium'),
  };
  const portions = [];
  for (const [w, d] of [['gw1', 'gw1Desc'], ['gw2', 'gw2Desc']]) {
    const grams = g(w);
    const desc = fields[COL[d]];
    if (grams && grams > 0 && desc) portions.push([desc.trim(), grams]);
  }
  return { ndb: fields[COL.ndb], n, portions };
}

/** Parse both files into a Map of NDB number -> food. */
export function parseSR28({ abbrevText, foodDesText }) {
  const desc = new Map();
  for (const line of foodDesText.split('\n')) {
    if (!line.trim()) continue;
    const f = splitCaretLine(line);
    desc.set(f[0], { group: f[1], name: f[2] });
  }
  const foods = new Map();
  for (const line of abbrevText.split('\n')) {
    if (!line.trim()) continue;
    const row = abbrevRowToNutrients(splitCaretLine(line));
    const d = desc.get(row.ndb);
    if (!d) throw new Error(`NDB ${row.ndb} is in ABBREV but not in FOOD_DES`);
    foods.set(row.ndb, { ...row, name: d.name, group: d.group });
  }
  return foods;
}

/**
 * Weighted blend of several foods' nutrients. Weights are normalised. A
 * nutrient is only kept if every component has it, so a blend never
 * understates a value because one part had no data.
 */
export function blendNutrients(parts) {
  const total = parts.reduce((s, [, w]) => s + w, 0);
  if (!(total > 0)) throw new Error('Blend weights must add up to more than zero');
  const out = {};
  for (const key of NUTRIENT_KEYS) {
    let sum = 0;
    let ok = true;
    for (const [n, w] of parts) {
      if (n[key] == null) { ok = false; break; }
      sum += n[key] * (w / total);
    }
    out[key] = ok ? sum : null;
  }
  return out;
}

/** Pack nutrients into a fixed-order array to keep the bundled file small. */
export function packNutrients(n) {
  return NUTRIENT_KEYS.map((k) => (n[k] == null ? null : Math.round(n[k] * 1000) / 1000));
}

export function unpackNutrients(arr) {
  const n = {};
  NUTRIENT_KEYS.forEach((k, i) => { n[k] = arr[i] ?? null; });
  return n;
}
