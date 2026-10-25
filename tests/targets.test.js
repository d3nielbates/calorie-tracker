import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bmrMifflin, computeTargets, validateProfile, microTargets, assessIntake, bmi, SAFETY, ACTIVITY_LEVELS, LOSS_RATES, KCAL_PER_KG } from '../src/targets.js';

const base = { sex: 'male', age: 40, heightCm: 180, weightKg: 100, activity: 'light', goal: 'lose', weeklyLossKg: 0.5, targetWeightKg: 85 };

test('Mifflin-St Jeor matches the published equation', () => {
  assert.equal(bmrMifflin({ sex: 'male', weightKg: 100, heightCm: 180, age: 40 }), 1930);
  assert.equal(bmrMifflin({ sex: 'female', weightKg: 70, heightCm: 165, age: 30 }), 700 + 1031.25 - 150 - 161);
});

test('typical male weight-loss targets', () => {
  const t = computeTargets(base);
  assert.equal(t.ok, true);
  assert.equal(t.bmr, 1930);
  assert.equal(t.tdee, Math.round(1930 * 1.375));
  // 0.5 kg/week = 550 kcal/day deficit, rounded to 10 kcal
  assert.equal(t.kcal, Math.round((1930 * 1.375 - 550) / 10) * 10);
  assert.ok(Math.abs(t.weeklyLossKg - 0.5) < 0.02);
  assert.equal(t.bmi, 30.9);
  assert.equal(t.bmiCategory, 'Obese');
  assert.equal(t.weeksToGoal, Math.ceil(15 / t.weeklyLossKg));
  assert.deepEqual(t.warnings, []);
});

test('protein uses reference weight capped at BMI 25 and stays within 35% of energy', () => {
  const t = computeTargets(base);
  const ref = 25 * 1.8 * 1.8; // 81 kg
  assert.equal(t.macros.protein.target, Math.round(1.4 * ref));
  assert.ok((t.macros.protein.target * 4) / t.kcal <= 0.35 + 1e-9);
  const lean = computeTargets({ ...base, weightKg: 70, targetWeightKg: null });
  assert.equal(lean.macros.protein.target, Math.round(1.4 * 70));
});

test('macros add up to the calorie target', () => {
  const t = computeTargets(base);
  const m = t.macros;
  const kcal = m.protein.target * 4 + m.carbs.target * 4 + m.fat.target * 9;
  assert.ok(Math.abs(kcal - t.kcal) <= 10, `${kcal} vs ${t.kcal}`);
  assert.equal(m.fibre.target, 30);
  assert.equal(m.salt.max, 6);
  assert.equal(m.satfat.max, Math.round((0.1 * t.kcal) / 9));
});

test('calorie floor is applied for small, sedentary people', () => {
  const t = computeTargets({ sex: 'female', age: 60, heightCm: 155, weightKg: 62, activity: 'sedentary', goal: 'lose', weeklyLossKg: 1 });
  assert.equal(t.kcal, SAFETY.minKcal.female);
  assert.ok(t.warnings.some((w) => /safe minimum/.test(w)));
  assert.ok(t.weeklyLossKg < 0.5);
  const m = computeTargets({ sex: 'male', age: 70, heightCm: 160, weightKg: 70, activity: 'sedentary', goal: 'lose', weeklyLossKg: 1 });
  assert.equal(m.kcal, SAFETY.minKcal.male);
});

test('weekly loss is capped at 1% of body weight', () => {
  const t = computeTargets({ ...base, weightKg: 75, heightCm: 170, weeklyLossKg: 1, activity: 'active', targetWeightKg: null });
  assert.ok(t.weeklyLossKg <= 0.75 + 0.02, `got ${t.weeklyLossKg}`);
  assert.ok(t.warnings.some((w) => /1% of your body weight/.test(w)));
});

test('weight loss is blocked when underweight, under 18 or pregnant', () => {
  const under = computeTargets({ ...base, weightKg: 55, heightCm: 180 });
  assert.match(under.blocked, /below the healthy range/);
  assert.equal(under.kcal, Math.round(under.tdee / 10) * 10, 'maintenance only');
  const teen = computeTargets({ ...base, age: 16 });
  assert.match(teen.blocked, /adults/);
  const preg = computeTargets({ ...base, sex: 'female', pregnant: true });
  assert.match(preg.blocked, /pregnant/);
  assert.equal(preg.deficit, 0);
});

