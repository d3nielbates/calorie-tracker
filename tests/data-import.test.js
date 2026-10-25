import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitCaretLine, abbrevRowToNutrients, parseSR28, blendNutrients, packNutrients, unpackNutrients, EXCLUDED_GROUPS } from '../src/importers/sr28.js';
import { buildModernSearchUrl, normaliseModernSearchResponse, normaliseOffProduct, normaliseSearchResponse, normaliseProductResponse, parseQuantityGrams, isValidBarcode, buildSearchUrl, buildProductUrl } from '../src/importers/off.js';
import { createOffCsvFilter, isUkRow } from '../src/importers/off-csv.js';
import { importOffCsv } from '../scripts/import-off-uk.mjs';
import { buildFoods } from '../scripts/build-foods.mjs';
import { UK_FOODS } from '../data-src/uk-foods.mjs';
import { NUTRIENT_KEYS } from '../src/nutrients.js';
import { unpackDatabase } from '../src/fooddb.js';

const root = new URL('..', import.meta.url).pathname;
const abbrevText = readFileSync(join(root, 'vendor/sr28/ABBREV.txt'), 'latin1');
const foodDesText = readFileSync(join(root, 'vendor/sr28/FOOD_DES.txt'), 'latin1');
const BUTTER = '~01001~^~BUTTER,WITH SALT~^15.87^717^0.85^81.11^2.11^0.06^0.0^0.06^24^0.02^2^24^24^643^0.09^0.000^0.000^1.0^0.0^0.005^0.034^0.042^0.110^0.003^3^0^3^3^18.8^0.17^2499^684^671^0^158^0^0^0^2.32^0.0^0^7.0^51.368^21.021^3.043^215^5.0^~1 pat,  (1" sq, 1/3" high)~^14.2^~1 tbsp~^0\r';

// ---------- USDA SR28 ----------

test('SR28 row parsing maps columns correctly (butter)', () => {
  const r = abbrevRowToNutrients(splitCaretLine(BUTTER));
  assert.equal(r.ndb, '01001');
  assert.equal(r.n.kcal, 717);
  assert.equal(r.n.fat, 81.11);
  assert.equal(r.n.satfat, 51.368);
  assert.equal(r.n.calcium, 24);
  assert.equal(r.n.vitA, 684);
  assert.equal(r.n.vitE, 2.32);
  assert.equal(r.n.vitK, 7);
  assert.equal(r.n.b12, 0.17);
  assert.ok(Math.abs(r.n.salt - 1.6075) < 1e-9, 'sodium 643 mg = 1.61 g salt');
  assert.deepEqual(r.portions, [['1 pat,  (1" sq, 1/3" high)', 5], ['1 tbsp', 14.2]]);
});

test('SR28 carbohydrate is converted to the UK basis (fibre excluded, never below sugars)', () => {
  const apple = '~09003~^~APPLES,RAW,WITH SKIN~^85.56^52^0.26^0.17^0.19^13.81^2.4^10.39^6^0.12^5^11^107^1^0.04^0.027^0.035^0.0^4.6^0.017^0.026^0.091^0.061^0.041^3^0^3^3^3.4^0.00^54^3^0^0^27^11^0^29^0.18^0.0^0^2.2^0.028^0.007^0.051^0^125^~1 cup~^109^~1 cup~^10';
  const r = abbrevRowToNutrients(splitCaretLine(apple));
  assert.ok(Math.abs(r.n.carbs - (13.81 - 2.4)) < 1e-9);
  const milkish = '~99999~^~TEST~^88^50^3.3^2^0.7^4.8^0^5.06^120^0^11^92^140^47^0.4^0^0^2.5^0.2^0.04^0.17^0.09^0.36^0.04^5^0^5^5^16^0.5^0^0^0^0^0^0^0^0^0.03^0^0^0.2^1.2^0.5^0.07^8^244^~1 cup~^^^0';
  const m = abbrevRowToNutrients(splitCaretLine(milkish));
  assert.equal(m.n.carbs, 5.06);
});

