// UI for the tracker. Plain ES modules, no build step: open index.html via any
// static web server. All logic that needs testing lives in the other modules.

import { NUTRIENTS, NUTRIENT_BY_KEY, MICRO_KEYS, nutrientsForGrams, sumNutrients, round } from './nutrients.js';
import { computeTargets, assessIntake, ACTIVITY_LEVELS, LOSS_RATES, SAFETY } from './targets.js';
import { MEALS } from './meals.js';
import {
  planWeek, alternativesForSlot, replaceMeal, shoppingList, cleanPlan, prepBatches, rankPrepMeals, mealAllowed, mealIngredients,
  SLOTS, SLOT_LABELS, DIETS, EXCLUSIONS, PREP_SLOTS,
} from './planner.js';
import { costShoppingList, formatPounds, SHOPS, PRICES_AS_OF } from './prices.js';
import { buildVocab, localCoach, applyCoachChanges, describeChanges, coachPrompt, parseCoachReply } from './coach.js';
import { searchFoods, buildIndex } from './search.js';
import { buildSearchUrl, buildModernSearchUrl, normaliseModernSearchResponse, buildProductUrl, normaliseSearchResponse, normaliseProductResponse, UK_STORES, isValidBarcode } from './importers/off.js';
import { unpackDatabase, mergeFoods } from './fooddb.js';
import { progressSummary } from './trend.js';
import {
  loadState, saveState, exportState, importState, emptyState, makeEntry, addEntry, updateEntry, removeEntry,
  setWeight, removeWeight, currentWeight, makeCustomFood,
} from './store.js';
import { changedDocIds, stamp, mergeRemote, createCloudSync, dayDocId } from './cloud.js';
import { localDateStr, addDays, parseLocalDate, formatWeight, kgToStLb, stLbToKg, cmToFtIn, ftInToCm } from './units.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, dp = 0) => (v == null || !Number.isFinite(v) ? '–' : round(v, dp).toLocaleString('en-GB', { maximumFractionDigits: dp }));
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

let storage;
try { storage = window.localStorage; } catch { storage = null; }
const memoryStorage = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
const loaded = loadState(storage ?? memoryStorage);
let S = loaded.state;
let baseFoods = [];
let offPack = [];
let foods = new Map();
let index = [];
let indexDirty = true;
let currentDate = localDateStr();
let lastOffSearch = 0;
// Inside a claude.ai Artifact the page can't reach other websites, start
// downloads itself or show confirm() dialogs, and browser storage may be
// cleared, so it saves to the viewer's private account storage instead.
const inArtifact = typeof window.claude?.use === 'function';
let cloud = null;
let downloads = null;

function rebuildFoods() {
  foods = mergeFoods(baseFoods, { customFoods: S.customFoods, productCache: S.productCache, offPack });
  indexDirty = true;
}

function getIndex() {
  if (indexDirty) { index = buildIndex([...foods.values()]); indexDirty = false; }
  return index;
}

function commit(next, { rerender = true } = {}) {
  const foodsChanged = next.customFoods !== S.customFoods || next.productCache !== S.productCache;
  const changed = changedDocIds(S, next);
  S = stamp(next, changed);
  if (cloud && changed.length) cloud.queue(changed);
  const err = saveState(storage ?? memoryStorage, S);
  if (err) toast(err);
  if (foodsChanged) rebuildFoods();
  if (rerender) render();
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function getTargets() {
  if (!S.profile) return null;
  const t = computeTargets({ ...S.profile, weightKg: currentWeight(S) });
  return t.ok ? t : null;
}

// ---------- Rendering helpers ----------

function bar(pct, status) {
  const w = Math.max(0, Math.min(100, pct * 100));
  return `<div class="bar ${status === 'high' ? 'high' : status === 'low' ? 'low' : ''}"><span style="width:${w.toFixed(1)}%"></span></div>`;
}

function nutRow(key, a) {
  const def = NUTRIENT_BY_KEY[key];
  const goal = a.max != null ? `max ${fmt(a.max, def.dp > 1 ? 1 : 0)}` : fmt(a.target, def.dp > 1 ? 1 : 0);
  return `<div class="nut"><div class="spread"><span>${esc(def.label)}</span><span class="muted">${fmt(a.value, def.dp > 1 ? 1 : def.dp)} / ${goal} ${esc(def.unit)}</span></div>${bar(a.pct, a.status)}</div>`;
}

function weightInputHtml(name, kg) {
  if (S.settings.weightUnit === 'stlb') {
    const v = kg != null ? kgToStLb(kg) : { st: '', lb: '' };
    return `<div class="row"><input name="${name}-st" type="number" inputmode="numeric" min="2" max="60" step="1" value="${v.st}" aria-label="Stone" placeholder="st" style="width:6em">
      <input name="${name}-lb" type="number" inputmode="decimal" min="0" max="13.9" step="0.1" value="${v.lb}" aria-label="Pounds" placeholder="lb" style="width:6em"></div>`;
  }
  return `<input name="${name}" type="number" inputmode="decimal" min="20" max="400" step="0.1" value="${kg != null ? round(kg, 1) : ''}" aria-label="Weight in kg" placeholder="kg">`;
}

function readWeight(form, name) {
  if (S.settings.weightUnit === 'stlb') {
    const st = numOrNull(form.elements[`${name}-st`].value);
    const lb = numOrNull(form.elements[`${name}-lb`].value) ?? 0;
    return st == null ? null : stLbToKg(st, lb);
  }
  return numOrNull(form.elements[name].value);
}

function openSheet(title, html) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  if (!sheet.open) sheet.showModal();
  const first = $('#sheet-body [autofocus]');
  if (first) first.focus();
}

function closeSheet() {
  stopScanner();
  if (sheet.open) sheet.close();
}

// ---------- Today ----------

function entryNutrients(e) {
  return nutrientsForGrams(e.per100, e.grams);
}

function renderToday() {
  const t = getTargets();
  const entries = S.diary[currentDate] ?? [];
  const { totals, missing } = sumNutrients(entries.map(entryNutrients));
  const isToday = currentDate === localDateStr();
  const d = parseLocalDate(currentDate);
  const label = isToday ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  let html = `<div class="datebar"><button data-action="day" data-delta="-1" aria-label="Previous day">‹</button>
    <strong>${esc(label)}</strong>
    <button data-action="day" data-delta="1" aria-label="Next day">›</button></div>`;

  if (!S.profile) {
    html += `<div class="card"><h2>Welcome</h2><p>Set up your profile to get your daily calorie and nutrient targets.</p>
      <a class="btn primary" href="#profile">Set up profile</a></div>`;
  }
  if (t?.blocked) html += `<div class="notice bad">${esc(t.blocked)}</div>`;

  if (t) {
    const a = assessIntake(totals, t);
    const left = t.kcal - totals.kcal;
    html += `<div class="card"><div class="spread"><div><div class="big">${fmt(totals.kcal)}</div><div class="muted small">of ${fmt(t.kcal)} kcal</div></div>
      <div style="text-align:right"><div class="big" style="color:${left < 0 ? 'var(--bad)' : 'var(--accent)'}">${fmt(Math.abs(left))}</div><div class="muted small">${left < 0 ? 'kcal over' : 'kcal left'}</div></div></div>
      ${bar(totals.kcal / t.kcal, a.kcal.status === 'high' ? 'high' : '')}
      <div class="nutgrid">${['protein', 'carbs', 'fat', 'fibre', 'satfat', 'sugars', 'salt'].map((k) => nutRow(k, a[k])).join('')}</div>
      </div>`;
    if (entries.length && currentDate < localDateStr() && totals.kcal < SAFETY.minKcal[S.profile.sex] * 0.8) {
      html += `<div class="notice warn">This day is well under ${SAFETY.minKcal[S.profile.sex]} kcal. If that's right, eating this little regularly can make it hard to get enough nutrients. If you forgot to log something, add it now.</div>`;
    }
  } else {
    html += `<div class="card"><div class="big">${fmt(totals.kcal)} kcal</div><div class="muted small">P ${fmt(totals.protein)} g · C ${fmt(totals.carbs)} g · F ${fmt(totals.fat)} g</div></div>`;
  }

  for (const slot of SLOTS) {
    const list = entries.filter((e) => e.slot === slot);
    const kcal = list.reduce((s, e) => s + (entryNutrients(e).kcal ?? 0), 0);
    html += `<div class="card"><div class="slot-head"><h3>${SLOT_LABELS[slot]}${slot === 'snack' ? 's' : ''}</h3>
      <div class="row"><span class="muted small">${fmt(kcal)} kcal</span><button class="primary" data-action="add-food" data-slot="${slot}">+ Add</button></div></div>
      ${list.length ? list.map((e) => {
        const n = entryNutrients(e);
        return `<div class="entry" data-action="edit-entry" data-id="${esc(e.id)}" tabindex="0" role="button">
          <div class="name">${esc(e.name)}<div class="muted small">${esc(e.portionLabel ? `${e.portionLabel} · ` : '')}${fmt(e.grams)} g · P ${fmt(n.protein, 1)} g</div></div>
          <div class="kcal">${fmt(n.kcal)} kcal</div></div>`;
      }).join('') : '<p class="muted small">Nothing logged yet.</p>'}</div>`;
  }

  if (t && entries.length) {
    const a = assessIntake(totals, t);
    const gaps = MICRO_KEYS.filter((k) => missing[k] > 0);
    html += `<details class="card"><summary><strong>Vitamins and minerals</strong> <span class="muted small">(% of UK reference intake)</span></summary>
      <div class="nutgrid">${MICRO_KEYS.map((k) => nutRow(k, a[k])).join('')}</div>
      ${gaps.length ? `<p class="muted small">Some foods have no data for some nutrients (most supermarket labels only list the main ones), so these totals can be underestimates.</p>` : ''}
      <p class="muted small">The NHS advises everyone to consider a 10 µg vitamin D supplement in autumn and winter.</p></details>`;
  }
  html += `<p class="muted small" style="text-align:center">Not medical advice. See Profile for sources.</p>`;
  view.innerHTML = html;
}

