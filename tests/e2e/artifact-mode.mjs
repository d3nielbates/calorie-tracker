// Browser test of the claude.ai Artifact mode: a stand-in for the platform's
// `window.claude.use()` provides db/user/downloads. Checks that data saves to
// account storage and comes back after browser storage is wiped, and that
// features the preview frame blocks are hidden.
// Run: node tests/e2e/artifact-mode.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer } from '../../scripts/serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 8766;

// Runs in the page before the app. The "server" store lives in sessionStorage
// so it survives a reload, while the app's own localStorage is wiped.
const FAKE_PLATFORM = () => {
  const KEY = '__fake_db';
  const load = () => JSON.parse(sessionStorage.getItem(KEY) || '{}');
  const save = (m) => sessionStorage.setItem(KEY, JSON.stringify(m));
  const snap = (id, body) => ({ id, exists: body !== undefined, data: () => body, metadata: { fromCache: false, hasPendingWrites: false } });
  const query = (prefix, filters = [], order = null, lim = 1000) => ({
    where: (f, op, v) => query(prefix, [...filters, [f, v]], order, lim),
    orderBy: (f, dir) => query(prefix, filters, [f, dir], lim),
    limit: (n) => query(prefix, filters, order, n),
    get: async () => {
      const m = load();
      let docs = Object.entries(m).filter(([p]) => p.startsWith(`${prefix}/`)).map(([p, b]) => snap(p.split('/').pop(), b));
      docs = docs.filter((d) => filters.every(([f, v]) => d.data()[f] === v));
      if (order) docs.sort((a, b) => (a.data()[order[0]] < b.data()[order[0]] ? 1 : -1));
      docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length };
    },
  });
  const db = {
    collection: (path) => ({
      ...query(path),
      doc: (id) => ({
        get: async () => snap(id, load()[`${path}/${id}`]),
        set: async (body) => { const m = load(); m[`${path}/${id}`] = JSON.parse(JSON.stringify(body)); save(m); window.__writes = (window.__writes || 0) + 1; },
      }),
    }),
  };
  const user = { id: async () => 'viewer-1' };
  const downloads = { save: async (f) => { window.__saved = f; } };
  // A stand-in for Claude: records the prompt and answers like the coach would.
  const sample = async () => ({ text: '', truncated: false });
  sample.json = async (input) => {
    window.__prompt = input;
    if (input.includes('Person: FAIL')) throw { code: 'rate_limited', message: 'slow down' };
    return { dislikeFoods: ['mushrooms', 'not-a-food'], allowFoods: [], dislikeMeals: [], allowMeals: [], prep: { breakfast: true, lunch: null }, unmatched: ['olives'], reply: 'Got it: no mushrooms, and the same breakfast every day.' };
  };
  window.claude = { use: (name) => new Promise((r) => setTimeout(() => r({ db, user, downloads, sample }[name] ?? null), 30)) };
};

const results = [];
const server = await startServer(PORT);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(FAKE_PLATFORM);
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 3).join(' ')]); }
}
const base = `http://127.0.0.1:${PORT}/`;

await step('connects to account storage', async () => {
  await page.goto(`${base}#profile`);
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved to your account');
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.selectOption('#sex', 'female');
  await page.fill('#age', '35');
  await page.fill('input[name="heightCm"]', '165');
  await page.fill('input[name="weight"]', '82');
  await page.getByRole('button', { name: 'Save and calculate' }).click();
  await page.waitForSelector('text=Your daily targets');
  assert.match(await page.locator('main').innerText(), /saved privately to your Claude account/);
});

await step('live product search and barcode are hidden in the preview', async () => {
  await page.click('a[data-tab="today"]');
  await page.waitForSelector('.datebar');
  await page.click('button[data-slot="breakfast"]');
  assert.equal(await page.locator('[data-mode="off"]').count(), 0);
  assert.equal(await page.locator('[data-mode="barcode"]').count(), 0);
  assert.match(await page.locator('#sheet-body').innerText(), /add a packaged food from its label/);
  await page.fill('input[name="q"]', 'banana');
  await page.press('input[name="q"]', 'Enter');
  await page.locator('#search-results li').first().click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForSelector('.entry');
});

await step('data comes back from the account after browser storage is wiped', async () => {
  await page.waitForFunction(() => (window.__writes || 0) >= 3, null, { timeout: 5000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved to your account');
  await page.click('a[data-tab="today"]').catch(() => {});
  await page.waitForSelector('.entry');
  assert.match(await page.locator('.entry').first().innerText(), /Banana/);
  await page.click('a[data-tab="progress"]');
  await page.waitForSelector('svg.chart, table');
  assert.match(await page.locator('main').innerText(), /82/);
});

await step('delete asks in the page, then deletes', async () => {
  await page.click('[data-action="del-weight"]');
  await page.waitForSelector('[data-action="confirm-yes"]');
  await page.click('[data-action="close-sheet"]');
  assert.equal(await page.locator('[data-action="del-weight"]').count(), 1, 'cancel keeps it');
  await page.click('[data-action="del-weight"]');
  await page.click('[data-action="confirm-yes"]');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-action="del-weight"]').count(), 0);
});

await step('backup export goes through the download capability', async () => {
  await page.click('a[data-tab="profile"]');
  await page.click('[data-action="export"]');
  await page.waitForFunction(() => !!window.__saved);
  const f = await page.evaluate(() => window.__saved);
  assert.match(f.filename, /^calorie-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(JSON.parse(f.data).profile.sex, 'female');
});

await step('AI coach turns a message into plan changes', async () => {
  await page.click('a[data-tab="plan"]');
  await page.waitForSelector('#plan-form');
  await page.getByRole('button', { name: 'Make my plan' }).click();
  await page.waitForSelector('.day-card', { timeout: 10000 });
  assert.match(await page.locator('#coach').innerText(), /Uses Claude/);
  await page.fill('#coach-text', 'She hates olives and mushrooms. Same breakfast every day please');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForSelector('.bubble.coach:not(.muted)');
  const txt = await page.locator('#coach').innerText();
  assert.match(txt, /Got it: no mushrooms/);
  assert.match(txt, /Not in the meal library.*olives/);
  assert.match(await page.evaluate(() => window.__prompt), /Person: She hates olives and mushrooms/);
  const st = await page.evaluate(() => window.__app.state);
  assert.deepEqual(st.planOptions.dislikedFoods, ['mushrooms']);
  assert.equal(st.planOptions.prep.breakfast, 'auto');
  assert.ok(st.plan.prepMeals.breakfast);
  assert.ok(!st.plan.days.some((d) => d.meals.some((m) => m.items.some((i) => i.foodId === 'uk:mushrooms'))));
  assert.equal(new Set(st.plan.days.map((d) => d.meals[0].mealId)).size, 1);
});

await step('if Claude is unavailable the coach still understands simple sentences', async () => {
  await page.fill('#coach-text', 'FAIL');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.bubble.coach').length >= 2);
  assert.match(await page.locator('.bubble.coach').last().innerText(), /couldn't match/);
});

await step('no JavaScript errors', async () => { assert.deepEqual(errors, [], errors.join(' | ')); });
await browser.close();
server.close();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} artifact-mode checks passed`);
process.exit(failed ? 1 : 0);
