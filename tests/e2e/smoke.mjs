// Browser smoke test: drives the real app in Chromium (phone-sized), with
// Open Food Facts mocked so it runs offline and deterministically.
// Run: node tests/e2e/smoke.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../../scripts/serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = 8765;
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const results = [];
async function step(name, fn) {
  await page.evaluate(() => { const d = document.querySelector('#sheet'); if (d?.open) d.close(); }).catch(() => {});
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 3).join(' ')]); }
}

const server = await startServer(PORT);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-GB', acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('net::ERR_FAILED')) errors.push(m.text()); }); // ERR_FAILED: the deliberately failed search request
page.on('dialog', (d) => d.accept());
let offCalls = 0;
await page.route('https://images.openfoodfacts.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
// The newer search service is made to fail so the fallback path is exercised.
await page.route('https://search.openfoodfacts.org/**', (route) => route.abort('failed'));
await page.route('https://world.openfoodfacts.org/**', (route) => {
  offCalls += 1;
  const url = route.request().url();
  if (url.includes('/cgi/search.pl')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fixture('off-search.json') });
  if (url.includes('/api/v2/product/5000000000005')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"status":0,"status_verbose":"product not found"}' });
  if (url.includes('/api/v2/product/')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fixture('off-product.json') });
  return route.fulfill({ status: 404, body: '' });
});

const base = `http://127.0.0.1:${PORT}/`;
const TAB_READY = { today: '.datebar', plan: '#plan-form, main .notice', progress: '#weight-form', profile: '#profile-form' };
async function tab(name) {
  await page.click(`a[data-tab="${name}"]`);
  await page.waitForFunction((n) => document.querySelector(`a[data-tab="${n}"]`).getAttribute('aria-current') === 'page', name);
  await page.waitForSelector(TAB_READY[name]);
}
const kcalShown = async () => Number((await page.locator('.card .big').first().innerText()).replace(/[^\d]/g, ''));

await step('first visit shows the disclaimer', async () => {
  await page.goto(base);
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.waitForSelector('#profile-form');
});

await step('profile saves and shows targets', async () => {
  await page.selectOption('#sex', 'male');
  await page.fill('#age', '40');
  await page.fill('input[name="heightCm"]', '180');
  await page.fill('input[name="weight"]', '100');
  await page.selectOption('#activity', 'light');
  await page.selectOption('#rate', '0.5');
  await page.fill('input[name="target"]', '85');
  await page.getByRole('button', { name: 'Save and calculate' }).click();
  await page.waitForSelector('text=Your daily targets');
  const text = await page.locator('.kpis').first().innerText();
  // Mifflin: 10*100 + 6.25*180 - 5*40 + 5 = 1930; x1.375 = 2654; -550 = 2104 -> 2100
  assert.match(text, /2,100\s*kcal a day/);
  assert.match(text, /2,654/);
  assert.match(text, /1,930/);
});

await step('invalid profile input is blocked by the form', async () => {
  await page.fill('#age', '');
  await page.getByRole('button', { name: 'Save and calculate' }).click();
  assert.equal(await page.locator('#age:invalid').count(), 1);
  assert.match(await page.locator('.kpis').first().innerText(), /2,100/);
  await page.fill('#age', '40');
});

await step('search and log a food', async () => {
  await tab('today');
  await page.click('button[data-slot="breakfast"]');
  await page.fill('input[name="q"]', 'porridge');
  await page.press('input[name="q"]', 'Enter');
  const first = page.locator('#search-results li').first();
  assert.match(await first.innerText(), /Porridge oats/);
  await first.click();
  await page.fill('#p-qty', '1');
  await page.selectOption('#p-unit', { label: /Serving \(40 g\)/ }).catch(async () => {
    const opts = await page.locator('#p-unit option').allInnerTexts();
    await page.selectOption('#p-unit', String(opts.findIndex((o) => o.includes('40 g'))));
  });
  assert.match(await page.locator('#p-preview').innerText(), /152 kcal/); // 379 kcal/100 g x 0.4
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForSelector('.entry');
  assert.equal(await kcalShown(), 152);
});

