// Open Food Facts (OFF) support: URL builders for the live API and a
// normaliser that turns an OFF product (from the API or the CSV export) into
// this app's food format. OFF data is crowd-sourced (ODbL licence), so every
// product is sanity-checked and flagged rather than trusted blindly.

import { sodiumMgToSaltG } from '../nutrients.js';

export const OFF_BASE = 'https://world.openfoodfacts.org';

// Supermarkets as OFF store tags. OFF builds tags from the free-text "stores"
// field, so coverage depends on contributors having filled it in.
export const UK_STORES = [
  { id: 'tesco', label: 'Tesco', tag: 'tesco' },
  { id: 'sainsburys', label: "Sainsbury's", tag: 'sainsbury-s' },
  { id: 'asda', label: 'Asda', tag: 'asda' },
  { id: 'morrisons', label: 'Morrisons', tag: 'morrisons' },
  { id: 'aldi', label: 'Aldi', tag: 'aldi' },
  { id: 'lidl', label: 'Lidl', tag: 'lidl' },
  { id: 'waitrose', label: 'Waitrose', tag: 'waitrose' },
  { id: 'ms', label: 'M&S', tag: 'marks-spencer' },
  { id: 'coop', label: 'Co-op', tag: 'co-op' },
  { id: 'iceland', label: 'Iceland', tag: 'iceland' },
];

export const OFF_FIELDS = [
  'code', 'product_name', 'product_name_en', 'brands', 'stores', 'quantity', 'serving_size',
  'serving_quantity', 'nutriments', 'image_front_small_url', 'countries_tags', 'nutrition_data_per',
];

export function buildSearchUrl({ query, storeTag, page = 1, pageSize = 24 }) {
  const p = new URLSearchParams({
    search_terms: query.trim(),
    search_simple: '1',
    action: 'process',
    json: '1',
    page: String(page),
    page_size: String(pageSize),
    sort_by: 'unique_scans_n',
    fields: OFF_FIELDS.join(','),
    tagtype_0: 'countries',
    tag_contains_0: 'contains',
    tag_0: 'en:united-kingdom',
  });
  if (storeTag) {
    p.set('tagtype_1', 'stores');
    p.set('tag_contains_1', 'contains');
    p.set('tag_1', storeTag);
  }
  return `${OFF_BASE}/cgi/search.pl?${p}`;
}

// Open Food Facts' newer search service (search-a-licious). Tried first; the
// legacy search above is the fallback.
export const OFF_SEARCH_BASE = 'https://search.openfoodfacts.org';