test('target weight below BMI 18.5 is raised', () => {
  const t = computeTargets({ ...base, targetWeightKg: 50 });
  assert.equal(t.targetWeightKg, Math.round(18.5 * 1.8 * 1.8 * 10) / 10);
  assert.ok(t.warnings.some((w) => /BMI under 18.5/.test(w)));
});

test('maintain goal has no deficit', () => {
  const t = computeTargets({ ...base, goal: 'maintain' });
  assert.equal(t.deficit <= 5, true);
  assert.equal(t.weeklyLossKg <= 0.01, true);
  assert.equal(t.weeksToGoal, null);
});

test('medical condition adds a GP warning', () => {
  const t = computeTargets({ ...base, medicalConditions: true });
  assert.ok(t.warnings.some((w) => /GP/.test(w)));
});

test('validation catches bad input', () => {
  assert.ok(validateProfile({}).length >= 5);
  assert.deepEqual(validateProfile(base), []);
  assert.ok(validateProfile({ ...base, heightCm: 1.8 }).some((e) => /height/i.test(e)));
  assert.ok(validateProfile({ ...base, weightKg: NaN }).some((e) => /weight/i.test(e)));
  assert.ok(validateProfile({ ...base, weeklyLossKg: 2 }).some((e) => /rate/i.test(e)));
  assert.equal(computeTargets({ ...base, sex: 'x' }).ok, false);
});

test('UK RNIs by sex and age', () => {
  const m = microTargets({ sex: 'male', age: 30, weightKg: 80 });
  const f = microTargets({ sex: 'female', age: 30, weightKg: 60 });
  const f55 = microTargets({ sex: 'female', age: 55, weightKg: 60 });
  assert.equal(m.iron, 8.7);
  assert.equal(f.iron, 14.8);
  assert.equal(f55.iron, 8.7);
  assert.equal(m.vitD, 10);
  assert.equal(f.calcium, 700);
  assert.equal(m.vitK, 80);
  assert.equal(f.zinc, 7);
  assert.equal(m.selenium, 75);
});

test('every profile in a wide grid gives safe, finite targets', () => {
  let n = 0;
  for (const sex of ['male', 'female']) for (const age of [18, 25, 45, 65, 85]) for (const heightCm of [145, 160, 175, 195])
    for (const weightKg of [45, 60, 80, 110, 160, 220]) for (const activity of ACTIVITY_LEVELS.map((a) => a.id)) for (const weeklyLossKg of LOSS_RATES) {
      const t = computeTargets({ sex, age, heightCm, weightKg, activity, goal: 'lose', weeklyLossKg });
      n++;
      assert.equal(t.ok, true);
      for (const v of [t.kcal, t.bmr, t.tdee, t.deficit, t.weeklyLossKg, t.macros.protein.target, t.macros.carbs.target, t.macros.fat.target]) {
        assert.ok(Number.isFinite(v), `non-finite value for ${JSON.stringify({ sex, age, heightCm, weightKg })}`);
      }
      assert.ok(t.kcal >= SAFETY.minKcal[sex] || (t.blocked && t.kcal >= Math.round(t.tdee / 10) * 10 - 5), `below floor: ${t.kcal}`);
      assert.ok(t.weeklyLossKg <= Math.min(1, weightKg * 0.01) + 0.02, `loss too fast: ${t.weeklyLossKg}`);
      assert.ok(t.macros.carbs.target >= 0);
      if (bmi(weightKg, heightCm) < 18.5) assert.ok(t.blocked);
      assert.ok(Math.abs(t.deficit * 7 / KCAL_PER_KG - t.weeklyLossKg) < 0.01);
    }
  assert.ok(n > 2000);
});

test('assessIntake classifies low, ok and high', () => {
  const t = computeTargets(base);
  const a = assessIntake({ kcal: t.kcal * 1.2, protein: 10, fibre: 35, salt: 7, satfat: 1, sugars: 1, fat: 50, carbs: 100, vitC: 50, iron: 1 }, t);
  assert.equal(a.kcal.status, 'high');
  assert.equal(a.protein.status, 'low');
  assert.equal(a.fibre.status, 'ok');
  assert.equal(a.salt.status, 'high');
  assert.equal(a.vitC.status, 'ok');
  assert.equal(a.iron.status, 'low');
  assert.equal(a.vitD.value, 0);
});