await step('UK synonym search finds US-named foods', async () => {
  await page.click('button[data-slot="lunch"]');
  await page.fill('input[name="q"]', 'courgette');
  await page.press('input[name="q"]', 'Enter');
  const all = await page.locator('#search-results').innerText();
  assert.match(all, /Courgette/);
  assert.match(all, /zucchini/i);
  await page.click('[data-action="close-sheet"]');
});

await step('edit an entry amount', async () => {
  await page.click('.entry');
  await page.selectOption('#p-unit', String((await page.locator('#p-unit option').count()) - 1));
  await page.fill('#p-qty', '50');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(100);
  assert.equal(await kcalShown(), 190); // 379 x 0.5 = 189.5
});

await step('UK supermarket search (mocked Open Food Facts) and add product', async () => {
  await page.click('button[data-slot="lunch"]');
  await page.click('button[data-mode="off"]');
  await page.fill('input[name="q"]', 'houmous');
  await page.press('input[name="q"]', 'Enter');
  await page.waitForSelector('#search-results li');
  const items = await page.locator('#search-results li').allInnerTexts();
  assert.equal(items.length, 2, 'products without energy are dropped');
  assert.match(items[0], /Classic Houmous/);
  await page.locator('#search-results li').first().click();
  assert.match(await page.locator('#p-unit').innerText(), /Serving/);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await kcalShown(), 190 + 98); // 30 g of a 327 kcal/100 g houmous = 98
});

await step('rapid second product search is throttled, not sent', async () => {
  const before = offCalls;
  await page.click('button[data-slot="snack"]');
  await page.click('button[data-mode="off"]');
  await page.fill('input[name="q"]', 'crisps');
  await page.press('input[name="q"]', 'Enter');
  assert.match(await page.locator('#search-msg').innerText(), /wait/i);
  assert.equal(offCalls, before);
});

await step('barcode lookup, including unknown barcode', async () => {
  await page.click('button[data-slot="snack"]');
  await page.click('button[data-mode="barcode"]');
  await page.fill('#barcode', '5000000000005');
  await page.press('#barcode', 'Enter');
  await page.waitForTimeout(200);
  assert.match(await page.locator('#search-results').innerText(), /isn't on Open Food Facts/);
  await page.fill('#barcode', '5010029000016');
  await page.press('#barcode', 'Enter');
  await page.waitForSelector('#search-results li');
  assert.match(await page.locator('#search-results').innerText(), /Wholegrain Wheat Biscuits/);
  await page.fill('#barcode', '12345');
  await page.press('#barcode', 'Enter');
  assert.match(await page.locator('#search-msg').innerText(), /doesn't look right/);
  await page.click('[data-action="close-sheet"]');
});

await step('custom food validation and creation', async () => {
  await page.click('button[data-slot="dinner"]');
  await page.click('[data-action="custom-food"]');
  await page.fill('#c-name', 'Nan\'s lasagne <b>');
  await page.fill('#c-kcal', '150');
  await page.fill('#c-fat', '5');
  await page.fill('#c-satfat', '9');
  await page.getByRole('button', { name: 'Save and add' }).click();
  assert.match(await page.locator('#toast').innerText(), /Saturates cannot be more than fat/);
  await page.fill('#c-satfat', '2');
  await page.fill('#c-servingG', '350');
  await page.getByRole('button', { name: 'Save and add' }).click();
  await page.waitForSelector('#portion-form');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(100);
  const entries = await page.locator('.entry').allInnerTexts();
  assert.ok(entries.some((e) => e.includes("Nan's lasagne <b>")), 'name shown as text, not HTML');
  assert.equal(await kcalShown(), 190 + 98 + 525);
});

await step('quick add', async () => {
  await page.click('button[data-slot="snack"]');
  await page.click('[data-action="quick-add"]');
  await page.fill('#q-kcal', '120');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await kcalShown(), 190 + 98 + 525 + 120);
});

await step('micronutrient panel renders', async () => {
  await page.click('details.card summary');
  const txt = await page.locator('details.card').innerText();
  assert.match(txt, /Vitamin C/);
  assert.match(txt, /Iron/);
});

await step('previous day navigation shows an empty day', async () => {
  await page.click('[data-action="day"][data-delta="-1"]');
  assert.equal(await kcalShown(), 0);
  await page.click('[data-action="day"][data-delta="1"]');
});

await step('log weights and see trend', async () => {
  await tab('progress');
  const d = new Date();
  for (const [ago, kg] of [[14, 101.2], [10, 100.6], [7, 100.4], [3, 99.8], [0, 99.5]]) {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ago);
    const s = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    await page.fill('#w-date', s);
    await page.fill('input[name="w"]', String(kg));
    await page.getByRole('button', { name: 'Save weight' }).click();
    await page.waitForTimeout(50);
  }
  await page.waitForSelector('svg.chart');
  const k = await page.locator('.kpis').innerText();
  assert.match(k, /a week/);
  assert.match(k, /to target/);
});