export function buildModernSearchUrl({ query, storeTag, page = 1, pageSize = 24 }) {
  const terms = query.trim().replace(/["\\]/g, ' ');
  let q = `${terms} countries_tags:"en:united-kingdom"`;
  if (storeTag) q += ` stores_tags:"${storeTag}"`;
  const p = new URLSearchParams({
    q,
    page: String(page),
    page_size: String(pageSize),
    fields: OFF_FIELDS.join(','),
    langs: 'en',
  });
  return `${OFF_SEARCH_BASE}/search?${p}`;
}

export function buildProductUrl(barcode) {
  const code = String(barcode).replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) throw new Error('A barcode should have 6 to 14 digits');
  return `${OFF_BASE}/api/v2/product/${code}.json?fields=${OFF_FIELDS.join(',')}`;
}

/** Check an EAN-13 / EAN-8 / UPC-A check digit. Unknown lengths pass. */
export function isValidBarcode(code) {
  const s = String(code);
  if (!/^\d+$/.test(s)) return false;
  if (![8, 12, 13, 14].includes(s.length)) return s.length >= 6 && s.length <= 14;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// OFF stores *_100g values in grams. Multiplier converts to our unit, and the
// cap rejects values that are almost certainly unit-entry mistakes.
const MICROS = {
  vitA: { keys: ['vitamin-a_100g'], mul: 1e6, cap: 30000 },
  thiamin: { keys: ['vitamin-b1_100g'], mul: 1e3, cap: 50 },
  riboflavin: { keys: ['vitamin-b2_100g'], mul: 1e3, cap: 50 },
  niacin: { keys: ['vitamin-pp_100g', 'vitamin-b3_100g'], mul: 1e3, cap: 300 },
  b6: { keys: ['vitamin-b6_100g'], mul: 1e3, cap: 50 },
  folate: { keys: ['vitamin-b9_100g', 'folates_100g'], mul: 1e6, cap: 5000 },
  b12: { keys: ['vitamin-b12_100g'], mul: 1e6, cap: 200 },
  vitC: { keys: ['vitamin-c_100g'], mul: 1e3, cap: 3000 },
  vitD: { keys: ['vitamin-d_100g'], mul: 1e6, cap: 250 },
  vitE: { keys: ['vitamin-e_100g'], mul: 1e3, cap: 300 },
  vitK: { keys: ['vitamin-k_100g'], mul: 1e6, cap: 5000 },
  calcium: { keys: ['calcium_100g'], mul: 1e3, cap: 3000 },
  iron: { keys: ['iron_100g'], mul: 1e3, cap: 100 },
  magnesium: { keys: ['magnesium_100g'], mul: 1e3, cap: 1500 },
  phosphorus: { keys: ['phosphorus_100g'], mul: 1e3, cap: 3000 },
  potassium: { keys: ['potassium_100g'], mul: 1e3, cap: 10000 },
  zinc: { keys: ['zinc_100g'], mul: 1e3, cap: 100 },
  copper: { keys: ['copper_100g'], mul: 1e3, cap: 30 },
  selenium: { keys: ['selenium_100g'], mul: 1e6, cap: 2000 },
};

const pick = (nm, keys) => {
  for (const k of keys) {
    const v = toNum(nm[k]);
    if (v != null) return v;
  }
  return null;
};

/**
 * Normalise an OFF product. Returns null if there is no usable name or energy.
 * `warnings` lists anything that looks wrong so the UI can show it.
 */
export function normaliseOffProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const text = (v) => (Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? Object.values(v)[0] ?? '' : v ?? '');
  const code = String(p.code ?? '').trim();
  const name = String(text(p.product_name_en) || text(p.product_name) || '').trim();
  if (!code || !name) return null;
  const nm = p.nutriments || {};
  const warnings = [];

  // Values on OFF can be "as sold" per 100 g, or (rarely) only per serving.
  let kcal = pick(nm, ['energy-kcal_100g']);
  if (kcal == null) {
    const kj = pick(nm, ['energy-kj_100g', 'energy_100g']);
    if (kj != null) kcal = kj / 4.184;
  }
  if (kcal == null) return null;
  if (kcal > 900) return null; // pure fat is ~900 kcal/100 g, so this is an error

  const n = {
    kcal,
    protein: pick(nm, ['proteins_100g']),
    carbs: pick(nm, ['carbohydrates_100g']),
    sugars: pick(nm, ['sugars_100g']),
    fat: pick(nm, ['fat_100g']),
    satfat: pick(nm, ['saturated-fat_100g']),
    fibre: pick(nm, ['fiber_100g']),
    salt: pick(nm, ['salt_100g']),
  };
  if (n.salt == null) {
    const sodiumG = pick(nm, ['sodium_100g']);
    if (sodiumG != null) n.salt = sodiumMgToSaltG(sodiumG * 1000);
  }
  for (const [key, def] of Object.entries(MICROS)) {
    const v = pick(nm, def.keys);
    if (v == null) { n[key] = null; continue; }
    const converted = v * def.mul;
    if (converted > def.cap) {
      n[key] = null;
      warnings.push(`Ignored an implausible ${key} value`);
    } else n[key] = converted;
  }

  // Internal consistency checks.
  const grams = ['protein', 'carbs', 'fat', 'fibre', 'salt'].reduce((s, k) => s + (n[k] ?? 0), 0);
  if (grams > 105) warnings.push('Macros add up to more than 100 g per 100 g');
  if (n.sugars != null && n.carbs != null && n.sugars > n.carbs + 0.5) warnings.push('Sugars are higher than total carbohydrate');
  if (n.satfat != null && n.fat != null && n.satfat > n.fat + 0.5) warnings.push('Saturates are higher than total fat');
  if (n.protein != null && n.carbs != null && n.fat != null) {
    const est = 4 * n.protein + 4 * n.carbs + 9 * n.fat + 2 * (n.fibre ?? 0);
    if (Math.abs(est - kcal) > Math.max(40, 0.25 * kcal)) warnings.push('Calories do not match the macros on the label');
  } else {
    warnings.push('Some macronutrients are missing');
  }

  const portions = [];
  const sq = toNum(p.serving_quantity);
  if (sq && sq > 0 && sq < 5000) portions.push([`Serving${p.serving_size ? ` (${String(p.serving_size).trim()})` : ` (${sq} g)`}`, sq]);
  const packG = parseQuantityGrams(p.quantity);
  if (packG && (!sq || Math.abs(packG - sq) > 1)) portions.push([`Whole pack (${p.quantity})`, packG]);

  return {
    id: `off:${code}`,
    code,
    name,
    brand: String(text(p.brands)).split(',')[0].trim(),
    stores: String(text(p.stores)).trim(),
    cat: 'UK product',
    src: 'off',
    image: p.image_front_small_url || null,
    portions,
    n,
    warnings,
  };
}

/** Parse quantities like "400 g", "1.5kg", "500ml", "4 x 125 g". */
export function parseQuantityGrams(q) {
  if (!q) return null;
  const s = String(q).toLowerCase().replace(',', '.');
  const multi = s.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/);
  if (multi) return Number(multi[1]) * unitToG(Number(multi[2]), multi[3]);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/);
  return m ? unitToG(Number(m[1]), m[2]) : null;
}

function unitToG(v, unit) {
  switch (unit) {
    case 'kg': case 'l': return v * 1000;
    case 'cl': return v * 10;
    default: return v;
  }
}

/** Normalise a search response; drops unusable products, keeps order. */
export function normaliseSearchResponse(json) {
  const products = Array.isArray(json?.products) ? json.products : [];
  const out = [];
  const seen = new Set();
  for (const p of products) {
    const f = normaliseOffProduct(p);
    if (f && !seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
    }
  }
  return { foods: out, total: Number(json?.count) || out.length };
}

/** Normalise a response from the newer search service (products under `hits`). */
export function normaliseModernSearchResponse(json) {
  if (!json || !Array.isArray(json.hits)) throw new Error('Unexpected response from Open Food Facts search');
  const { foods } = normaliseSearchResponse({ products: json.hits });
  return { foods, total: Number(json.count) || foods.length };
}

/** Normalise a single-product response from /api/v2/product. */
export function normaliseProductResponse(json) {
  if (!json || json.status !== 1 || !json.product) return null;
  return normaliseOffProduct({ code: json.code, ...json.product });
}