// ---------- Add food ----------

let addSlot = 'breakfast';
let addResults = [];
let addMode = 'local';

function sourceBadge(f) {
  if (f.src === 'core') return '<span class="badge core">UK basic</span>';
  if (f.src === 'off') return '<span class="badge off">UK product</span>';
  if (f.src === 'custom') return '<span class="badge">My food</span>';
  return '<span class="badge">Reference</span>';
}

function resultsHtml(list, emptyMsg) {
  if (!list.length) return `<p class="muted small">${esc(emptyMsg)}</p>`;
  return `<ul class="results">${list.map((f, i) => `<li tabindex="0" data-action="pick-food" data-i="${i}">
    ${f.image ? `<img src="${esc(f.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <div class="grow"><div>${esc(f.name)}${f.brand ? ` <span class="muted">· ${esc(f.brand)}</span>` : ''}</div>
    <div class="small muted">${sourceBadge(f)} ${fmt(f.n.kcal)} kcal/100 g${f.warnings?.length ? ' · ⚠ check label' : ''}</div></div></li>`).join('')}</ul>`;
}

function openAddFood(slot) {
  addSlot = slot;
  addMode = 'local';
  const recent = S.recentFoods.map((id) => foods.get(id)).filter(Boolean).slice(0, 12);
  addResults = recent;
  const hasCamera = !inArtifact && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  openSheet(`Add to ${SLOT_LABELS[slot].toLowerCase()}`, `
    <div class="seg" role="group" aria-label="Where to search">
      <button type="button" data-action="add-mode" data-mode="local" aria-pressed="true">Foods</button>
      ${inArtifact ? '' : `<button type="button" data-action="add-mode" data-mode="off" aria-pressed="false">UK supermarkets</button>
      <button type="button" data-action="add-mode" data-mode="barcode" aria-pressed="false">Barcode</button>`}
    </div>
    <form id="search-form" autocomplete="off">
      <div class="row"><input class="grow" name="q" type="search" placeholder="Search foods, e.g. porridge, chicken breast" autofocus aria-label="Search">
      <select name="store" aria-label="Supermarket" hidden style="width:auto"><option value="">All UK shops</option>${UK_STORES.map((s) => `<option value="${s.tag}">${esc(s.label)}</option>`).join('')}</select>
      <button class="primary" type="submit">Search</button></div>
      <div id="barcode-box" hidden><label for="barcode">Barcode number</label>
        <div class="row"><input id="barcode" name="barcode" class="grow" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 5000159484695">
        ${hasCamera ? '<button type="button" data-action="scan">Scan</button>' : ''}</div>
        ${hasCamera ? '' : '<p class="muted small">Camera scanning isn\'t supported in this browser; type the number under the barcode.</p>'}
        <video id="scanner" hidden playsinline muted></video></div>
    </form>
    <div id="search-msg" class="small muted">${recent.length ? 'Recent foods' : ''}</div>
    <div id="search-results">${recent.length ? resultsHtml(recent, '') : ''}</div>
    ${inArtifact ? '<p class="small muted">Live supermarket product search and barcode lookup work when the app runs on its own website. In this preview, add a packaged food from its label.</p>' : ''}
    <div class="row" style="margin-top:12px"><button type="button" class="link" data-action="custom-food">+ Create a food from a label</button>
    <button type="button" class="link" data-action="quick-add">+ Quick add calories</button></div>`);
}

function setAddMode(mode) {
  addMode = mode;
  const form = $('#search-form');
  $('#sheet-body .seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  form.elements.store.hidden = mode !== 'off';
  form.elements.q.hidden = mode === 'barcode';
  $('#barcode-box').hidden = mode !== 'barcode';
  form.elements.q.placeholder = mode === 'off' ? 'Product, e.g. tesco houmous' : 'Search foods, e.g. porridge, chicken breast';
  $('#search-msg').textContent = mode === 'off'
    ? 'Searches Open Food Facts for products sold in the UK. Coverage is good for big brands and supermarket own-label, but not complete.'
    : '';
  $('#search-results').innerHTML = '';
  (mode === 'barcode' ? $('#barcode') : form.elements.q).focus();
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 429) throw new Error('Open Food Facts is limiting searches right now. Wait a minute and try again.');
    if (!res.ok) throw new Error(`Open Food Facts returned an error (${res.status})`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The product search timed out. Check your connection and try again.');
    if (e instanceof TypeError) throw new Error("Couldn't connect to Open Food Facts. Their service may be busy; try again in a minute. You can also type a barcode or add the food from its label.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function runSearch(form) {
  const msg = $('#search-msg');
  const out = $('#search-results');
  if (addMode === 'local') {
    const q = form.elements.q.value;
    addResults = searchFoods(getIndex(), q, { recent: S.recentFoods });
    msg.textContent = addResults.length ? `${addResults.length >= 40 ? 'Top 40' : addResults.length} matches` : '';
    out.innerHTML = resultsHtml(addResults, 'No matches. Try a simpler word, search UK supermarkets, or create the food from its label.');
    return;
  }
  if (addMode === 'barcode') {
    const code = form.elements.barcode.value.replace(/\D/g, '');
    if (!isValidBarcode(code)) { msg.textContent = "That barcode doesn't look right. Check the digits."; return; }
    const cached = foods.get(`off:${code}`);
    if (cached) { addResults = [cached]; out.innerHTML = resultsHtml(addResults, ''); return; }
    msg.textContent = 'Looking up barcode…';
    try {
      const f = normaliseProductResponse(await fetchJson(buildProductUrl(code)));
      addResults = f ? [f] : [];
      msg.textContent = '';
      out.innerHTML = resultsHtml(addResults, 'That product isn\'t on Open Food Facts yet, or has no nutrition data. You can create it from the label.');
    } catch (e) { msg.textContent = e.message; }
    return;
  }
  const q = form.elements.q.value.trim();
  if (q.length < 2) { msg.textContent = 'Type at least 2 letters.'; return; }
  const wait = 6000 - (Date.now() - lastOffSearch);
  if (wait > 0) { msg.textContent = `Please wait ${Math.ceil(wait / 1000)} s between product searches (Open Food Facts limit).`; return; }
  lastOffSearch = Date.now();
  msg.textContent = 'Searching UK products…';
  out.innerHTML = '';
  try {
    const { foods: list, total } = await searchProducts(q, form.elements.store.value);
    addResults = list;
    msg.textContent = list.length ? `Showing ${list.length} of ${total.toLocaleString('en-GB')} products. Always check against the pack.` : '';
    out.innerHTML = resultsHtml(list, 'No UK products found with nutrition data. Try fewer words, another shop, or a barcode.');
  } catch (e) {
    msg.textContent = e.message;
  }
}

// Try Open Food Facts' newer search service first, then the older one, so a
// problem with either still leaves product search working.
async function searchProducts(query, storeTag) {
  try {
    const r = normaliseModernSearchResponse(await fetchJson(buildModernSearchUrl({ query, storeTag }), 10000));
    if (r.foods.length) return r;
  } catch { /* fall back */ }
  return normaliseSearchResponse(await fetchJson(buildSearchUrl({ query, storeTag })));
}

let scanStream = null;
async function startScanner() {
  const video = $('#scanner');
  try {
    const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream;
    video.hidden = false;
    await video.play();
    const tick = async () => {
      if (!scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          $('#barcode').value = codes[0].rawValue;
          stopScanner();
          runSearch($('#search-form'));
          return;
        }
      } catch { /* keep trying */ }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    $('#search-msg').textContent = `Camera unavailable: ${e.message}`;
    stopScanner();
  }
}

function stopScanner() {
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const v = $('#scanner');
  if (v) v.hidden = true;
}

let pickedFood = null;
let editingEntry = null;

function portionOptions(food) {
  const opts = (food.portions ?? []).map(([label, g]) => ({ label, g }));
  opts.push({ label: 'grams / ml', g: 1 });
  return opts;
}

function openPortion(food, entry = null) {
  pickedFood = food;
  editingEntry = entry;
  const opts = portionOptions(food);
  let sel = 0;
  let qty = 1;
  if (entry) {
    sel = opts.length - 1;
    qty = entry.grams;
    const i = opts.findIndex((o) => o.label === entry.portionLabel);
    if (i >= 0 && opts[i].g > 1) { sel = i; qty = round(entry.grams / opts[i].g, 2); }
  } else if (opts.length === 1) { qty = 100; }
  openSheet(entry ? 'Edit entry' : 'How much?', `
    <p><strong>${esc(food.name)}</strong>${food.brand ? ` <span class="muted">· ${esc(food.brand)}</span>` : ''}<br><span class="small">${sourceBadge(food)}</span></p>
    ${food.warnings?.length ? `<div class="notice warn">This product's label data looks inconsistent (${esc(food.warnings.join('; '))}). Check it against the pack.</div>` : ''}
    <form id="portion-form">
      <div class="grid2"><div><label for="p-qty">Amount</label><input id="p-qty" name="qty" type="number" inputmode="decimal" min="0.1" step="any" value="${qty}" required></div>
      <div><label for="p-unit">Unit</label><select id="p-unit" name="unit">${opts.map((o, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(o.label)}${o.g > 1 ? ` – ${fmt(o.g, 1)} g` : ''}</option>`).join('')}</select></div></div>
      ${entry ? `<label for="p-slot">Meal</label><select id="p-slot" name="slot">${SLOTS.map((s) => `<option value="${s}" ${s === entry.slot ? 'selected' : ''}>${SLOT_LABELS[s]}</option>`).join('')}</select>` : ''}
      <div id="p-preview" class="card" style="margin-top:12px"></div>
      <div class="row"><button class="primary" type="submit">${entry ? 'Save' : 'Add'}</button>
      ${entry ? '<button type="button" class="danger" data-action="delete-entry">Delete</button>' : ''}</div>
    </form>`);
  updatePortionPreview();
}