test('SR28 blank fields stay missing, not zero', () => {
  const lemon = '~09523~^~LEMON JUC FROM CONC,BTLD,CONCORD~^93.96^24^0.40^0.07^0.19^5.37^^1.42^8^0.06^6^9^112^29^0.09^0.020^0.017^^0.0^0.020^0.017^0.197^0.060^0.037^4^^4^^^^^^^^^^^^^^^^^^^^15^~1 tbsp~^5.2^~1 tsp~^0';
  const r = abbrevRowToNutrients(splitCaretLine(lemon));
  assert.equal(r.n.fibre, null);
  assert.equal(r.n.selenium, null);
  assert.equal(r.n.vitA, null);
  assert.equal(r.n.satfat, null);
  assert.equal(r.n.carbs, 5.37, 'no fibre value, carbs left as is');
});

test('SR28 rejects short rows', () => {
  assert.throws(() => abbrevRowToNutrients(['01001', 'x', '1']), /expected 53/);
});

test('the full SR28 file parses and energy agrees with macros for nearly all foods', () => {
  const foods = parseSR28({ abbrevText, foodDesText });
  assert.equal(foods.size, 8789);
  let checked = 0;
  let close = 0;
  for (const f of foods.values()) {
    const { kcal, protein, fat, carbs, fibre } = f.n;
    if ([kcal, protein, fat, carbs].some((v) => v == null) || kcal < 20) continue;
    if (/alcohol|wine|beer|liqueur|spirits|whiskey|vodka|rum|gin\b/i.test(f.name)) continue;
    checked++;
    const est = 4 * protein + 4 * (carbs + (fibre ?? 0)) + 9 * fat;
    if (Math.abs(est - kcal) <= Math.max(25, 0.15 * kcal)) close++;
  }
  assert.ok(checked > 7500);
  assert.ok(close / checked > 0.97, `${close}/${checked} consistent`);
  for (const f of foods.values()) {
    for (const k of NUTRIENT_KEYS) {
      const v = f.n[k];
      assert.ok(v == null || (Number.isFinite(v) && v >= 0), `${f.ndb} ${k}=${v}`);
    }
    assert.ok(f.n.kcal == null || f.n.kcal <= 902, `${f.ndb} kcal ${f.n.kcal}`);
  }
});

test('blending and packing', () => {
  const b = blendNutrients([[{ kcal: 100, fat: 10, vitD: 1 }, 3], [{ kcal: 200, fat: 0, vitD: null }, 1]]);
  assert.equal(b.kcal, 125);
  assert.equal(b.fat, 7.5);
  assert.equal(b.vitD, null, 'missing in one part means unknown');
  assert.throws(() => blendNutrients([[{}, 0]]));
  const n = Object.fromEntries(NUTRIENT_KEYS.map((k, i) => [k, i % 3 ? i * 1.23456 : null]));
  const back = unpackNutrients(packNutrients(n));
  for (const k of NUTRIENT_KEYS) assert.ok(n[k] == null ? back[k] == null : Math.abs(back[k] - n[k]) < 0.001);
});

test('food database build: curated UK foods resolve, values are right', () => {
  const db = buildFoods({ abbrevText, foodDesText, ukFoods: UK_FOODS });
  const foods = unpackDatabase(db);
  const byId = new Map(foods.map((f) => [f.id, f]));
  assert.equal(byId.size, foods.length, 'ids are unique');
  const core = foods.filter((f) => f.src === 'core');
  assert.equal(core.length, UK_FOODS.length);
  for (const f of core) {
    assert.ok(f.portions.length > 0, `${f.id} has portions`);
    assert.ok(f.n.kcal != null && f.n.protein != null && f.n.fat != null && f.n.carbs != null, `${f.id} has macros`);
    for (const [label, g] of f.portions) assert.ok(label && g > 0 && g < 1000, `${f.id} portion ${label}`);
    for (const t of f.tags) assert.ok(['dairy', 'egg', 'meat', 'fish', 'shellfish', 'gluten', 'oats', 'nuts', 'peanut', 'soy', 'sesame', 'honey', 'alcohol'].includes(t), `${f.id} tag ${t}`);
  }
  const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
  close(byId.get('uk:apple').n.kcal, 52, 0.01);
  close(byId.get('uk:butter').n.kcal, 717, 0.01);
  close(byId.get('uk:chicken-breast-cooked').n.protein, 31.02, 0.01);
  const semi = byId.get('uk:milk-semi').n;
  assert.ok(semi.fat > 1.5 && semi.fat < 1.9, `semi-skimmed fat ${semi.fat}`); // UK: 1.5-1.8%
  assert.ok(semi.kcal > 44 && semi.kcal < 50);
  assert.ok(semi.vitD < 0.2, 'UK milk is not fortified with vitamin D');
  close(byId.get('uk:porridge-oats').n.kcal, 379, 1);
  // Excluded US-only groups are gone
  const sr = parseSR28({ abbrevText, foodDesText });
  for (const f of foods.filter((x) => x.src === 'usda')) assert.ok(!EXCLUDED_GROUPS.has(sr.get(f.ref).group));
});

