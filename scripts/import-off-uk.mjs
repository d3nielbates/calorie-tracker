// Builds an offline pack of UK supermarket products from the Open Food Facts
// CSV export. Needs internet access to download the export first (~1 GB
// compressed), then:
//   node scripts/import-off-uk.mjs path/to/en.openfoodfacts.org.products.csv.gz [--clean]
// --clean drops products whose label data fails the sanity checks.
// Output: data/off-uk.json, which the app loads automatically if present.
import { createReadStream, writeFileSync, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOffCsvFilter } from '../src/importers/off-csv.js';
import { packNutrients } from '../src/importers/sr28.js';
import { NUTRIENT_KEYS } from '../src/nutrients.js';

export async function importOffCsv(path, { clean = false } = {}) {
  let input = createReadStream(path);
  if (path.endsWith('.gz')) input = input.pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });
  const { handle, stats } = createOffCsvFilter({ requireNoWarnings: clean });
  const foods = [];
  for await (const line of rl) {
    const f = handle(line);
    if (f) {
      foods.push({
        id: f.id, name: f.name, brand: f.brand, stores: f.stores, cat: f.cat, src: 'off',
        portions: f.portions, n: packNutrients(f.n), warnings: f.warnings.length ? f.warnings : undefined,
      });
    }
  }
  return { version: 1, nutrientKeys: NUTRIENT_KEYS, foods, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-off-uk.mjs <products.csv[.gz]> [--clean]');
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = await importOffCsv(file, { clean: process.argv.includes('--clean') });
  out.builtAt = new Date().toISOString().slice(0, 10);
  writeFileSync(join(root, 'data/off-uk.json'), JSON.stringify(out));
  const packsFile = join(root, 'data/packs.json');
  let packs = [];
  try { packs = JSON.parse(readFileSync(packsFile, 'utf8')); } catch { /* new file */ }
  if (!packs.includes('off-uk.json')) writeFileSync(packsFile, JSON.stringify([...packs, 'off-uk.json']));
  console.log('Import report:', out.stats);
}