await step('meal plan generates 7 days near target', async () => {
  await tab('plan');
  await page.getByRole('button', { name: 'Make my plan' }).click();
  await page.waitForSelector('.day-card', { timeout: 10000 });
  assert.equal(await page.locator('.day-card').count(), 7);
  const avg = Number((await page.locator('.kpis b').first().innerText()).replace(/[^\d]/g, ''));
  const target = Number((await page.locator('.kpis span').first().innerText()).replace(/[^\d]/g, ''));
  assert.ok(Math.abs(avg - target) / target < 0.05, `average ${avg} vs target ${target}`);
});

await step('vegan plan has no animal products', async () => {
  await page.selectOption('#diet', 'vegan');
  await page.getByRole('button', { name: 'Make a new plan' }).click();
  await page.waitForTimeout(500);
  const txt = (await page.locator('main').innerText()).toLowerCase();
  for (const bad of ['chicken', 'salmon', 'egg,', 'milk', 'yogurt', 'cheese', 'beef', 'tuna', 'honey', 'prawn']) {
    assert.ok(!txt.includes(`g ${bad}`), `found ${bad}`);
  }
  assert.match(txt, /vitamin b12/);
});

await step('swap a meal', async () => {
  const before = await page.locator('.day-card[open] .meal strong').nth(2).innerText();
  await page.locator('.day-card[open] [data-action="swap"][data-slot="dinner"]').click();
  await page.locator('#sheet-body li').first().click();
  const after = await page.locator('.day-card[open] .meal strong').nth(2).innerText();
  assert.notEqual(before, after);
});

await step('shopping list', async () => {
  await page.click('[data-action="shopping"]');
  const txt = await page.locator('#sheet-body').innerText();
  assert.match(txt, /Vegetables/);
  assert.match(txt, /\d+ g/);
  await page.click('[data-action="close-sheet"]');
});

await step('shopping list shows estimated prices you can change', async () => {
  await page.click('[data-action="shopping"]');
  const txt = await page.locator('#sheet-body').innerText();
  assert.match(txt, /About £\d+\.\d\d at the till/);
  assert.match(txt, /estimates/);
  await page.click('[data-action="edit-prices"]');
  const input = page.locator('.price-input').first();
  const id = await input.getAttribute('data-price-id');
  await input.fill('9.99');
  await input.dispatchEvent('change');
  assert.equal(await page.evaluate((k) => window.__app.state.priceOverrides[k], id), 9.99);
  await page.click('[data-action="reset-prices"]');
  assert.deepEqual(await page.evaluate(() => window.__app.state.priceOverrides), {});
  await page.click('[data-action="close-sheet"]');
  assert.match(await page.locator('#plan-cost').innerText(), /£\d/);
});