test('bundled data/foods.json matches a fresh build', () => {
  const bundled = JSON.parse(readFileSync(join(root, 'data/foods.json'), 'utf8'));
  const fresh = buildFoods({ abbrevText, foodDesText, ukFoods: UK_FOODS });
  assert.equal(bundled.foods.length, fresh.foods.length, 'run npm run build:foods');
  assert.deepEqual(bundled.foods.slice(0, UK_FOODS.length), fresh.foods.slice(0, UK_FOODS.length));
});

test('build fails loudly on a bad curated reference', () => {
  assert.throws(() => buildFoods({ abbrevText, foodDesText, ukFoods: [{ id: 'x', sr: '00000', name: 'X', cat: 'X', tags: [], aliases: [], portions: [] }] }), /unknown NDB/);
  assert.throws(() => buildFoods({ abbrevText, foodDesText, ukFoods: [UK_FOODS[0], UK_FOODS[0]] }), /Duplicate/);
});

// ---------- Open Food Facts ----------

const fixture = (n) => JSON.parse(readFileSync(join(root, 'tests/fixtures', n), 'utf8'));

test('OFF search response is normalised; unusable products dropped', () => {
  const { foods, total } = normaliseSearchResponse(fixture('off-search.json'));
  assert.equal(total, 3);
  assert.equal(foods.length, 2);
  const [houmous, reduced] = foods;
  assert.equal(houmous.id, 'off:5000119000000');
  assert.equal(houmous.brand, 'Tesco');
  assert.equal(houmous.n.kcal, 327);
  assert.equal(houmous.n.salt, 0.83);
  assert.deepEqual(houmous.portions, [['Serving (30 g)', 30], ['Whole pack (200 g)', 200]]);
  assert.deepEqual(houmous.warnings, []);
  assert.ok(Math.abs(reduced.n.kcal - 950 / 4.184) < 1e-9, 'kJ converted to kcal');
  assert.ok(Math.abs(reduced.n.salt - 0.75) < 1e-9, 'sodium 0.3 g = 0.75 g salt');
  assert.ok(Math.abs(reduced.n.iron - 2.1) < 1e-9, 'iron g to mg');
  assert.equal(reduced.n.vitC, null);
  assert.deepEqual(reduced.portions, [['Whole pack (4 x 50g)', 200]]);
});

test('OFF single product response, including vitamins', () => {
  const f = normaliseProductResponse(fixture('off-product.json'));
  assert.equal(f.code, '5010029000016');
  assert.equal(f.portions[0][1], 37.5);
  assert.ok(Math.abs(f.n.iron - 11.9) < 1e-9);
  assert.ok(Math.abs(f.n.thiamin - 0.91) < 1e-9);
  assert.ok(Math.abs(f.n.folate - 166) < 1e-6, 'folate g to µg');
  assert.equal(normaliseProductResponse({ status: 0 }), null);
  assert.equal(normaliseProductResponse(null), null);
});

