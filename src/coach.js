// Meal coach: turns what someone says about food ("she hates mushrooms and
// won't eat fish, but likes chicken") into changes to the planner options.
//
// Two ways in: `localCoach` understands plain sentences with no network (it
// matches food names, common groups like "fish" or "red meat", and simple
// negatives). `coachPrompt` + `parseCoachReply` let a language model do the
// reading where one is available; its answer is validated against the real
// food and meal ids before anything changes.

import { PREP_SLOTS } from './planner.js';

const bare = (id) => id.replace(/^uk:/, '');
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : w.length > 4 && w.endsWith('oes') ? w.slice(0, -2)
    : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(stem);
const GENERIC = new Set(['fillet', 'cooked', 'raw', 'tin', 'tinned', 'mix', 'drink', 'sauce', 'oil', 'dried', 'dry', 'light', 'low', 'fat', 'free', 'plain', 'whole', 'style', 'baked', 'boiled', 'frozen', 'fresh', 'sliced', 'bar', 'pot']);

const CATEGORY_NOUNS = new Set(['cheese', 'yogurt', 'milk', 'fillet', 'breast', 'thigh', 'mince', 'drink', 'steak', 'chop', 'loin']);

// Groups people often name. Each maps to a test on a food.
const nameHas = (re) => (f) => re.test(f.name.toLowerCase());
const GROUPS = [
  { terms: ['fish', 'oily fish', 'white fish'], test: (f) => f.tags.includes('fish') },
  { terms: ['seafood', 'shellfish', 'sea food'], test: (f) => f.tags.includes('shellfish') || f.tags.includes('fish') },
  { terms: ['meat'], test: (f) => f.tags.includes('meat') && !/stock/.test(f.id) },
  { terms: ['red meat'], test: (f) => /beef|lamb|pork|bacon|ham-|sirloin/.test(f.id) },
  { terms: ['pork', 'pig'], test: (f) => /pork|bacon|ham|sausage-pork/.test(f.id) },
  { terms: ['beef', 'steak'], test: (f) => /beef|sirloin/.test(f.id) },
  { terms: ['poultry'], test: (f) => /chicken|turkey/.test(f.id) && f.tags.includes('meat') && !/stock/.test(f.id) },
  { terms: ['chicken'], test: (f) => /^(uk:)?chicken-(breast|thigh)/.test(f.id) },
  { terms: ['turkey'], test: (f) => /turkey/.test(f.id) },
  { terms: ['dairy', 'lactose'], test: (f) => f.tags.includes('dairy') },
  { terms: ['cheese'], test: nameHas(/cheese|cheddar|feta|parmesan|mozzarella|ricotta|cottage/) },
  { terms: ['yogurt', 'yoghurt'], test: nameHas(/yog/) },
  { terms: ['egg'], test: (f) => /^(uk:)?egg(-boiled|-scrambled|-white)?$/.test(f.id) },
  { terms: ['nut', 'tree nut'], test: (f) => f.tags.includes('nuts') || f.tags.includes('peanut') },
  { terms: ['seed'], test: (f) => /chia|flaxseed|pumpkin-seeds|sunflower-seeds|tahini/.test(f.id) },
  { terms: ['bean', 'pulse', 'legume'], test: (f) => f.cat === 'Beans, pulses & tofu' && !/tofu|tempeh|veggie|hummus|edamame/.test(f.id) },
  { terms: ['lentil', 'dal', 'dhal'], test: (f) => /lentil/.test(f.id) },
  { terms: ['soya', 'soy', 'tofu'], test: (f) => f.tags.includes('soy') && f.id !== 'uk:soy-sauce' },
  { terms: ['spicy', 'spice', 'hot food', 'curry'], test: (f) => /chilli|curry-powder|salsa/.test(f.id) },
  { terms: ['berry', 'berries'], test: nameHas(/berr/) },
  { terms: ['pasta', 'spaghetti'], test: (f) => /pasta/.test(f.id) },
  { terms: ['rice'], test: (f) => /^(uk:)?rice-(white|brown)/.test(f.id) },
  { terms: ['noodle'], test: (f) => /noodle/.test(f.id) },
  { terms: ['potato', 'spud'], test: (f) => /^(uk:)?(potato|mash|chips)/.test(f.id) },
  { terms: ['bread', 'toast', 'sandwich'], test: (f) => f.cat === 'Bread & cereals' && /bread|wrap|pitta|bagel|muffin|naan/.test(f.id) },
  { terms: ['cereal'], test: (f) => /weetabix|shredded|cornflakes|krispies|muesli|granola/.test(f.id) },
  { terms: ['oat', 'porridge'], test: (f) => f.tags.includes('oats') },
  { terms: ['salad', 'leaf', 'leafy'], test: (f) => /lettuce|rocket|spinach-raw/.test(f.id) },
  { terms: ['coconut'], test: (f) => /coconut/.test(f.id) },
  { terms: ['mayo', 'mayonnaise'], test: (f) => /mayo/.test(f.id) },
];

