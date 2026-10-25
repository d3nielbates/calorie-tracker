// Food search across the local database (curated UK foods, USDA reference
// foods, your own foods and products you have used). UK words are mapped to
// the US names used in the USDA data, e.g. "courgette" also finds "zucchini".

export const UK_SYNONYMS = {
  courgette: ['zucchini'], courgettes: ['zucchini'], aubergine: ['eggplant'], coriander: ['cilantro', 'coriander'],
  rocket: ['arugula'], prawn: ['shrimp'], prawns: ['shrimp'], mince: ['ground'], minced: ['ground'],
  crisps: ['potato chips', 'chips'], crisp: ['chips'], chips: ['french fried', 'fries'], biscuit: ['cookies', 'cookie', 'crackers'],
  biscuits: ['cookies', 'crackers'], porridge: ['oats', 'oatmeal'], swede: ['rutabaga'], mangetout: ['edible-podded', 'snow'],
  beetroot: ['beets'], chickpea: ['garbanzo'], chickpeas: ['garbanzo'], sweets: ['candies'], fizzy: ['carbonated'],
  gammon: ['ham'], treacle: ['molasses'], wholemeal: ['whole-wheat', 'whole wheat'], yoghurt: ['yogurt'], houmous: ['hummus'],
  sultana: ['raisins'], sultanas: ['raisins'], tinned: ['canned'], semi: ['reduced fat'], skimmed: ['nonfat', 'skim'],
  jam: ['jams'], aubergines: ['eggplant'], spud: ['potato'], spuds: ['potatoes'], jacket: ['baked'], courgetti: ['zucchini'],
  scone: ['scones'], soya: ['soy'], rasher: ['bacon'], banger: ['sausage'], bangers: ['sausage'], squash: ['squash'],
  candyfloss: ['cotton candy'], lolly: ['candies'], lollies: ['ice pops'], tomatoe: ['tomato'], pud: ['pudding'],
};

export const UK_PHRASES = {
  'spring onion': 'scallions', 'spring onions': 'scallions', 'single cream': 'light cream', 'double cream': 'heavy cream',
  'icing sugar': 'powdered sugar', 'caster sugar': 'granulated sugar', 'jacket potato': 'baked potato', 'semi skimmed': 'reduced fat',
  'semi-skimmed': 'reduced fat', 'broad beans': 'fava beans', 'runner beans': 'snap beans', 'french beans': 'snap beans',
  'butter beans': 'lima beans', 'chip shop': 'french fried', 'kidney bean': 'kidney beans',
};

export function normalise(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9%\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn a query into groups of alternatives; every group must match. */
export function queryGroups(query) {
  const q = normalise(query);
  if (!q) return [];
  const groups = [];
  let rest = q;
  for (const [phrase, us] of Object.entries(UK_PHRASES)) {
    if (rest.includes(phrase)) {
      groups.push([phrase, us]);
      rest = rest.replace(phrase, ' ');
    }
  }
  for (const tok of rest.split(' ').filter(Boolean)) {
    groups.push([tok, ...(UK_SYNONYMS[tok] ?? [])]);
  }
  return groups;
}

export function buildIndex(foods) {
  return foods.map((f) => {
    const hay = normalise([f.name, ...(f.aliases ?? []), f.brand ?? ''].join(' '));
    return { food: f, hay, words: hay.split(' '), name: normalise(f.name) };
  });
}

const SRC_BONUS = { custom: 30, core: 25, off: 10, usda: 0 };

function altMatches(entry, alt) {
  if (alt.includes(' ')) return entry.hay.includes(alt);
  return entry.words.some((w) => w.startsWith(alt) || (alt.length >= 4 && w.replace(/-/g, '').startsWith(alt.replace(/-/g, ''))));
}

export function searchFoods(index, query, { limit = 40, recent = [] } = {}) {
  const groups = queryGroups(query);
  if (!groups.length) return [];
  const recentRank = new Map(recent.map((id, i) => [id, i]));
  const scored = [];
  for (const entry of index) {
    let ok = true;
    let score = SRC_BONUS[entry.food.src] ?? 0;
    for (const alts of groups) {
      const hit = alts.find((a) => altMatches(entry, a));
      if (!hit) { ok = false; break; }
      if (entry.name.startsWith(hit)) score += 12;
      else if (entry.name.includes(` ${hit}`) || entry.name.includes(hit)) score += 6;
      if (hit === alts[0]) score += 2;
    }
    if (!ok) continue;
    score -= Math.min(20, entry.name.length / 6); // prefer simpler names
    if (recentRank.has(entry.food.id)) score += 15 - Math.min(10, recentRank.get(entry.food.id));
    if (/\braw\b/.test(entry.name) && entry.food.src === 'usda') score += 1;
    scored.push({ score, food: entry.food });
  }
  scored.sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name));
  return scored.slice(0, limit).map((s) => s.food);
}