const planFoodIds = () => page.evaluate(() => window.__app.state.plan.days.flatMap((d) => d.meals.flatMap((m) => m.items.map((i) => i.foodId))));

await step('foods she won\'t eat are never planned', async () => {
  await page.selectOption('#diet', 'omnivore');
  await page.click('[data-action="choose-dislikes"]');
  await page.fill('#dislike-filter', 'mushroom');
  await page.locator('#dislike-list input[value="mushrooms"]').check();
  await page.fill('#dislike-filter', 'salmon');
  for (const box of await page.locator('#dislike-list input').all()) await box.check();
  await page.fill('#dislike-filter', '');
  assert.ok(await page.locator('#dislike-list input[value="mushrooms"]').isChecked(), 'tick kept after filtering');
  await page.getByRole('button', { name: 'Save' }).click();
  const disliked = await page.evaluate(() => window.__app.state.planOptions.dislikedFoods);
  assert.ok(disliked.includes('mushrooms') && disliked.includes('salmon-cooked'), disliked.join());
  assert.match(await page.locator('#disliked-chips').innerText(), /Mushrooms/);
  await page.getByRole('button', { name: 'Make a new plan' }).click();
  await page.waitForTimeout(400);
  const used = await planFoodIds();
  for (const id of ['uk:mushrooms', 'uk:salmon-cooked', 'uk:salmon-raw', 'uk:smoked-salmon']) assert.ok(!used.includes(id), id);
  // Meals with a disliked ingredient are kept with a swap, and say so.
  const adapted = await page.evaluate(() => window.__app.state.plan.days.flatMap((d) => d.meals).filter((m) => m.swaps).length);
  if (adapted) assert.match(await page.locator('main').innerText(), /Changed for her: /);
});

await step('"won\'t eat this" removes an ingredient from the whole plan', async () => {
  await page.locator('.day-card[open] [data-action="meal-dislike"]').first().click();
  const li = page.locator('#sheet-body li').first();
  const id = await li.getAttribute('data-id');
  await li.click();
  assert.ok(await page.evaluate((k) => window.__app.state.planOptions.dislikedFoods.includes(k), id));
  assert.ok(!(await planFoodIds()).includes(`uk:${id}`), id);
  await page.locator('.day-card[open] [data-action="meal-dislike"]').nth(2).click();
  const mealId = await page.locator('[data-action="dislike-meal"]').getAttribute('data-id');
  await page.click('[data-action="dislike-meal"]');
  assert.ok(!(await page.evaluate(() => window.__app.state.plan.days.flatMap((d) => d.meals.map((m) => m.mealId)))).includes(mealId));
});

await step('meal prep: same breakfast and lunch every day, with a prep guide', async () => {
  await page.selectOption('#prep-breakfast', 'auto');
  await page.selectOption('#prep-lunch', 'l-lentil-soup');
  await page.getByRole('button', { name: 'Make a new plan' }).click();
  await page.waitForTimeout(400);
  const days = await page.evaluate(() => window.__app.state.plan.days.map((d) => [d.meals[0].mealId, d.meals[1].mealId, JSON.stringify(d.meals[0].items)]));
  assert.equal(new Set(days.map((d) => d[0])).size, 1);
  assert.equal(new Set(days.map((d) => d[2])).size, 1, 'same breakfast portion every day');
  assert.ok(days.every((d) => d[1] === 'l-lentil-soup'));
  await page.click('[data-action="prep-guide"]');
  const guide = await page.locator('#sheet-body').innerText();
  assert.match(guide, /Lentil and vegetable soup/);
  assert.match(guide, /make 4 portions/);
  await page.click('[data-action="close-sheet"]');
  // Swapping a prep meal changes it on every day.
  await page.locator('.day-card[open] [data-action="swap"][data-slot="lunch"]').click();
  await page.locator('#sheet-body li').first().click();
  await page.waitForTimeout(400);
  const lunches = await page.evaluate(() => window.__app.state.plan.days.map((d) => d.meals[1].mealId));
  assert.equal(new Set(lunches).size, 1);
  assert.notEqual(lunches[0], 'l-lentil-soup');
});