test('OFF sanity checks flag or reject bad label data', () => {
  const p = (nutriments, extra = {}) => normaliseOffProduct({ code: '1', product_name: 'X', nutriments, ...extra });
  assert.equal(p({ 'energy-kcal_100g': 1500 }), null, 'over 900 kcal/100 g');
  assert.equal(p({}), null, 'no energy');
  assert.equal(normaliseOffProduct({ code: '1', nutriments: { 'energy-kcal_100g': 100 } }), null, 'no name');
  assert.equal(normaliseOffProduct({ product_name: 'x', nutriments: { 'energy-kcal_100g': 100 } }), null, 'no code');
  const mismatch = p({ 'energy-kcal_100g': 50, proteins_100g: 20, carbohydrates_100g: 50, fat_100g: 20 });
  assert.ok(mismatch.warnings.some((w) => /do not match/.test(w)));
  const sugars = p({ 'energy-kcal_100g': 100, proteins_100g: 1, carbohydrates_100g: 10, sugars_100g: 20, fat_100g: 5 });
  assert.ok(sugars.warnings.some((w) => /Sugars/.test(w)));
  const vit = p({ 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 15, fat_100g: 2, 'vitamin-c_100g': 12 });
  assert.equal(vit.n.vitC, null, '12 g vitamin C per 100 g is a unit mistake');
  assert.ok(vit.warnings.some((w) => /implausible/.test(w)));
  const neg = p({ 'energy-kcal_100g': 100, proteins_100g: -5, carbohydrates_100g: '12,5', fat_100g: 1 });
  assert.equal(neg.n.protein, null);
  assert.equal(neg.n.carbs, 12.5, 'comma decimals accepted');
  assert.equal(p({ 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 15, fat_100g: 2 }, { product_name_en: 'English name' }).name, 'English name');
});

test('quantity and barcode parsing', () => {
  assert.equal(parseQuantityGrams('400 g'), 400);
  assert.equal(parseQuantityGrams('1.5kg'), 1500);
  assert.equal(parseQuantityGrams('500ml'), 500);
  assert.equal(parseQuantityGrams('4 x 125 g'), 500);
  assert.equal(parseQuantityGrams('33cl'), 330);
  assert.equal(parseQuantityGrams('2 l'), 2000);
  assert.equal(parseQuantityGrams('6 eggs'), null);
  assert.equal(parseQuantityGrams(''), null);
  assert.equal(isValidBarcode('5010029000016'), true);
  assert.equal(isValidBarcode('5010029000017'), false);
  assert.equal(isValidBarcode('96385074'), true); // EAN-8
  assert.equal(isValidBarcode('036000291452'), true); // UPC-A
  assert.equal(isValidBarcode('abc'), false);
});

test('OFF URLs filter to the UK and optional store', () => {
  const u = new URL(buildSearchUrl({ query: ' greek yogurt ', storeTag: 'tesco' }));
  assert.equal(u.origin, 'https://world.openfoodfacts.org');
  assert.equal(u.searchParams.get('search_terms'), 'greek yogurt');
  assert.equal(u.searchParams.get('tag_0'), 'en:united-kingdom');
  assert.equal(u.searchParams.get('tagtype_1'), 'stores');
  assert.equal(u.searchParams.get('tag_1'), 'tesco');
  assert.equal(new URL(buildSearchUrl({ query: 'x' })).searchParams.get('tagtype_1'), null);
  assert.match(buildProductUrl('5010029000016'), /\/api\/v2\/product\/5010029000016\.json/);
  assert.throws(() => buildProductUrl('12'), /6 to 14 digits/);
});

// ---------- Open Food Facts CSV export ----------

