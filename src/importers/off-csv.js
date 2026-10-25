// Filter for the Open Food Facts CSV export
// (https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz).
// The export is tab-separated with a header row. This turns each UK row into
// an app food via the same normaliser used for the live API.

import { normaliseOffProduct } from './off.js';

const UK_MARKERS = ['en:united-kingdom', 'united kingdom', 'royaume-uni'];

export function isUkRow(row) {
  const tags = `${row.countries_tags ?? ''},${row.countries_en ?? ''},${row.countries ?? ''}`.toLowerCase();
  return UK_MARKERS.some((m) => tags.includes(m));
}

export function rowToProduct(row) {
  const nutriments = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_100g') && v !== '') nutriments[k] = v;
  }
  return {
    code: row.code,
    product_name: row.product_name,
    product_name_en: row.product_name_en,
    brands: row.brands,
    stores: row.stores,
    quantity: row.quantity,
    serving_size: row.serving_size,
    serving_quantity: row.serving_quantity,
    image_front_small_url: row.image_small_url || row.image_front_small_url,
    nutriments,
  };
}

/**
 * Returns a line handler. Call it with each line (header first). It returns
 * a normalised food for usable UK rows, otherwise null. `stats` counts why
 * rows were skipped, for an honest import report.
 */
export function createOffCsvFilter({ requireNoWarnings = false } = {}) {
  let header = null;
  const seen = new Set();
  const stats = { rows: 0, uk: 0, kept: 0, noEnergyOrName: 0, flagged: 0, duplicate: 0, malformed: 0 };
  function handle(line) {
    if (header === null) {
      header = line.replace(/\r$/, '').split('\t');
      if (!header.includes('code') || !header.includes('product_name')) {
        throw new Error('This does not look like the Open Food Facts CSV export (no code/product_name columns)');
      }
      return null;
    }
    if (!line.trim()) return null;
    stats.rows += 1;
    const cells = line.replace(/\r$/, '').split('\t');
    if (cells.length !== header.length) { stats.malformed += 1; return null; }
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    if (!isUkRow(row)) return null;
    stats.uk += 1;
    const food = normaliseOffProduct(rowToProduct(row));
    if (!food) { stats.noEnergyOrName += 1; return null; }
    if (food.warnings.length) {
      stats.flagged += 1;
      if (requireNoWarnings) return null;
    }
    if (seen.has(food.id)) { stats.duplicate += 1; return null; }
    seen.add(food.id);
    stats.kept += 1;
    return food;
  }
  return { handle, stats };
}