await step('coach understands what she won\'t eat and updates the plan', async () => {
  await page.fill('#coach-text', "She won't eat tuna or feta, but she likes chicken");
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForSelector('.bubble.coach');
  const txt = await page.locator('#coach').innerText();
  assert.match(txt, /Swapped out or left out of meals: .*Tuna/);
  const disliked = await page.evaluate(() => window.__app.state.planOptions.dislikedFoods);
  assert.ok(disliked.includes('tuna-tin') && disliked.includes('feta'));
  const used = await planFoodIds();
  assert.ok(!used.includes('uk:tuna-tin') && !used.includes('uk:feta'));
  await page.locator('[data-action="undislike-food"][data-id="feta"]').click();
  assert.ok(!(await page.evaluate(() => window.__app.state.planOptions.dislikedFoods)).includes('feta'));
});

await step('log planned day to diary as one entry per meal', async () => {
  const dayKcal = Number((await page.locator('.day-card[open] summary span').innerText()).split('kcal')[0].replace(/[^\d]/g, ''));
  const before = await page.evaluate(() => (window.__app.state.diary[Object.keys(window.__app.state.diary).sort().pop()] ?? []).length);
  await page.locator('[data-action="log-day"]').first().click();
  await tab('today');
  const entries = await page.locator('.entry').allInnerTexts();
  assert.equal(entries.length, before + 4);
  assert.ok(entries.some((e) => e.includes('Planned meal')));
  const added = entries.slice(-4);
  assert.ok(added.length === 4);
  const total = await page.evaluate(() => window.__app.state.diary[Object.keys(window.__app.state.diary).sort().pop()].filter((e) => e.portionLabel === 'Planned meal').reduce((s, e) => s + e.per100.kcal * e.grams / 100, 0));
  assert.ok(Math.abs(total - dayKcal) <= 2, `${total} vs ${dayKcal}`);
});

await step('data persists across reload', async () => {
  const before = await kcalShown();
  await page.reload();
  await page.waitForSelector('.entry');
  assert.equal(await kcalShown(), before);
});

await step('export backup downloads valid JSON', async () => {
  await tab('profile');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
  const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.equal(json.profile.sex, 'male');
  assert.ok(json.weights.length >= 5);
});

await step('stone and pounds display', async () => {
  await page.click('[data-action="toggle-weight"]');
  await tab('progress');
  assert.match(await page.locator('.kpis').innerText(), /st/);
});

await step('unsafe profile is blocked from weight loss', async () => {
  await tab('profile');
  await page.click('[data-action="toggle-weight"]');
  await page.selectOption('#sex', 'female');
  await page.fill('input[name="heightCm"]', '170');
  await page.fill('input[name="weight"]', '50');
  await page.getByRole('button', { name: 'Save and calculate' }).click();
  await page.waitForTimeout(100);
  assert.match(await page.locator('main').innerText(), /below the healthy range/);
  await tab('plan');
  assert.match(await page.locator('main').innerText(), /below the healthy range/);
});

await step('no horizontal scroll at phone width', async () => {
  for (const t of ['today', 'plan', 'progress', 'profile']) {
    await tab(t);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 1, `${t} overflows by ${over}px`);
  }
});

await page.screenshot({ path: new URL('../../screenshots/today.png', import.meta.url).pathname, fullPage: false }).catch(() => {});
await step('no JavaScript errors', async () => { assert.deepEqual(errors, [], errors.join(' | ')); });

await browser.close();
server.close();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