function portionGrams() {
  const form = $('#portion-form');
  const opts = portionOptions(pickedFood);
  const o = opts[Number(form.elements.unit.value)];
  const qty = Number(form.elements.qty.value);
  return { grams: qty * o.g, label: o.g > 1 ? `${round(qty, 2)} × ${o.label}` : null };
}

function updatePortionPreview() {
  const { grams } = portionGrams();
  const n = nutrientsForGrams(pickedFood.n, grams);
  const box = $('#p-preview');
  if (!Number.isFinite(grams) || grams <= 0) { box.innerHTML = '<span class="muted">Enter an amount.</span>'; return; }
  box.innerHTML = `<div class="spread"><strong>${fmt(n.kcal)} kcal</strong><span class="muted small">${fmt(grams, 1)} g</span></div>
    <div class="small">Protein ${fmt(n.protein, 1)} g · Carbs ${fmt(n.carbs, 1)} g · Fat ${fmt(n.fat, 1)} g · Fibre ${fmt(n.fibre, 1)} g · Salt ${fmt(n.salt, 2)} g</div>`;
}

function submitPortion() {
  const { grams, label } = portionGrams();
  try {
    if (editingEntry) {
      if (!Number.isFinite(grams) || grams <= 0 || grams > 5000) throw new Error('Enter an amount between 1 and 5000 g');
      const slot = $('#portion-form').elements.slot.value;
      commit(updateEntry(S, currentDate, editingEntry.id, { grams: round(grams, 1), portionLabel: label, slot }));
      closeSheet();
      return;
    }
    const entry = makeEntry({ food: pickedFood, grams, slot: addSlot, portionLabel: label });
    let next = addEntry(S, currentDate, entry);
    if (pickedFood.src === 'off' && !S.productCache[pickedFood.id]) {
      next = { ...next, productCache: { ...next.productCache, [pickedFood.id]: pickedFood } };
    }
    commit(next);
    closeSheet();
    toast(`Added ${fmt(nutrientsForGrams(pickedFood.n, grams).kcal)} kcal`);
  } catch (e) {
    toast(e.message);
  }
}

function openEditEntry(id) {
  const e = (S.diary[currentDate] ?? []).find((x) => x.id === id);
  if (!e) return;
  const food = foods.get(e.foodId) ?? { id: e.foodId, name: e.name, src: e.src, n: e.per100, portions: [] };
  // Edit against the saved per-100 g values so the entry never changes silently.
  openPortion({ ...food, n: e.per100 }, e);
}

function openCustomFood() {
  openSheet('Create a food', `<p class="small muted">Copy the "per 100 g" column from the label. Only calories are required.</p>
    <form id="custom-form">
      <label for="c-name">Name</label><input id="c-name" name="name" required autofocus>
      <label for="c-brand">Brand or shop (optional)</label><input id="c-brand" name="brand">
      <div class="grid2">
        ${[['kcal', 'Energy (kcal)'], ['protein', 'Protein (g)'], ['carbs', 'Carbohydrate (g)'], ['sugars', 'of which sugars (g)'], ['fat', 'Fat (g)'], ['satfat', 'of which saturates (g)'], ['fibre', 'Fibre (g)'], ['salt', 'Salt (g)'], ['servingG', 'Serving size (g, optional)']]
          .map(([k, l]) => `<div><label for="c-${k}">${l}</label><input id="c-${k}" name="${k}" type="number" inputmode="decimal" min="0" step="any" ${k === 'kcal' ? 'required' : ''}></div>`).join('')}
      </div>
      <p class="small muted">If the label shows only kJ, divide by 4.184 to get kcal.</p>
      <button class="primary" type="submit">Save and add</button>
    </form>`);
}

function submitCustomFood(form) {
  const v = (k) => numOrNull(form.elements[k].value);
  try {
    const food = makeCustomFood({
      name: form.elements.name.value, brand: form.elements.brand.value, kcal: v('kcal'), protein: v('protein'), carbs: v('carbs'),
      sugars: v('sugars'), fat: v('fat'), satfat: v('satfat'), fibre: v('fibre'), salt: v('salt'), servingG: v('servingG'),
    });
    commit({ ...S, customFoods: [...S.customFoods, food] }, { rerender: false });
    openPortion(foods.get(food.id));
  } catch (e) { toast(e.message, 6000); }
}

function openQuickAdd() {
  openSheet('Quick add', `<form id="quick-form"><label for="q-name">What was it?</label><input id="q-name" name="name" value="Quick add" autofocus>
    <div class="grid2"><div><label for="q-kcal">Calories (kcal)</label><input id="q-kcal" name="kcal" type="number" inputmode="numeric" min="1" max="5000" required></div>
    <div><label for="q-protein">Protein (g, optional)</label><input id="q-protein" name="protein" type="number" inputmode="decimal" min="0"></div></div>
    <p class="small muted">Use this when you know the calories but not the food. Vitamins and minerals won't be counted.</p>
    <button class="primary" type="submit">Add</button></form>`);
}

function submitQuickAdd(form) {
  const kcal = numOrNull(form.elements.kcal.value);
  const protein = numOrNull(form.elements.protein.value);
  if (!Number.isFinite(kcal) || kcal <= 0 || kcal > 5000) { toast('Enter calories between 1 and 5000'); return; }
  // Stored as a 100 g "portion" so the per-100 g maths stays uniform.
  const n = Object.fromEntries(NUTRIENTS.map((x) => [x.key, null]));
  n.kcal = kcal;
  if (Number.isFinite(protein)) n.protein = protein;
  const entry = makeEntry({ food: { id: 'quick', name: form.elements.name.value.trim() || 'Quick add', src: 'custom', n }, grams: 100, slot: addSlot, portionLabel: 'Quick add' });
  commit(addEntry(S, currentDate, entry));
  closeSheet();
}

// ---------- Meal plan ----------

let planBusy = false;
let coachLog = []; // this visit's coach conversation: [{ role: 'user'|'coach', text, lines? }]
let coachBusy = false;
let sample = null; // Claude, when the app runs inside claude.ai (AI coach)
let vocab = null;
let shoppingEdit = false;

function coachVocab() {
  vocab ??= buildVocab(mealIngredients(MEALS), foods);
  return vocab;
}

const foodName = (id) => foods.get(id.includes(':') ? id : `uk:${id}`)?.name ?? id;
const mealName = (id) => MEALS.find((m) => m.id === id)?.name ?? id;
const dayName = (i, style = 'long') => parseLocalDate(addDays(S.plan?.startDate ?? localDateStr(), i)).toLocaleDateString('en-GB', { weekday: style });

