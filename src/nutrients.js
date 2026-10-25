// Nutrient definitions shared by the importers, targets, planner and UI.
// All food values are stored per 100 g (or per 100 ml for drinks, treated as 100 g).

export const NUTRIENTS = [
  // Energy and macronutrients
  { key: 'kcal', label: 'Energy', unit: 'kcal', group: 'energy', dp: 0 },
  { key: 'protein', label: 'Protein', unit: 'g', group: 'macro', dp: 1 },
  { key: 'carbs', label: 'Carbohydrate', unit: 'g', group: 'macro', dp: 1 },
  { key: 'sugars', label: 'of which sugars', unit: 'g', group: 'macro', dp: 1 },
  { key: 'fat', label: 'Fat', unit: 'g', group: 'macro', dp: 1 },
  { key: 'satfat', label: 'of which saturates', unit: 'g', group: 'macro', dp: 1 },
  { key: 'fibre', label: 'Fibre', unit: 'g', group: 'macro', dp: 1 },
  { key: 'salt', label: 'Salt', unit: 'g', group: 'macro', dp: 2 },
  // Vitamins
  { key: 'vitA', label: 'Vitamin A', unit: 'µg', group: 'vitamin', dp: 0 },
  { key: 'thiamin', label: 'Thiamin (B1)', unit: 'mg', group: 'vitamin', dp: 2 },
  { key: 'riboflavin', label: 'Riboflavin (B2)', unit: 'mg', group: 'vitamin', dp: 2 },
  { key: 'niacin', label: 'Niacin (B3)', unit: 'mg', group: 'vitamin', dp: 1 },
  { key: 'b6', label: 'Vitamin B6', unit: 'mg', group: 'vitamin', dp: 2 },
  { key: 'folate', label: 'Folate', unit: 'µg', group: 'vitamin', dp: 0 },
  { key: 'b12', label: 'Vitamin B12', unit: 'µg', group: 'vitamin', dp: 2 },
  { key: 'vitC', label: 'Vitamin C', unit: 'mg', group: 'vitamin', dp: 0 },
  { key: 'vitD', label: 'Vitamin D', unit: 'µg', group: 'vitamin', dp: 1 },
  { key: 'vitE', label: 'Vitamin E', unit: 'mg', group: 'vitamin', dp: 1 },
  { key: 'vitK', label: 'Vitamin K', unit: 'µg', group: 'vitamin', dp: 0 },
  // Minerals
  { key: 'calcium', label: 'Calcium', unit: 'mg', group: 'mineral', dp: 0 },
  { key: 'iron', label: 'Iron', unit: 'mg', group: 'mineral', dp: 1 },
  { key: 'magnesium', label: 'Magnesium', unit: 'mg', group: 'mineral', dp: 0 },
  { key: 'phosphorus', label: 'Phosphorus', unit: 'mg', group: 'mineral', dp: 0 },
  { key: 'potassium', label: 'Potassium', unit: 'mg', group: 'mineral', dp: 0 },
  { key: 'zinc', label: 'Zinc', unit: 'mg', group: 'mineral', dp: 1 },
  { key: 'copper', label: 'Copper', unit: 'mg', group: 'mineral', dp: 2 },
  { key: 'selenium', label: 'Selenium', unit: 'µg', group: 'mineral', dp: 0 },
];

export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);
export const MICRO_KEYS = NUTRIENTS.filter((n) => n.group === 'vitamin' || n.group === 'mineral').map((n) => n.key);
export const NUTRIENT_BY_KEY = Object.fromEntries(NUTRIENTS.map((n) => [n.key, n]));

/** Sodium (mg) to salt (g), using the UK/EU labelling factor of 2.5. */
export const sodiumMgToSaltG = (mg) => (mg * 2.5) / 1000;

/** Round to a number of decimal places without floating point noise. */
export function round(value, dp = 1) {
  if (value == null || !Number.isFinite(value)) return value;
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Nutrients for a given weight of a food. Missing values stay missing
 * (undefined), so the UI can say "no data" rather than show a false zero.
 */
export function nutrientsForGrams(per100, grams) {
  const out = {};
  if (!per100 || !Number.isFinite(grams) || grams < 0) return out;
  for (const key of NUTRIENT_KEYS) {
    const v = per100[key];
    if (v != null && Number.isFinite(v)) out[key] = (v * grams) / 100;
  }
  return out;
}

/**
 * Sum a list of nutrient objects. Returns totals plus, per nutrient, how many
 * items were missing a value (so coverage gaps are visible).
 */
export function sumNutrients(list) {
  const totals = {};
  const missing = {};
  for (const key of NUTRIENT_KEYS) {
    totals[key] = 0;
    missing[key] = 0;
  }
  for (const item of list) {
    for (const key of NUTRIENT_KEYS) {
      const v = item?.[key];
      if (v != null && Number.isFinite(v)) totals[key] += v;
      else missing[key] += 1;
    }
  }
  return { totals, missing, count: list.length };
}