const HEADER = ['code', 'product_name', 'brands', 'stores', 'countries_tags', 'quantity', 'serving_size', 'serving_quantity', 'energy-kcal_100g', 'energy_100g', 'fat_100g', 'saturated-fat_100g', 'carbohydrates_100g', 'sugars_100g', 'fiber_100g', 'proteins_100g', 'salt_100g', 'calcium_100g'];
const row = (o) => HEADER.map((h) => o[h] ?? '').join('\t');
const CSV = [
  HEADER.join('\t'),
  row({ code: '111', product_name: 'Tesco Baked Beans', brands: 'Tesco', stores: 'Tesco', countries_tags: 'en:united-kingdom', quantity: '420 g', 'energy-kcal_100g': '78', fat_100g: '0.3', 'saturated-fat_100g': '0.1', carbohydrates_100g: '12.9', sugars_100g: '4.7', fiber_100g: '4', proteins_100g: '4.6', salt_100g: '0.6', calcium_100g: '0.04' }),
  row({ code: '222', product_name: 'Haricots', countries_tags: 'en:france', 'energy-kcal_100g': '80', proteins_100g: '5', carbohydrates_100g: '13', fat_100g: '0.5' }),
  row({ code: '333', product_name: 'No energy', countries_tags: 'en:united-kingdom,en:ireland' }),
  row({ code: '111', product_name: 'Tesco Baked Beans dup', countries_tags: 'en:united-kingdom', 'energy-kcal_100g': '78', proteins_100g: '4.6', carbohydrates_100g: '12.9', fat_100g: '0.3' }),
  row({ code: '444', product_name: 'Bad label', countries_tags: 'en:united-kingdom', 'energy-kcal_100g': '20', proteins_100g: '30', carbohydrates_100g: '30', fat_100g: '30' }),
  'short\trow',
  '',
].join('\n');

test('OFF CSV filter keeps UK rows only and reports why rows were skipped', () => {
  const { handle, stats } = createOffCsvFilter();
  const kept = CSV.split('\n').map(handle).filter(Boolean);
  assert.deepEqual(kept.map((f) => f.code), ['111', '444']);
  assert.equal(kept[0].n.kcal, 78);
  assert.ok(Math.abs(kept[0].n.calcium - 40) < 1e-9);
  assert.equal(kept[0].portions[0][1], 420);
  assert.deepEqual(stats, { rows: 6, uk: 4, kept: 2, noEnergyOrName: 1, flagged: 1, duplicate: 1, malformed: 1 });
  const strict = createOffCsvFilter({ requireNoWarnings: true });
  assert.deepEqual(CSV.split('\n').map(strict.handle).filter(Boolean).map((f) => f.code), ['111']);
});

test('OFF CSV filter rejects files that are not the OFF export', () => {
  const { handle } = createOffCsvFilter();
  assert.throws(() => handle('a\tb\tc'), /does not look like/);
  assert.equal(isUkRow({ countries_en: 'United Kingdom' }), true);
  assert.equal(isUkRow({ countries_tags: 'en:germany' }), false);
});

test('OFF import script reads a gzipped export end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'off-'));
  const file = join(dir, 'products.csv.gz');
  writeFileSync(file, gzipSync(CSV));
  const out = await importOffCsv(file);
  assert.equal(out.foods.length, 2);
  assert.equal(out.stats.kept, 2);
  const unpacked = unpackDatabase(out);
  assert.equal(unpacked[0].n.kcal, 78);
  assert.equal(unpacked[0].src, 'off');
  const clean = await importOffCsv(file, { clean: true });
  assert.equal(clean.foods.length, 1);
});

test('unpackDatabase rejects mismatched files', () => {
  assert.throws(() => unpackDatabase(null), /missing/);
  assert.throws(() => unpackDatabase({ foods: [], nutrientKeys: ['kcal'] }), /different app version/);
});

test('newer OFF search service: URL and response handling', () => {
  const u = new URL(buildModernSearchUrl({ query: 'greek "yogurt"', storeTag: 'tesco' }));
  assert.equal(u.origin, 'https://search.openfoodfacts.org');
  assert.equal(u.searchParams.get('q'), 'greek  yogurt  countries_tags:"en:united-kingdom" stores_tags:"tesco"');
  const r = normaliseModernSearchResponse({
    count: 2,
    hits: [
      { code: '5000119000000', product_name: 'Classic Houmous', brands: ['Tesco'], stores: ['Tesco', 'Asda'], serving_quantity: 30, nutriments: { 'energy-kcal_100g': 327, proteins_100g: 7.1, carbohydrates_100g: 7.6, fat_100g: 29.5, fiber_100g: 5.4 } },
      { code: '1', product_name: 'No data', nutriments: {} },
    ],
  });
  assert.equal(r.total, 2);
  assert.equal(r.foods.length, 1);
  assert.equal(r.foods[0].brand, 'Tesco');
  assert.equal(r.foods[0].stores, 'Tesco, Asda');
  assert.throws(() => normaliseModernSearchResponse({ error: 'x' }), /Unexpected/);
});