function prepSelect(slot, o, t) {
  const v = o.prep?.[slot] || false;
  const allowed = MEALS.filter((m) => m.slots.includes(slot) && mealAllowed(m, foods, o));
  const opts = [['', `Different ${slot} each day`], ['auto', `Same ${slot} every day (planner picks)`],
    ...allowed.map((m) => [m.id, `Same every day: ${m.name}${m.keeps >= 2 ? ' (batch-cook)' : ''}`])];
  return `<label for="prep-${slot}">${SLOT_LABELS[slot]}</label><select id="prep-${slot}" name="prep-${slot}">${opts.map(([k, l]) => `<option value="${esc(k)}" ${String(v || '') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

function renderPlan() {
  const t = getTargets();
  if (!t) { view.innerHTML = `<div class="card"><h2>Meal plan</h2><p>Set up your profile first so the planner knows your targets.</p><a class="btn primary" href="#profile">Set up profile</a></div>`; return; }
  if (t.blocked) { view.innerHTML = `<div class="notice bad">${esc(t.blocked)}</div>`; return; }
  const o = S.planOptions;
  const disliked = o.dislikedFoods ?? [];
  const dislikedMeals = o.dislikedMeals ?? [];
  let html = `<div class="card"><h2>Plan a week of meals</h2>
    <p class="small muted">Meals are picked and portioned to hit about ${fmt(t.kcal)} kcal and ${t.macros.protein.target} g protein a day, at least ${t.macros.fibre.target} g fibre, under the UK limits for salt and saturated fat, and as many vitamins and minerals as possible.</p>
    <form id="plan-form"><label for="diet">Diet</label><select id="diet" name="diet">${Object.entries(DIETS).map(([k, d]) => `<option value="${k}" ${o.diet === k ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select>
    <label>Leave out (allergies and diets)</label>${EXCLUSIONS.map((e) => `<label class="inline"><input type="checkbox" name="exclude" value="${e.id}" ${o.exclude.includes(e.id) ? 'checked' : ''}> ${esc(e.label)}</label>`).join('')}
    <label>Foods not eaten</label>
    <div class="chips" id="disliked-chips">${disliked.length ? disliked.map((id) => `<button type="button" class="chip" data-action="undislike-food" data-id="${esc(id)}" aria-label="Allow ${esc(foodName(id))} again">${esc(foodName(id))} ✕</button>`).join('') : '<span class="small muted">None yet. Any meal containing one of these is never planned.</span>'}</div>
    <div class="row"><button type="button" data-action="choose-dislikes">Choose foods…</button></div>
    ${dislikedMeals.length ? `<label>Meals not suggested</label><div class="chips">${dislikedMeals.map((id) => `<button type="button" class="chip" data-action="undislike-meal" data-id="${esc(id)}" aria-label="Suggest ${esc(mealName(id))} again">${esc(mealName(id))} ✕</button>`).join('')}</div>` : ''}
    <h3>Meal prep</h3><p class="small muted">Have the same breakfast or lunch every day, at the same portion, so you buy the same things each week.</p>
    ${prepSelect('breakfast', o, t)}${prepSelect('lunch', o, t)}
    <label for="shop">Prices for</label><select id="shop" name="shop">${Object.entries(SHOPS).map(([k, sh]) => `<option value="${k}" ${o.shop === k ? 'selected' : ''}>${esc(sh.label)}</option>`).join('')}</select>
    <div class="row" style="margin-top:8px"><button class="primary" type="submit" ${planBusy ? 'disabled' : ''}>${S.plan ? 'Make a new plan' : 'Make my plan'}</button></div></form>
    <p class="small muted">Always check ingredient labels yourself if you have an allergy: products vary.</p></div>`;

  html += renderCoach();

  if (S.plan) {
    const p = S.plan;
    const avg = p.summary.average;
    const cost = costShoppingList(shoppingList(p, foods), { shop: o.shop, overrides: S.priceOverrides });
    const prep = Object.entries(p.prepMeals ?? {});
    html += `<div class="card"><h3>Weekly average</h3><div class="kpis">
      <div><b>${fmt(avg.kcal)}</b><span class="small muted">kcal (target ${fmt(t.kcal)})</span></div>
      <div><b>${fmt(avg.protein)} g</b><span class="small muted">protein</span></div>
      <div><b>${fmt(avg.fibre)} g</b><span class="small muted">fibre</span></div>
      <div><b>${fmt(avg.satfat, 1)} g</b><span class="small muted">sat fat (max ${t.macros.satfat.max})</span></div>
      <div><b>${fmt(avg.salt, 1)} g</b><span class="small muted">salt (max 6)</span></div>
      <div><b>${fmt(avg.sugars)} g</b><span class="small muted">sugars</span></div></div>
      <p class="small" id="plan-cost">Estimated food cost: <strong>${formatPounds(cost.usedPence)}</strong> for the week's meals; about <strong>${formatPounds(cost.buyPence)}</strong> at the till if you buy every pack new (estimates, not live prices).</p>
      ${prep.length ? `<p class="small">Meal prep: ${prep.map(([slot, id]) => `${esc(SLOT_LABELS[slot])} is <strong>${esc(mealName(id))}</strong> every day`).join('; ')}.</p>` : ''}
      ${planAdvice(p, t)}
      <div class="row" style="margin-top:8px"><button data-action="shopping">Shopping list and prices</button>${prep.length ? '<button data-action="prep-guide">Meal prep guide</button>' : ''}</div></div>`;
    p.days.forEach((day, i) => {
      const date = addDays(p.startDate ?? localDateStr(), i);
      const dlabel = parseLocalDate(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
      html += `<details class="card day-card" ${i === 0 ? 'open' : ''}><summary class="spread"><strong>${esc(dlabel)}</strong>
        <span class="muted small">${fmt(day.totals.kcal)} kcal · P ${fmt(day.totals.protein)} g · fibre ${fmt(day.totals.fibre)} g</span></summary>
        ${day.meals.map((m) => `<div class="meal"><div class="spread"><div><span class="badge">${SLOT_LABELS[m.slot]}</span>${p.prepMeals?.[m.slot] === m.mealId ? ' <span class="badge core">Meal prep</span>' : ''} <strong>${esc(m.name)}</strong></div><span class="small muted">${fmt(m.n.kcal)} kcal</span></div>
          <ul>${m.items.map((it) => `<li>${fmt(it.grams)} g ${esc(it.name)}</li>`).join('')}</ul>
          ${m.method ? `<div class="small muted">${esc(m.method)}${m.mins ? ` (${m.mins} min)` : ''}</div>` : ''}
          <div class="row"><button class="link" data-action="swap" data-day="${i}" data-slot="${m.slot}">Swap</button>
          <button class="link" data-action="meal-dislike" data-day="${i}" data-slot="${m.slot}">Won't eat this</button>
          <button class="link" data-action="log-meal" data-day="${i}" data-slot="${m.slot}">Log to ${esc(parseLocalDate(date).toLocaleDateString('en-GB', { weekday: 'short' }))}</button></div></div>`).join('')}
        <div class="row"><button data-action="log-day" data-day="${i}">Log whole day</button></div></details>`;
    });
  }
  view.innerHTML = html;
  const log = $('#coach-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function renderCoach() {
  const smart = Boolean(sample);
  const intro = smart
    ? 'Tell the coach what she will and won\'t eat, in your own words. It updates the plan for you.'
    : 'Tell the coach what she won\'t eat, for example "she hates mushrooms, fish and cottage cheese, but likes chicken", or "same breakfast and lunch every day". It updates the plan for you.';
  return `<div class="card" id="coach"><h3>Meal coach</h3><p class="small muted">${esc(intro)}</p>
    ${coachLog.length ? `<div class="coach-log" id="coach-log">${coachLog.map((m) => `<div class="bubble ${m.role}">${esc(m.text)}${m.lines?.length ? `<ul>${m.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}</div>`).join('')}${coachBusy ? '<div class="bubble coach muted">Thinking…</div>' : ''}</div>` : ''}
    <form id="coach-form"><label for="coach-text" class="sr-only">Message to the coach</label>
    <textarea id="coach-text" name="text" rows="2" maxlength="600" placeholder="e.g. She won't eat mushrooms or salmon" ${coachBusy ? 'disabled' : ''}></textarea>
    <div class="row" style="margin-top:6px"><button class="primary" type="submit" ${coachBusy ? 'disabled' : ''}>Send</button>
    ${smart ? '<span class="small muted">Uses Claude (your Claude usage).</span>' : '<span class="small muted">Simple sentences work best. The smarter AI coach runs in the Claude preview.</span>'}</div></form></div>`;
}

function planAdvice(p, t) {
  const parts = [];
  const low = p.summary.belowRni.map((k) => NUTRIENT_BY_KEY[k].label);
  if (low.length) parts.push(`<div class="notice warn">On average this plan is below the UK reference intake for: ${esc(low.join(', '))}. Swapping a few meals can help${t.kcal <= 1400 ? '; at lower calorie targets this can be hard to avoid' : ''}.</div>`);
  if (p.summary.flags.includes('protein')) parts.push('<div class="notice warn">Protein is below your target. Try swapping in meals with beans, tofu, eggs, dairy, fish or lean meat.</div>');
  if (S.planOptions.diet === 'vegan') parts.push('<div class="notice info">On a vegan diet you need a reliable source of vitamin B12 (fortified foods or a supplement) and iodine. Ask a pharmacist if unsure.</div>');
  parts.push('<p class="small muted">Vitamin D is hard to get from food alone. The NHS advises a 10 µg supplement, at least from October to March.</p>');
  return parts.join('');
}

function readPlanForm(form) {
  const prep = {};
  for (const slot of PREP_SLOTS) prep[slot] = form.elements[`prep-${slot}`].value || false;
  return {
    ...S.planOptions,
    diet: form.elements.diet.value,
    exclude: [...form.querySelectorAll('input[name="exclude"]:checked')].map((x) => x.value),
    prep,
    shop: form.elements.shop.value,
  };
}

/** Make a new plan with these options (new seed unless one is given). */
function makePlan(options, { seed = Math.floor(Math.random() * 1e9), quiet = false } = {}) {
  const t = getTargets();
  planBusy = true;
  render();
  setTimeout(() => {
    try {
      const plan = planWeek({ targets: t, foods, meals: MEALS, options: { ...options, seed } });
      commit({ ...S, plan: { ...plan, startDate: S.plan?.startDate && quiet ? S.plan.startDate : localDateStr() }, planOptions: options });
    } catch (e) {
      toast(e.message, 6000);
      commit({ ...S, planOptions: options });
    } finally {
      planBusy = false;
      render();
    }
  }, 20);
}

function submitPlan(form) {
  makePlan(readPlanForm(form));
}

/**
 * Save new options (dislikes, prep) and fix the current plan to match:
 * meals that are no longer allowed are swapped for the best alternative;
 * a meal-prep change re-plans the week. Returns a short description.
 */
function applyOptions(options) {
  const t = getTargets();
  const prepChanged = S.plan && PREP_SLOTS.some((s) => (S.planOptions.prep?.[s] || false) !== (options.prep?.[s] || false));
  if (!S.plan || !t) { commit({ ...S, planOptions: options }); return ''; }
  try {
    if (prepChanged) {
      const plan = planWeek({ targets: t, foods, meals: MEALS, options: { ...options, seed: S.plan.createdWith?.seed ?? 1 } });
      commit({ ...S, plan: { ...plan, startDate: S.plan.startDate }, planOptions: options });
      return 'Re-planned the week.';
    }
    const res = cleanPlan({ plan: S.plan, targets: t, foods, meals: MEALS, options });
    commit({ ...S, plan: { ...res.plan, startDate: S.plan.startDate }, planOptions: options });
    if (res.replanned) return 'Re-planned the week around the change.';
    return res.changed ? `Swapped ${res.changed} planned meal${res.changed === 1 ? '' : 's'}.` : 'Your current plan already fits.';
  } catch (e) {
    commit({ ...S, planOptions: options });
    toast(e.message, 6000);
    return e.message;
  }
}

function openDislikes(filter = '') {
  const ids = [...mealIngredients(MEALS)].map((id) => foods.get(id)).filter(Boolean);
  const fresh = !(sheet.open && $('#dislike-list'));
  if (fresh) openDislikes.pending = new Set(S.planOptions.dislikedFoods ?? []);
  const chosen = openDislikes.pending;
  const q = filter.trim().toLowerCase();
  const shown = ids.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.aliases ?? []).some((a) => a.includes(q)));
  shown.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
  let cat = '';
  const list = shown.map((f) => {
    const head = f.cat !== cat ? `<h4>${esc(f.cat)}</h4>` : '';
    cat = f.cat;
    const id = f.id.replace(/^uk:/, '');
    return `${head}<label class="inline"><input type="checkbox" name="food" value="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}> ${esc(f.name)}</label>`;
  }).join('');
  const body = `<p class="small muted">Tick everything she won't eat. Meals containing any of these are never planned, and meals already in the plan are swapped.</p>
    <input type="search" id="dislike-filter" placeholder="Filter, e.g. mushroom" value="${esc(filter)}" aria-label="Filter foods">
    <form id="dislike-form"><div id="dislike-list">${list || '<p class="muted">No matching foods.</p>'}</div>
    <div class="row sticky-actions"><button class="primary" type="submit">Save</button><button type="button" data-action="close-sheet">Cancel</button></div></form>`;
  if (!fresh) {
    $('#dislike-list').innerHTML = list || '<p class="muted">No matching foods.</p>';
  } else {
    openSheet('Foods she won\'t eat', body);
  }
}

function submitDislikes() {
  const msg = applyOptions({ ...S.planOptions, dislikedFoods: [...openDislikes.pending] });
  closeSheet();
  if (msg) toast(msg);
}

function openMealDislike(dayIndex, slot) {
  const m = S.plan.days[dayIndex].meals.find((x) => x.slot === slot);
  openMealDislike.meal = m;
  openSheet(m.name, `<p>What doesn't she like about it?</p>
    <ul class="results">${m.items.map((it) => `<li tabindex="0" data-action="dislike-food" data-id="${esc(it.foodId.replace(/^uk:/, ''))}"><div class="grow">${esc(it.name)}</div><span class="small muted">Never plan this</span></li>`).join('')}</ul>
    <div class="row" style="margin-top:12px"><button class="danger" data-action="dislike-meal" data-id="${esc(m.mealId)}">Never suggest this meal</button><button data-action="close-sheet">Cancel</button></div>`);
}

function openSwap(dayIndex, slot) {
  const t = getTargets();
  if (S.plan.prepMeals?.[slot]) {
    const ranked = rankPrepMeals({ targets: t, foods, meals: MEALS, options: S.planOptions, slot, limit: 10 })
      .filter((r) => r.cand.meal.id !== S.plan.prepMeals[slot]);
    openSwap.prep = ranked.map((r) => r.cand.meal.id);
    openSheet(`Swap the meal-prep ${slot}`, ranked.length
      ? `<p class="small muted">This changes ${slot} on every day, and the week is re-planned around it. Best fit first.</p><ul class="results">${ranked.map((r, i) => `<li tabindex="0" data-action="do-prep-swap" data-slot="${slot}" data-i="${i}">
        <div class="grow"><strong>${esc(r.cand.meal.name)}</strong><div class="small muted">${r.cand.meal.keeps >= 2 ? `Batch-cook: keeps ${r.cand.meal.keeps} days` : 'Make fresh each day'} · ${r.cand.meal.mins} min</div></div></li>`).join('')}</ul>`
      : '<p>No other meals fit your choices for this slot.</p>');
    return;
  }
  const alts = alternativesForSlot({ plan: S.plan, dayIndex, slot, targets: t, foods, meals: MEALS, options: S.planOptions });
  openSheet(`Swap ${SLOT_LABELS[slot].toLowerCase()}`, alts.length
    ? `<p class="small muted">Best options for this day's other meals, best fit first.</p><ul class="results">${alts.map((m, i) => `<li tabindex="0" data-action="do-swap" data-day="${dayIndex}" data-i="${i}">
      <div class="grow"><strong>${esc(m.name)}</strong><div class="small muted">${fmt(m.n.kcal)} kcal · P ${fmt(m.n.protein)} g · fibre ${fmt(m.n.fibre, 1)} g</div></div></li>`).join('')}</ul>`
    : '<p>No other meals fit your diet for this slot.</p>');
  openSwap.alts = alts;
}

function logPlannedMeals(dayIndex, slots) {
  const day = S.plan.days[dayIndex];
  const date = addDays(S.plan.startDate ?? localDateStr(), dayIndex);
  let next = S;
  for (const m of day.meals.filter((x) => slots.includes(x.slot))) {
    // One diary entry per meal; its per-100 g values come from the ingredients,
    // so changing the amount later scales the whole meal.
    const grams = m.items.reduce((sum, it) => sum + it.grams, 0);
    const per100 = Object.fromEntries(Object.entries(m.n).map(([k, v]) => [k, (v * 100) / grams]));
    const food = { id: `meal:${m.mealId}`, name: m.name, src: 'meal', n: per100 };
    next = addEntry(next, date, makeEntry({ food, grams, slot: m.slot, portionLabel: 'Planned meal' }));
  }
  commit(next);
  toast(`Logged to ${parseLocalDate(date).toLocaleDateString('en-GB', { weekday: 'long' })}'s diary`);
}

const gramsText = (g) => (g >= 1000 ? `${round(g / 1000, 2)} kg` : `${g} g`);

function openShopping() {
  const o = S.planOptions;
  const cost = costShoppingList(shoppingList(S.plan, foods), { shop: o.shop, overrides: S.priceOverrides });
  const shop = SHOPS[o.shop] ?? SHOPS.typical;
  let cat = '';
  const lines = [];
  const rowsHtml = cost.rows.map((r) => {
    const head = r.cat !== cat ? `<tr><th colspan="3">${esc(r.cat)}</th></tr>` : '';
    cat = r.cat;
    const p = r.price;
    const buy = p ? `${p.packs} × ${esc(p.pack)}${p.staple ? ' <span class="badge">cupboard</span>' : ''}` : '';
    lines.push(`${r.name}: ${gramsText(r.grams)}${p ? ` (${p.packs} × ${p.pack}, ${formatPounds(p.buyPence)})` : ''}`);
    const priceCell = !p ? '–' : shoppingEdit
      ? `<input type="number" class="price-input" min="0" max="999" step="0.01" inputmode="decimal" data-price-id="${esc(r.foodId.replace(/^uk:/, ''))}" value="${(p.packPence / 100).toFixed(2)}" aria-label="Price per pack for ${esc(r.name)} in pounds">`
      : `${formatPounds(p.buyPence)}${p.custom ? '*' : ''}`;
    return `${head}<tr><td>${esc(r.name)}<div class="small muted">${buy}</div></td><td class="num">${gramsText(r.grams)}</td><td class="num">${priceCell}</td></tr>`;
  }).join('');
  openShopping.text = `${lines.join('\n')}\n\nEstimated: ${formatPounds(cost.buyPence)} at the till (plus ${formatPounds(cost.staplesPence)} if you need cupboard staples).`;
  openSheet('Shopping list', `<div class="notice info small">About <strong>${formatPounds(cost.buyPence)}</strong> at the till for this week, buying whole packs (plus ${formatPounds(cost.staplesPence)} if you need to restock cupboard staples like oil and spices). The food actually eaten this week costs about <strong>${formatPounds(cost.usedPence)}</strong>; leftovers carry over to next week.</div>
    <p class="small muted">Prices are estimates for ${esc(shop.label)} based on typical ${PRICES_AS_OF} own-brand prices, not live prices. Tap "Edit prices" to enter what you pay${Object.keys(S.priceOverrides ?? {}).length ? ' (* = your price)' : ''}. Weights are as eaten: cooked weights for meat, rice and pasta unless it says raw or dried.</p>
    <table class="shop"><thead><tr><th>Item</th><th class="num">Needed</th><th class="num">Price</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    <div class="row" style="margin-top:12px"><button class="primary" data-action="copy-list">Copy list</button>
    <button data-action="edit-prices">${shoppingEdit ? 'Done editing' : 'Edit prices'}</button>
    ${Object.keys(S.priceOverrides ?? {}).length ? '<button class="link" data-action="reset-prices">Use estimated prices</button>' : ''}</div>`);
}

function openPrepGuide() {
  const batches = prepBatches(S.plan, MEALS);
  const html = batches.map((b) => {
    const per = b.portion ? b.portion.items.map((it) => `${fmt(it.grams)} g ${esc(it.name)}`).join(', ') : '';
    const plan = b.batches.length
      ? `<p>Cook in ${b.batches.length} batch${b.batches.length === 1 ? '' : 'es'} so nothing is kept longer than ${b.keeps} days in the fridge:</p>
        ${b.batches.map((x) => `<div class="meal"><strong>${esc(dayName(x.startDay))}: make ${x.portions} portions</strong>
          <ul>${x.items.map((it) => `<li>${esc(gramsText(Math.round(it.grams)))} ${esc(it.name)}</li>`).join('')}</ul></div>`).join('')}
        <p class="small muted">Cool cooked food within 2 hours and keep it in the fridge in sealed boxes. Reheat until steaming hot all the way through. Cook rice fresh, or cool it quickly and eat it within 24 hours.</p>`
      : `<p>This one is best made fresh each day (it only takes ${b.portion?.mins ?? 'a few'} minutes), but it's the same every day so the weekly shop stays the same.</p>`;
    return `<div class="card"><h3>${esc(SLOT_LABELS[b.slot])}: ${esc(b.name)}</h3><p class="small">Every day, ${b.portions} days: ${per}.</p>
      ${b.method ? `<p class="small muted">${esc(b.method)}</p>` : ''}${plan}
      ${S.planOptions.prep?.[b.slot] !== b.mealId ? `<button data-action="keep-prep" data-slot="${b.slot}" data-id="${esc(b.mealId)}">Keep this ${b.slot} for future weeks</button>` : '<p class="small muted">Kept for future weeks. Change it under Meal prep.</p>'}</div>`;
  }).join('');
  openSheet('Meal prep guide', html || '<p>Turn on meal prep for breakfast or lunch, then make a plan.</p>');
}

async function sendCoach(form) {
  const text = form.elements.text.value.trim();
  if (!text || coachBusy) return;
  coachLog = [...coachLog, { role: 'user', text }];
  const v = coachVocab();
  let changes;
  let reply = '';
  if (sample) {
    coachBusy = true;
    render();
    try {
      const prompt = coachPrompt(text, { vocab: v, meals: MEALS, options: S.planOptions, history: coachLog.slice(0, -1) });
      const answer = await sample.json(prompt, { modelTier: 'quick', cache: false });
      changes = parseCoachReply(answer, { vocab: v, meals: MEALS });
      reply = changes.reply;
      if (changes.unmatched?.length) reply += ` (Not in the meal library, so nothing to change: ${changes.unmatched.join(', ')}.)`;
    } catch (e) {
      if (e?.code === 'not_granted') sample = null;
      changes = null;
    } finally {
      coachBusy = false;
    }
  }
  if (!changes) changes = localCoach(text, { vocab: v, meals: MEALS });
  // Only report "allowed again" for things that were actually off the menu.
  changes = {
    ...changes,
    allowFoods: (changes.allowFoods ?? []).filter((id) => S.planOptions.dislikedFoods?.includes(id.replace(/^uk:/, ''))),
    allowMeals: (changes.allowMeals ?? []).filter((id) => S.planOptions.dislikedMeals?.includes(id)),
  };
  const lines = describeChanges(changes, { foods, meals: MEALS });
  let result = '';
  if (lines.length) {
    result = applyOptions(applyCoachChanges(S.planOptions, changes));
    if (!reply) reply = 'Done. Here\'s what I changed:';
  } else if (!reply) {
    reply = 'I couldn\'t match that to any foods in the meal plan. Try naming the foods, for example "she won\'t eat mushrooms, tuna or feta".';
  }
  coachLog = [...coachLog, { role: 'coach', text: reply, lines: result ? [...lines, result] : lines }].slice(-20);
  render();
}

// ---------- Progress ----------

function chartSvg(series, targetKg) {
  if (series.length < 2) return '<p class="muted small">Log your weight on two or more days to see a chart.</p>';
  const W = 640; const H = 300; const P = { l: 64, r: 12, t: 14, b: 34 };
  const toUnit = (kg) => (S.settings.weightUnit === 'stlb' ? kg / 6.35029318 : kg);
  const vals = series.flatMap((p) => [p.kg, p.trend]).concat(targetKg != null ? [targetKg] : []).map(toUnit);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const pad = Math.max(0.5, (hi - lo) * 0.1); lo -= pad; hi += pad;
  const t0 = parseLocalDate(series[0].date).getTime();
  const t1 = parseLocalDate(series[series.length - 1].date).getTime();
  const x = (d) => P.l + ((parseLocalDate(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
  const y = (kg) => P.t + (1 - (toUnit(kg) - lo) / (hi - lo)) * (H - P.t - P.b);
  const ticks = 4;
  let g = '';
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    const yy = P.t + (1 - i / ticks) * (H - P.t - P.b);
    g += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${P.l - 6}" y="${yy + 7}" text-anchor="end">${v.toFixed(1)}</text>`;
  }
  const fmtD = (d) => parseLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  g += `<text x="${P.l}" y="${H - 6}">${fmtD(series[0].date)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtD(series[series.length - 1].date)}</text>`;
  if (targetKg != null) g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(targetKg)}" y2="${y(targetKg)}" stroke="var(--warn)" stroke-dasharray="5 4"/>`;
  const trend = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.trend).toFixed(1)}`).join('');
  const dots = series.map((p) => `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="3" fill="var(--muted)" opacity=".6"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight chart: dots are weigh-ins, line is the smoothed trend${targetKg != null ? ', dashed line is your target' : ''}">${g}${dots}<path d="${trend}" fill="none" stroke="var(--accent)" stroke-width="2.5"/></svg>
    <p class="small muted">Dots are weigh-ins, the green line is your smoothed trend${targetKg != null ? ', the dashed line is your target' : ''} (${S.settings.weightUnit === 'stlb' ? 'stone' : 'kg'}).</p>`;
}

function renderProgress() {
  const t = getTargets();
  const target = t?.targetWeightKg ?? S.profile?.targetWeightKg ?? null;
  const ps = progressSummary(S.weights, target);
  const unit = S.settings.weightUnit;
  let html = `<div class="card"><h2>Log your weight</h2><form id="weight-form"><div class="grid2">
    <div><label for="w-date">Date</label><input id="w-date" name="date" type="date" value="${localDateStr()}" max="${localDateStr()}" required></div>
    <div><label>Weight</label>${weightInputHtml('w', null)}</div></div>
    <div class="row" style="margin-top:8px"><button class="primary" type="submit">Save weight</button></div></form>
    <p class="small muted">Weigh at the same time each day, ideally in the morning after the toilet and before eating.</p></div>`;
  if (ps.latest) {
    const rateTxt = ps.rate == null ? 'Need a week of data' : `${ps.rate <= 0 ? '−' : '+'}${formatWeight(Math.abs(ps.rate), unit)} a week`;
    html += `<div class="card"><div class="kpis">
      <div><b>${formatWeight(ps.latest.trend, unit)}</b><span class="small muted">trend weight</span></div>
      <div><b>${ps.change <= 0 ? '−' : '+'}${formatWeight(Math.abs(ps.change), unit)}</b><span class="small muted">since ${esc(parseLocalDate(ps.start.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</span></div>
      <div><b>${esc(rateTxt)}</b><span class="small muted">last 4 weeks</span></div>
      ${target != null ? `<div><b>${formatWeight(Math.max(0, ps.toGo), unit)}</b><span class="small muted">to target ${formatWeight(target, unit)}</span></div>
      <div><b>${ps.goalDate ? esc(parseLocalDate(ps.goalDate).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })) : '–'}</b><span class="small muted">goal at current rate</span></div>` : ''}
      ${t ? `<div><b>${fmt(t.bmi, 1)}</b><span class="small muted">BMI (${esc(t.bmiCategory)})</span></div>` : ''}
    </div>
    ${ps.rate != null && ps.rate < -SAFETY.maxWeeklyLossKg - 0.1 ? '<div class="notice warn">You are losing more than 1 kg a week. That is faster than the NHS recommends; consider eating a little more.</div>' : ''}
    ${chartSvg(ps.series, target)}</div>
    <div class="card"><h3>History</h3><table><thead><tr><th>Date</th><th class="num">Weight</th><th class="num">Trend</th><th></th></tr></thead><tbody>
    ${ps.series.slice(-60).reverse().map((p) => `<tr><td>${esc(parseLocalDate(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }))}</td><td class="num">${formatWeight(p.kg, unit)}</td><td class="num muted">${formatWeight(p.trend, unit)}</td>
      <td class="num"><button class="link danger" data-action="del-weight" data-date="${p.date}" aria-label="Delete">✕</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  view.innerHTML = html;
}

// ---------- Profile ----------

function renderProfile() {
  const p = S.profile ?? { sex: '', age: '', heightCm: '', weightKg: currentWeight(S), activity: 'light', goal: 'lose', weeklyLossKg: 0.5, targetWeightKg: null };
  const t = getTargets();
  const hUnit = S.settings.heightUnit;
  const h = p.heightCm ? cmToFtIn(p.heightCm) : { ft: '', inch: '' };
  let html = '';
  if (!S.acceptedDisclaimer) {
    html += `<div class="card"><h2>Before you start</h2><p>This app gives general guidance based on UK public health references. It is not medical advice and is not suitable for children, during pregnancy or breastfeeding, or if you have or have had an eating disorder. If you have a medical condition (for example diabetes or kidney disease) or take medication, speak to your GP before changing your diet.</p>
      <button class="primary" data-action="accept">I understand</button></div>`;
    view.innerHTML = html;
    return;
  }
  html += `<div class="card"><h2>Your details</h2><form id="profile-form">
    <div class="grid2">
      <div><label for="sex">Sex (for the energy formula)</label><select id="sex" name="sex" required><option value="">Choose…</option>
        <option value="female" ${p.sex === 'female' ? 'selected' : ''}>Female</option><option value="male" ${p.sex === 'male' ? 'selected' : ''}>Male</option></select></div>
      <div><label for="age">Age</label><input id="age" name="age" type="number" inputmode="numeric" min="18" max="120" value="${p.age ?? ''}" required></div>
      <div><label>Height <button type="button" class="link small" data-action="toggle-height">${hUnit === 'cm' ? 'use ft/in' : 'use cm'}</button></label>
        ${hUnit === 'cm' ? `<input name="heightCm" type="number" inputmode="decimal" min="120" max="230" step="0.5" value="${p.heightCm ?? ''}" aria-label="Height in cm" placeholder="cm" required>`
          : `<div class="row"><input name="ft" type="number" min="4" max="7" value="${h.ft}" aria-label="Feet" placeholder="ft" style="width:5em" required><input name="in" type="number" min="0" max="11" value="${h.inch}" aria-label="Inches" placeholder="in" style="width:5em"></div>`}</div>
      <div><label>Current weight <button type="button" class="link small" data-action="toggle-weight">${S.settings.weightUnit === 'kg' ? 'use st/lb' : 'use kg'}</button></label>${weightInputHtml('weight', currentWeight(S))}</div>
    </div>
    <label for="activity">Activity level</label><select id="activity" name="activity">${ACTIVITY_LEVELS.map((a) => `<option value="${a.id}" ${p.activity === a.id ? 'selected' : ''}>${esc(a.label)} – ${esc(a.hint)}</option>`).join('')}</select>
    <div class="grid2">
      <div><label for="goal">Goal</label><select id="goal" name="goal"><option value="lose" ${p.goal === 'lose' ? 'selected' : ''}>Lose weight</option><option value="maintain" ${p.goal === 'maintain' ? 'selected' : ''}>Maintain weight</option></select></div>
      <div><label for="rate">Weekly loss</label><select id="rate" name="rate">${LOSS_RATES.map((r) => `<option value="${r}" ${p.weeklyLossKg === r ? 'selected' : ''}>${r} kg (${(r * 2.20462).toFixed(1)} lb) a week${r === 0.5 ? ' – recommended' : ''}</option>`).join('')}</select></div>
    </div>
    <label>Target weight (optional)</label>${weightInputHtml('target', p.targetWeightKg)}
    <label class="inline"><input type="checkbox" name="pregnant" ${p.pregnant ? 'checked' : ''}> I'm pregnant or breastfeeding</label>
    <label class="inline"><input type="checkbox" name="medical" ${p.medicalConditions ? 'checked' : ''}> I have a medical condition or take regular medication</label>
    <div class="row" style="margin-top:10px"><button class="primary" type="submit">Save and calculate</button></div>
  </form></div>`;

  if (t) {
    html += `<div class="card"><h2>Your daily targets</h2>
      ${t.blocked ? `<div class="notice bad">${esc(t.blocked)}</div>` : ''}
      ${t.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`).join('')}
      <div class="kpis"><div><b>${fmt(t.kcal)}</b><span class="small muted">kcal a day</span></div>
      <div><b>${fmt(t.tdee)}</b><span class="small muted">maintenance kcal</span></div>
      <div><b>${fmt(t.bmr)}</b><span class="small muted">resting kcal (BMR)</span></div>
      <div><b>${t.weeklyLossKg} kg</b><span class="small muted">expected loss a week</span></div>
      <div><b>${fmt(t.bmi, 1)}</b><span class="small muted">BMI · ${esc(t.bmiCategory)}</span></div>
      <div><b>${t.weeksToGoal ?? '–'}</b><span class="small muted">weeks to target (est.)</span></div></div>
      <p class="small muted">Healthy weight for your height (BMI 18.5–24.9): ${formatWeight(t.healthyWeightRange[0], S.settings.weightUnit)} to ${formatWeight(t.healthyWeightRange[1], S.settings.weightUnit)}. BMI is less accurate for very muscular people and some ethnic groups (the NHS uses lower thresholds for people of South Asian, Chinese, Middle Eastern, Black African or African-Caribbean origin).</p>
      ${t.notes.map((n) => `<p class="small muted">${esc(n)}</p>`).join('')}
      <table><thead><tr><th>Nutrient</th><th class="num">Daily target</th></tr></thead><tbody>
      ${Object.entries(t.macros).map(([k, m]) => `<tr><td>${esc(NUTRIENT_BY_KEY[k].label)}</td><td class="num">${m.kind === 'max' ? 'under ' : m.kind === 'min' ? 'at least ' : ''}${m.target ?? m.max} g</td></tr>`).join('')}
      ${Object.entries(t.micros).map(([k, v]) => `<tr><td>${esc(NUTRIENT_BY_KEY[k].label)}</td><td class="num">${v} ${esc(NUTRIENT_BY_KEY[k].unit)}</td></tr>`).join('')}
      </tbody></table>
      <details><summary class="small">How these are worked out</summary><div class="small muted">
      <p>Resting energy uses the Mifflin-St Jeor equation, multiplied by your activity level to estimate maintenance calories. For weight loss the app takes off about 7,700 kcal per kg of weekly loss, but never sets a target below ${SAFETY.minKcal.female} kcal (women) or ${SAFETY.minKcal.male} kcal (men), and never plans more than 1 kg or 1% of your body weight a week.</p>
      <p>Protein is 1.4 g per kg of a reference weight (your weight, capped at a BMI of 25) when losing weight, to help keep muscle. Fat is 30% of energy (UK guidance: no more than 35%), saturated fat under 10% (SACN 2019), fibre 30 g (SACN 2015), salt under 6 g, and sugars under the UK label reference of 90 g per 2,000 kcal. The NHS also advises keeping free sugars (added sugar, honey, juice) under 30 g a day; labels don't separate these.</p>
      <p>Vitamins and minerals are UK Reference Nutrient Intakes for adults (Department of Health 1991, vitamin D from SACN 2016). Vitamin K has no RNI; the UK safe intake of 1 µg per kg is used.</p>
      <p>Everyone's needs differ; these formulas are typically within about 10% for most people. Use your weight trend over 3–4 weeks to adjust.</p></div></details></div>`;
  }

  html += `<div class="card"><h2>Your data</h2><p class="small muted">${cloud ? 'Your data is saved privately to your Claude account, so it is there on any device where you open this page. Nobody else can see it.' : 'Everything is stored only in this browser on this device. Export a backup regularly, and to move to another device.'}</p>
    <div class="row"><button data-action="export">Export backup</button><label class="btn" style="margin:0;color:var(--text)">Import backup<input type="file" accept="application/json,.json" data-action="import" hidden></label>
    <button class="danger" data-action="reset">Delete all data</button></div></div>
    <div class="card"><h2>About the food data</h2><div class="small">
    <p><strong>UK basics</strong> (${baseFoods.filter((f) => f.src === 'core').length} foods): common foods with UK names and portion sizes. Values come from the USDA reference database matched to the closest UK equivalent, e.g. UK milk without added vitamin D.</p>
    <p><strong>Reference foods</strong> (${baseFoods.filter((f) => f.src === 'usda').length.toLocaleString('en-GB')}): USDA National Nutrient Database SR28 (public domain), with carbohydrate converted to the UK basis (fibre excluded) and sodium to salt. Names are American.</p>
    <p><strong>UK supermarket products</strong>: searched live from Open Food Facts (open data, ODbL), filtered to products sold in the UK${offPack.length ? `, plus ${offPack.length.toLocaleString('en-GB')} products saved for offline use` : ''}. It covers a large share of big-brand and own-label products from Tesco, Sainsbury's, Asda, Morrisons, Aldi, Lidl, Waitrose, M&S, Co-op and Iceland, but not every product, and labels are entered by volunteers so can be out of date. Most products list only label nutrients, not vitamins and minerals.</p>
    ${inArtifact ? '<p><strong>In this preview</strong> the live product search is switched off, because preview pages cannot connect to other websites. Packaged foods can be added from their label.</p>' : '<p>For a missing product, scan or type its barcode, or create it from the label.</p>'}</div></div>
    <p class="small muted" style="text-align:center">Not medical advice. For weight-loss support, the NHS Weight Loss Plan app and your GP are good places to start.</p>`;
  view.innerHTML = html;
}

function submitProfile(form) {
  const v = (k) => numOrNull(form.elements[k]?.value);
  const heightCm = S.settings.heightUnit === 'cm' ? v('heightCm') : (v('ft') == null ? null : ftInToCm(v('ft'), v('in') ?? 0));
  const weightKg = readWeight(form, 'weight');
  const targetWeightKg = readWeight(form, 'target');
  const profile = {
    sex: form.elements.sex.value,
    age: v('age'),
    heightCm: heightCm == null ? null : round(heightCm, 1),
    weightKg: weightKg == null ? null : round(weightKg, 2),
    activity: form.elements.activity.value,
    goal: form.elements.goal.value,
    weeklyLossKg: Number(form.elements.rate.value),
    targetWeightKg: targetWeightKg == null ? null : round(targetWeightKg, 1),
    pregnant: form.elements.pregnant.checked,
    medicalConditions: form.elements.medical.checked,
  };
  const t = computeTargets(profile);
  if (!t.ok) { toast(t.errors.join('. '), 6000); return; }
  let next = { ...S, profile };
  const latest = S.weights[S.weights.length - 1];
  if (!latest || Math.abs(latest.kg - profile.weightKg) > 0.05) next = setWeight(next, localDateStr(), profile.weightKg);
  commit(next);
  toast('Targets updated');
}

function askConfirm(message, label, onYes) {
  askConfirm.pending = onYes;
  openSheet('Are you sure?', `<p>${esc(message)}</p><div class="row"><button class="danger" data-action="confirm-yes">${esc(label)}</button><button data-action="close-sheet">Cancel</button></div>`);
}

// Days older than the ones loaded at start come from account storage on demand.
const fetchedDays = new Set();
async function loadOlderDay(date) {
  if (!cloud || fetchedDays.has(date) || S.diary[date] || S.stamps?.[dayDocId(date)]) return;
  fetchedDays.add(date);
  try {
    const doc = await cloud.loadDay(date);
    if (doc?.entries?.length) {
      const { state } = mergeRemote(S, { [dayDocId(date)]: doc });
      S = state;
      saveState(storage ?? memoryStorage, S);
      render();
    }
  } catch { /* stays empty */ }
}

async function connectCloud() {
  try {
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    downloads = await window.claude.use('downloads');
    sample = await window.claude.use('sample');
    if (sample && currentTab() === 'plan') render();
    const uid = db && user ? await user.id() : null;
    if (!db || !uid) { $('#status').textContent = 'Saved on this device only'; return; }
    const sync = createCloudSync({ db, uid, getState: () => S, onError: (e) => toast(e?.code === 'quota_exceeded' ? 'Your account storage for this page is full. Export a backup.' : "Couldn't save to your account. Changes are kept on this device for now.", 6000) });
    $('#status').textContent = 'Syncing…';
    const remote = await sync.loadAll();
    const { state, push } = mergeRemote(S, remote);
    S = state;
    saveState(storage ?? memoryStorage, S);
    cloud = sync;
    if (push.length) cloud.queue(push, 0);
    rebuildFoods();
    render();
    $('#status').textContent = 'Saved to your account';
  } catch (e) {
    $('#status').textContent = 'Saved on this device only';
  }
}

// ---------- Router and events ----------

function currentTab() {
  const h = location.hash.replace('#', '');
  return ['today', 'plan', 'progress', 'profile'].includes(h) ? h : 'today';
}

function render() {
  if (!S.acceptedDisclaimer && currentTab() !== 'profile') { location.hash = '#profile'; return; }
  const tab = currentTab();
  document.querySelectorAll('.tabs a').forEach((a) => { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  ({ today: renderToday, plan: renderPlan, progress: renderProgress, profile: renderProfile })[tab]();
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'close-sheet': closeSheet(); break;
    case 'day': currentDate = addDays(currentDate, Number(el.dataset.delta)); render(); loadOlderDay(currentDate); break;
    case 'add-food': openAddFood(el.dataset.slot); break;
    case 'add-mode': setAddMode(el.dataset.mode); break;
    case 'scan': startScanner(); break;
    case 'pick-food': openPortion(addResults[Number(el.dataset.i)]); break;
    case 'edit-entry': openEditEntry(el.dataset.id); break;
    case 'delete-entry': commit(removeEntry(S, currentDate, editingEntry.id)); closeSheet(); break;
    case 'custom-food': openCustomFood(); break;
    case 'quick-add': openQuickAdd(); break;
    case 'swap': openSwap(Number(el.dataset.day), el.dataset.slot); break;
    case 'do-swap': {
      const meal = openSwap.alts[Number(el.dataset.i)];
      commit({ ...S, plan: { ...replaceMeal(S.plan, Number(el.dataset.day), meal, getTargets()), startDate: S.plan.startDate } });
      closeSheet();
      break;
    }
    case 'log-meal': logPlannedMeals(Number(el.dataset.day), [el.dataset.slot]); break;
    case 'log-day': logPlannedMeals(Number(el.dataset.day), SLOTS); break;
    case 'shopping': shoppingEdit = false; openShopping(); break;
    case 'edit-prices': shoppingEdit = !shoppingEdit; openShopping(); break;
    case 'reset-prices': commit({ ...S, priceOverrides: {} }, { rerender: true }); openShopping(); break;
    case 'prep-guide': openPrepGuide(); break;
    case 'keep-prep': {
      const options = { ...S.planOptions, prep: { ...S.planOptions.prep, [el.dataset.slot]: el.dataset.id } };
      commit({ ...S, planOptions: options });
      openPrepGuide();
      toast('Kept for future weeks');
      break;
    }
    case 'do-prep-swap': {
      const id = openSwap.prep[Number(el.dataset.i)];
      closeSheet();
      makePlan({ ...S.planOptions, prep: { ...S.planOptions.prep, [el.dataset.slot]: id } }, { seed: S.plan.createdWith?.seed ?? 1, quiet: true });
      break;
    }
    case 'choose-dislikes': openDislikes(); break;
    case 'undislike-food': toast(applyOptions({ ...S.planOptions, dislikedFoods: S.planOptions.dislikedFoods.filter((x) => x !== el.dataset.id) }) || 'Removed'); break;
    case 'undislike-meal': toast(applyOptions({ ...S.planOptions, dislikedMeals: S.planOptions.dislikedMeals.filter((x) => x !== el.dataset.id) }) || 'Removed'); break;
    case 'meal-dislike': openMealDislike(Number(el.dataset.day), el.dataset.slot); break;
    case 'dislike-food': {
      const id = el.dataset.id;
      closeSheet();
      const msg = applyOptions({ ...S.planOptions, dislikedFoods: [...new Set([...(S.planOptions.dislikedFoods ?? []), id])] });
      toast(`${foodName(id)} won't be planned. ${msg}`, 5000);
      break;
    }
    case 'dislike-meal': {
      const id = el.dataset.id;
      closeSheet();
      const msg = applyOptions({ ...S.planOptions, dislikedMeals: [...new Set([...(S.planOptions.dislikedMeals ?? []), id])] });
      toast(`${mealName(id)} won't be suggested. ${msg}`, 5000);
      break;
    }
    case 'copy-list': navigator.clipboard?.writeText(openShopping.text).then(() => toast('Copied'), () => toast('Copy failed')); break;
    case 'del-weight': askConfirm('Delete this weight entry?', 'Delete', () => commit(removeWeight(S, el.dataset.date))); break;
    case 'confirm-yes': { const fn = askConfirm.pending; askConfirm.pending = null; closeSheet(); fn?.(); break; }
    case 'accept': commit({ ...S, acceptedDisclaimer: true }); break;
    case 'toggle-height': commit({ ...S, settings: { ...S.settings, heightUnit: S.settings.heightUnit === 'cm' ? 'ftin' : 'cm' } }); break;
    case 'toggle-weight': commit({ ...S, settings: { ...S.settings, weightUnit: S.settings.weightUnit === 'kg' ? 'stlb' : 'kg' } }); break;
    case 'export': {
      if (inArtifact) {
        if (!downloads) { toast('Saving files isn\'t available here.'); break; }
        downloads.save({ filename: `calorie-tracker-backup-${localDateStr()}.json`, data: exportState(S) })
          .then(() => toast('Backup saved'), () => toast('Backup not saved'));
        break;
      }
      const blob = new Blob([exportState(S)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `calorie-tracker-backup-${localDateStr()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      break;
    }
    case 'reset':
      askConfirm('Delete all your diary entries, weights, foods and plans? Export a backup first if you might want them.', 'Delete everything', () => {
        commit({ ...emptyState(), acceptedDisclaimer: true, stamps: S.stamps });
        // Clear every saved diary day too, not only the ones in memory.
        if (cloud) cloud.queue(Object.keys(S.stamps ?? {}).filter((id) => id.startsWith('d-')));
      });
      break;
    default: break;
  }
});

document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"][data-action], li[data-action]')) {
    ev.preventDefault();
    ev.target.click();
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.matches('[data-action="import"]')) {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const next = importState(await file.text());
      askConfirm('Replace your current data with this backup?', 'Restore backup', () => { commit({ ...next, stamps: S.stamps }); toast('Backup restored'); });
    } catch (e) { toast(e.message, 6000); }
    ev.target.value = '';
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.closest('#portion-form')) updatePortionPreview();
  if (ev.target.id === 'dislike-filter') openDislikes(ev.target.value);
});

// Edited shopping prices are saved when the field is left.
document.addEventListener('change', (ev) => {
  // Plan settings are kept as soon as they change, so other actions on the
  // page (choosing dislikes, the coach) don't undo them.
  const planForm = ev.target.closest('#plan-form');
  if (planForm) {
    const next = readPlanForm(planForm);
    const refresh = ev.target.name === 'diet' || ev.target.name === 'exclude';
    commit({ ...S, planOptions: next }, { rerender: refresh });
    return;
  }
  if (ev.target.name === 'food' && ev.target.closest('#dislike-form')) {
    if (ev.target.checked) openDislikes.pending.add(ev.target.value); else openDislikes.pending.delete(ev.target.value);
    return;
  }
  const id = ev.target.dataset?.priceId;
  if (!id) return;
  const v = Number(ev.target.value);
  if (ev.target.value === '' || !Number.isFinite(v) || v < 0 || v >= 1000) { toast('Enter a price in pounds, like 1.25'); return; }
  commit({ ...S, priceOverrides: { ...S.priceOverrides, [id]: Math.round(v * 100) / 100 } }, { rerender: true });
  openShopping();
  document.querySelector(`[data-price-id="${CSS.escape(id)}"]`)?.focus();
});

document.addEventListener('submit', (ev) => {
  const f = ev.target;
  ev.preventDefault();
  if (f.id === 'search-form') runSearch(f);
  else if (f.id === 'portion-form') submitPortion();
  else if (f.id === 'custom-form') submitCustomFood(f);
  else if (f.id === 'quick-form') submitQuickAdd(f);
  else if (f.id === 'plan-form') submitPlan(f);
  else if (f.id === 'dislike-form') submitDislikes();
  else if (f.id === 'coach-form') sendCoach(f);
  else if (f.id === 'profile-form') submitProfile(f);
  else if (f.id === 'weight-form') {
    try {
      const kg = readWeight(f, 'w');
      if (kg == null) throw new Error('Enter your weight');
      const date = f.elements.date.value;
      if (!date || date > localDateStr()) throw new Error("Choose a date that isn't in the future");
      commit(setWeight(S, date, kg));
      toast('Weight saved');
    } catch (e) { toast(e.message); }
  }
});

sheet.addEventListener('close', stopScanner);
window.addEventListener('hashchange', () => { closeSheet(); render(); });

async function init() {
  if (loaded.error) toast(loaded.error, 8000);
  try {
    const res = await fetch('data/foods.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    baseFoods = unpackDatabase(await res.json());
  } catch (e) {
    view.innerHTML = `<div class="notice bad">The food database could not be loaded (${esc(e.message)}). Make sure the app is opened from a web server, not as a file.</div>`;
    return;
  }
  // Optional offline product packs (see scripts/import-off-uk.mjs), listed in data/packs.json.
  try {
    const packs = await (await fetch('data/packs.json')).json();
    for (const name of Array.isArray(packs) ? packs : []) {
      const res = await fetch(`data/${encodeURIComponent(name)}`);
      if (res.ok) offPack = offPack.concat(unpackDatabase(await res.json()));
    }
  } catch { /* no packs */ }
  rebuildFoods();
  $('#status').textContent = '';
  render();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (inArtifact) connectCloud();
  else if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.__app = { get state() { return S; }, get foods() { return foods; } }; // for tests and debugging
init();
