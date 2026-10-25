// Loads the bundled food database and merges in the user's own foods and
// cached supermarket products.

import { unpackNutrients } from './importers/sr28.js';
import { NUTRIENT_KEYS } from './nutrients.js';

export function unpackDatabase(json) {
  if (!json || !Array.isArray(json.foods)) throw new Error('Food database is missing or damaged');
  const keys = json.nutrientKeys;
  if (keys.join() !== NUTRIENT_KEYS.join()) throw new Error('Food database was built for a different app version');
  return json.foods.map((f) => ({ ...f, n: unpackNutrients(f.n) }));
}

export function mergeFoods(base, { customFoods = [], productCache = {}, offPack = [] } = {}) {
  const map = new Map();
  for (const f of base) map.set(f.id, f);
  for (const f of offPack) map.set(f.id, f);
  for (const f of Object.values(productCache)) map.set(f.id, f);
  for (const f of customFoods) map.set(f.id, f);
  return map;
}