const NEG = /\b(no|not|dont|doesnt|wont|cant|cannot|never|hate|hates|hated|dislike|dislikes|disliked|detest|detests|avoid|avoids|allergic|intolerant|without|yuck|gross|ban|remove|stop|off|less|isnt|aint|refuse|refuses)\b/;
const POS = /\b(like|likes|love|loves|enjoy|enjoys|fine|ok|okay|eat|eats|add|more|actually|does|will|happy|prefer|prefers|want|wants)\b/;

/** Build the vocabulary once: [{ id, name, terms: string[][] }] for the given food ids. */
export function buildVocab(foodIds, foods) {
  const vocab = [];
  for (const id of foodIds) {
    const f = foods.get(id);
    if (!f) continue;
    const main = f.name.split(/[,(]/)[0].split(/ (?:in|with|and) /)[0];
    const terms = new Set([words(main).join(' ')]);
    const mw = words(main).filter((w) => !GENERIC.has(w));
    if (mw.length > 1 && mw[mw.length - 1].length >= 4) terms.add(mw[mw.length - 1]);
    // "Feta cheese", "Salmon fillet": the first word names the food on its own.
    const all = words(main);
    if (all.length === 2 && CATEGORY_NOUNS.has(all[1]) && all[0].length >= 4) terms.add(all[0]);
    for (const a of f.aliases ?? []) if (a.length >= 3) terms.add(words(a).join(' '));
    for (const g of GROUPS) if (g.test(f)) for (const t of g.terms) terms.add(words(t).join(' '));
    vocab.push({ id, name: f.name, terms: [...terms].filter(Boolean).map((t) => t.split(' ')) });
  }
  return vocab;
}

// Longer phrases win: in "cottage cheese", the words are used up by cottage
// cheese and don't also match every other cheese.
function matchFoods(ws, vocab) {
  const used = new Array(ws.length).fill(false);
  const hits = new Set();
  const maxLen = Math.max(1, ...vocab.flatMap((v) => v.terms.map((t) => t.length)));
  for (let len = maxLen; len >= 1; len--) {
    const claim = [];
    for (const v of vocab) {
      for (const t of v.terms) {
        if (t.length !== len) continue;
        for (let i = 0; i + len <= ws.length; i++) {
          let ok = true;
          for (let j = 0; j < len && ok; j++) ok = !used[i + j] && ws[i + j] === t[j];
          if (ok) { hits.add(v); claim.push([i, len]); }
        }
      }
    }
    for (const [i, l] of claim) for (let j = 0; j < l; j++) used[i + j] = true;
  }
  return [...hits];
}

function hasPhrase(ws, phrase) {
  outer: for (let i = 0; i + phrase.length <= ws.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (ws[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Read a message and return { dislikeFoods, allowFoods, dislikeMeals, prep, reply }.
 * Each sentence part is read as a dislike unless it only says something
 * positive ("she likes chicken"), in which case those foods are allowed again.
 */
export function localCoach(text, { vocab, meals = [] }) {
  const out = { dislikeFoods: new Set(), allowFoods: new Set(), dislikeMeals: new Set(), prep: {} };
  const lower = String(text ?? '').toLowerCase();
  // Meal prep requests.
  const undo = /\b(not|dont|no longer|stop)\b[^.]*\b(same|prep)|different (breakfast|lunch)|vary/.test(lower.replace(/[’']/g, ''));
  if (/same (breakfasts? and lunch|lunch(es)? and breakfast)|meal prep|batch cook/.test(lower)) {
    out.prep = { breakfast: !undo, lunch: !undo };
  } else {
    for (const slot of PREP_SLOTS) if (new RegExp(`(same|different) ${slot}`).test(lower)) out.prep[slot] = !undo;
  }
  const parts = lower.split(/[.;!?\n]+|\bbut\b|\bhowever\b|\bthough\b|\balthough\b|\bexcept\b|,\s*(?=she|he|they|i|we)\b/);
  let polarity = 'neg';
  for (const part of parts) {
    const ws = words(part);
    if (!ws.length) continue;
    const raw = part.replace(/[’']/g, '');
    if (NEG.test(raw)) polarity = 'neg';
    else if (POS.test(raw)) polarity = 'pos';
    const hits = matchFoods(ws, vocab);
    for (const h of hits) {
      if (polarity === 'neg') { out.dislikeFoods.add(h.id); out.allowFoods.delete(h.id); } else { out.allowFoods.add(h.id); out.dislikeFoods.delete(h.id); }
    }
    for (const m of meals) {
      if (hasPhrase(ws, words(m.name))) { if (polarity === 'neg') out.dislikeMeals.add(m.id); }
    }
  }
  return { dislikeFoods: [...out.dislikeFoods], allowFoods: [...out.allowFoods], dislikeMeals: [...out.dislikeMeals], prep: out.prep };
}

/** Apply coach changes to plan options, returning new options. */
export function applyCoachChanges(options, changes) {
  const dislikedFoods = new Set((options.dislikedFoods ?? []).map(bare));
  for (const id of changes.allowFoods ?? []) dislikedFoods.delete(bare(id));
  for (const id of changes.dislikeFoods ?? []) dislikedFoods.add(bare(id));
  const dislikedMeals = new Set(options.dislikedMeals ?? []);
  for (const id of changes.allowMeals ?? []) dislikedMeals.delete(id);
  for (const id of changes.dislikeMeals ?? []) dislikedMeals.add(id);
  const prep = { ...(options.prep ?? {}) };
  for (const slot of PREP_SLOTS) {
    const v = changes.prep?.[slot];
    if (v === true) prep[slot] = typeof prep[slot] === 'string' ? prep[slot] : 'auto';
    else if (v === false) prep[slot] = false;
  }
  return { ...options, dislikedFoods: [...dislikedFoods], dislikedMeals: [...dislikedMeals], prep };
}

/** Short summary of what changed, for showing to the person. */
export function describeChanges(changes, { foods, meals }) {
  const fname = (id) => foods.get(id.includes(':') ? id : `uk:${id}`)?.name ?? id;
  const mname = (id) => meals.find((m) => m.id === id)?.name ?? id;
  const lines = [];
  if (changes.dislikeFoods?.length) lines.push(`Won't plan: ${changes.dislikeFoods.map(fname).join(', ')}`);
  if (changes.allowFoods?.length) lines.push(`Allowed again: ${changes.allowFoods.map(fname).join(', ')}`);
  if (changes.dislikeMeals?.length) lines.push(`Meals dropped: ${changes.dislikeMeals.map(mname).join(', ')}`);
  if (changes.allowMeals?.length) lines.push(`Meals allowed again: ${changes.allowMeals.map(mname).join(', ')}`);
  for (const slot of PREP_SLOTS) {
    if (changes.prep?.[slot] === true) lines.push(`Same ${slot} every day`);
    if (changes.prep?.[slot] === false) lines.push(`Different ${slot} each day`);
  }
  return lines;
}

/** The prompt for a language model. Everything it needs is in the text. */
export function coachPrompt(message, { vocab, meals, options, history = [] }) {
  const disliked = (options.dislikedFoods ?? []).join(', ') || 'none';
  const dislikedMeals = (options.dislikedMeals ?? []).join(', ') || 'none';
  const recent = history.slice(-4).map((h) => `${h.role === 'user' ? 'Person' : 'Coach'}: ${h.text}`).join('\n');
  return `You are a friendly UK meal-planning coach inside a calorie tracker. The person tells you which foods or meals someone won't eat (or now will). Map what they say onto the app's ingredient ids and meal ids below, and reply briefly.

Rules:
- Only use ids from the lists. Include every ingredient the person's words cover (e.g. "fish" means every fish ingredient; "cheese" every cheese).
- If they say someone now likes or will eat something, put it in allowFoods / allowMeals.
- "Same breakfast/lunch every day" or "meal prep" sets prep.breakfast / prep.lunch to true; "different each day" sets false; otherwise leave prep values null.
- List words you couldn't match to any id in "unmatched".
- reply: one or two short, warm sentences in UK English saying what you changed. No medical claims.
- Answer with JSON only, no other text.

JSON shape: {"dislikeFoods":[],"allowFoods":[],"dislikeMeals":[],"allowMeals":[],"prep":{"breakfast":null,"lunch":null},"unmatched":[],"reply":""}

Currently disliked ingredients: ${disliked}
Currently disliked meals: ${dislikedMeals}

Ingredients (id: name):
${vocab.map((v) => `${bare(v.id)}: ${v.name}`).join('\n')}

Meals (id: name):
${meals.map((m) => `${m.id}: ${m.name}`).join('\n')}
${recent ? `\nRecent conversation:\n${recent}\n` : ''}
Person: ${message}`;
}

/** Validate a model's JSON answer; unknown ids are dropped. */
export function parseCoachReply(value, { vocab, meals }) {
  const v = typeof value === 'string' ? JSON.parse(value.replace(/^```(?:json)?|```$/g, '').trim()) : value;
  if (!v || typeof v !== 'object') throw new Error('Unexpected answer');
  const foodIds = new Set(vocab.map((x) => bare(x.id)));
  const mealIds = new Set(meals.map((m) => m.id));
  const list = (a, ok) => (Array.isArray(a) ? [...new Set(a.map((x) => bare(String(x))).filter((x) => ok.has(x)))] : []);
  const prep = {};
  for (const slot of PREP_SLOTS) if (typeof v.prep?.[slot] === 'boolean') prep[slot] = v.prep[slot];
  return {
    dislikeFoods: list(v.dislikeFoods, foodIds),
    allowFoods: list(v.allowFoods, foodIds),
    dislikeMeals: list(v.dislikeMeals, mealIds),
    allowMeals: list(v.allowMeals, mealIds),
    prep,
    unmatched: Array.isArray(v.unmatched) ? v.unmatched.map(String).slice(0, 10) : [],
    reply: typeof v.reply === 'string' ? v.reply.slice(0, 600) : '',
  };
}
