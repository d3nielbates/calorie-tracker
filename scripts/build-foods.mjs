// Builds data/foods.json from the vendored USDA SR28 files and the curated
// UK food list. Run with: node scripts/build-foods.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSR28, packNutrients, blendNutrients, EXCLUDED_GROUPS, GROUP_NAMES } from '../src/importers/sr28.js';
import { NUTRIENT_KEYS } from '../src/nutrients.js';
import { UK_FOODS } from '../data-src/uk-foods.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildFoods({ abbrevText, foodDesText, ukFoods }) {
  const sr = parseSR28({ abbrevText, foodDesText });
  const foods = [];
  const seen = new Set();
  for (const f of ukFoods) {
    if (seen.has(f.id)) throw new Error(`Duplicate curated id ${f.id}`);
    seen.add(f.id);
    const parts = typeof f.sr === 'string' ? [[f.sr, 1]] : f.sr;
    const resolved = parts.map(([ndb, w]) => {
      const food = sr.get(ndb);
      if (!food) throw new Error(`Curated food ${f.id} refers to unknown NDB ${ndb}`);
      return [food.n, w];
    });
    const n = resolved.length === 1 ? resolved[0][0] : blendNutrients(resolved);
    foods.push({
      id: `uk:${f.id}`, name: f.name, cat: f.cat, src: 'core', ref: parts.map(([x]) => x).join('+'),
      tags: f.tags, aliases: f.aliases, portions: f.portions, n: packNutrients(n),
    });
  }
  for (const food of sr.values()) {
    if (EXCLUDED_GROUPS.has(food.group)) continue;
    if (food.n.kcal == null) continue;
    foods.push({
      id: `sr:${food.ndb}`, name: food.name, cat: GROUP_NAMES[food.group] ?? 'Other', src: 'usda', ref: food.ndb,
      portions: food.portions, n: packNutrients(food.n),
    });
  }
  return { version: 1, nutrientKeys: NUTRIENT_KEYS, foods };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = buildFoods({
    abbrevText: readFileSync(join(root, 'vendor/sr28/ABBREV.txt'), 'latin1'),
    foodDesText: readFileSync(join(root, 'vendor/sr28/FOOD_DES.txt'), 'latin1'),
    ukFoods: UK_FOODS,
  });
  out.builtAt = new Date().toISOString().slice(0, 10);
  writeFileSync(join(root, 'data/foods.json'), JSON.stringify(out));
  const core = out.foods.filter((f) => f.src === 'core').length;
  console.log(`Wrote ${out.foods.length} foods (${core} curated UK, ${out.foods.length - core} USDA SR28)`);
}
