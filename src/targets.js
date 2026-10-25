// Daily energy and nutrient targets.
//
// Energy: Mifflin-St Jeor resting energy (Mifflin et al. 1990, Am J Clin Nutr
// 51:241) times a physical activity level. Weight-loss deficit uses the usual
// ~7,700 kcal per kg of body fat estimate.
// Nutrients: UK Reference Nutrient Intakes (Department of Health 1991, with
// SACN updates: vitamin D 2016, carbohydrate/fibre/free sugars 2015,
// saturated fat 2019) and UK labelling Reference Intakes (salt, sugars).
// This is general guidance, not medical advice.

export const KCAL_PER_KG = 7700;

export const ACTIVITY_LEVELS = [
  { id: 'sedentary', pal: 1.2, label: 'Sedentary', hint: 'Desk job, little or no exercise' },
  { id: 'light', pal: 1.375, label: 'Lightly active', hint: 'Light exercise 1-3 days a week' },
  { id: 'moderate', pal: 1.55, label: 'Moderately active', hint: 'Exercise 3-5 days a week' },
  { id: 'active', pal: 1.725, label: 'Very active', hint: 'Hard exercise 6-7 days a week' },
  { id: 'athlete', pal: 1.9, label: 'Extra active', hint: 'Physical job plus training' },
];

export const LOSS_RATES = [0.25, 0.5, 0.75, 1.0]; // kg per week

export const SAFETY = {
  minAge: 18,
  // Lowest daily intake the app will plan without medical supervision.
  minKcal: { male: 1500, female: 1200 },
  maxWeeklyLossKg: 1.0, // NHS: aim for 0.5-1 kg a week
  maxWeeklyLossPct: 0.01, // and no more than ~1% of body weight a week
  minBmi: 18.5,
};

const ACTIVITY_BY_ID = Object.fromEntries(ACTIVITY_LEVELS.map((a) => [a.id, a]));

export function bmi(weightKg, heightCm) {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

export function weightForBmi(targetBmi, heightCm) {
  const m = heightCm / 100;
  return targetBmi * m * m;
}

export function bmiCategory(value) {
  if (value < 18.5) return 'Underweight';
  if (value < 25) return 'Healthy weight';
  if (value < 30) return 'Overweight';
  if (value < 40) return 'Obese';
  return 'Severely obese';
}

/** Mifflin-St Jeor resting energy expenditure in kcal/day. */
export function bmrMifflin({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}

export function validateProfile(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['Profile is missing'];
  if (p.sex !== 'male' && p.sex !== 'female') errors.push('Choose the sex used for the energy formula');
  if (!Number.isFinite(p.age) || p.age < 1 || p.age > 120) errors.push('Enter an age between 1 and 120');
  if (!Number.isFinite(p.heightCm) || p.heightCm < 120 || p.heightCm > 230) errors.push('Enter a height between 120 and 230 cm');
  if (!Number.isFinite(p.weightKg) || p.weightKg < 30 || p.weightKg > 350) errors.push('Enter a weight between 30 and 350 kg');
  if (!ACTIVITY_BY_ID[p.activity]) errors.push('Choose an activity level');
  if (p.goal !== 'lose' && p.goal !== 'maintain') errors.push('Choose a goal');
  if (p.goal === 'lose' && !LOSS_RATES.includes(p.weeklyLossKg)) errors.push('Choose a weekly weight-loss rate');
  if (p.targetWeightKg != null && (!Number.isFinite(p.targetWeightKg) || p.targetWeightKg < 30 || p.targetWeightKg > 350)) {
    errors.push('Enter a target weight between 30 and 350 kg');
  }
  return errors;
}

/**
 * UK Reference Nutrient Intakes for adults (19+). Values per day.
 * Vitamin K has no RNI; 1 µg/kg body weight is the UK "safe intake".
 */
export function microTargets({ sex, age, weightKg }) {
  const male = sex === 'male';
  const over50 = age >= 50;
  return {
    vitA: male ? 700 : 600,
    thiamin: male ? 1.0 : 0.8,
    riboflavin: male ? 1.3 : 1.1,
    niacin: male ? 17 : 13,
    b6: male ? 1.4 : 1.2,
    folate: 200,
    b12: 1.5,
    vitC: 40,
    vitD: 10,
    vitE: male ? 4 : 3,
    vitK: Math.round(weightKg),
    calcium: 700,
    iron: male || over50 ? 8.7 : 14.8,
    magnesium: male ? 300 : 270,
    phosphorus: 550,
    potassium: 3500,
    zinc: male ? 9.5 : 7.0,
    copper: 1.2,
    selenium: male ? 75 : 60,
  };
}

const roundTo = (v, step) => Math.round(v / step) * step;

/**
 * Compute daily targets. Never returns a calorie target below the safety
 * floor, and caps the weekly loss rate. `blocked` means the app should not
 * plan weight loss for this profile at all (it still returns maintenance).
 */
export function computeTargets(profile) {
  const errors = validateProfile(profile);
  if (errors.length) return { ok: false, errors };

  const { sex, age, heightCm, weightKg, activity, goal } = profile;
  const warnings = [];
  const notes = [];
  let blocked = null;

  const bodyBmi = bmi(weightKg, heightCm);
  const bmr = bmrMifflin(profile);
  const pal = ACTIVITY_BY_ID[activity].pal;
  const tdee = bmr * pal;
  const floor = SAFETY.minKcal[sex];

  if (age < SAFETY.minAge) blocked = 'This app is for adults. Under-18s should get weight advice from a GP or school nurse.';
  else if (profile.pregnant) blocked = 'Weight loss is not advised while pregnant or breastfeeding. Speak to your midwife or GP.';
  else if (goal === 'lose' && bodyBmi < SAFETY.minBmi) blocked = `Your BMI is ${bodyBmi.toFixed(1)}, which is below the healthy range, so the app will not set a weight-loss target. Please speak to your GP.`;

  let requested = goal === 'lose' && !blocked ? profile.weeklyLossKg : 0;
  const capKg = Math.min(SAFETY.maxWeeklyLossKg, SAFETY.maxWeeklyLossPct * weightKg);
  if (requested > capKg + 1e-9) {
    warnings.push(`A loss of ${requested} kg a week is more than 1% of your body weight, so it has been limited to ${capKg.toFixed(2)} kg a week.`);
    requested = capKg;
  }

  const wantedDeficit = (requested * KCAL_PER_KG) / 7;
  let kcal = tdee - wantedDeficit;
  if (requested > 0 && kcal < floor) {
    kcal = floor;
    warnings.push(`Your calorie target has been raised to the safe minimum of ${floor} kcal a day, so expected loss is slower than you asked for. Being more active is the safest way to speed it up.`);
  }
  if (tdee < floor && requested > 0) {
    warnings.push('Your estimated energy needs are close to the safe minimum. Speak to your GP or a dietitian before trying to lose weight.');
  }
  if (goal === 'lose' && !blocked && bodyBmi < 20) {
    warnings.push(`Your BMI is ${bodyBmi.toFixed(1)}, near the bottom of the healthy range. Losing more weight is unlikely to benefit your health.`);
  }
  if (profile.medicalConditions) {
    warnings.push('You said you have a medical condition or take medication. Check this plan with your GP or a dietitian before starting, especially if you have diabetes, kidney disease or an eating disorder.');
  }

  kcal = roundTo(kcal, 10);
  // Only a planned loss counts as a deficit; rounding maintenance to 10 kcal does not.
  const deficit = requested > 0 ? Math.max(0, tdee - kcal) : 0;
  const weeklyLossKg = (deficit * 7) / KCAL_PER_KG;

  // Target weight sanity check.
  let targetWeightKg = profile.targetWeightKg ?? null;
  const minHealthy = weightForBmi(SAFETY.minBmi, heightCm);
  if (targetWeightKg != null && targetWeightKg < minHealthy) {
    warnings.push(`A target of ${targetWeightKg} kg would give a BMI under 18.5. The app has set your target to ${minHealthy.toFixed(1)} kg, the bottom of the healthy range.`);
    targetWeightKg = Math.round(minHealthy * 10) / 10;
  }
  let weeksToGoal = null;
  if (targetWeightKg != null && weeklyLossKg >= 0.05 && targetWeightKg < weightKg) {
    weeksToGoal = Math.ceil((weightKg - targetWeightKg) / weeklyLossKg);
    notes.push('Time to goal is an estimate. Loss is usually faster in the first weeks (water) and slows as you get lighter, so targets update each time you log your weight.');
  }

  // Protein: 1.4 g/kg of a reference weight (current weight capped at BMI 25)
  // to help preserve muscle while losing fat; never below the UK RNI of
  // 0.75 g/kg, and no more than 35% of energy.
  const refWeight = Math.min(weightKg, weightForBmi(25, heightCm));
  const proteinPerKg = goal === 'lose' ? 1.4 : 1.0;
  let protein = proteinPerKg * refWeight;
  protein = Math.max(protein, 0.75 * weightKg);
  protein = Math.min(protein, (0.35 * kcal) / 4);
  protein = Math.round(protein);

  const fat = Math.round((0.3 * kcal) / 9); // SACN: no more than 35% of energy
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));

  const macros = {
    protein: { target: protein, kind: 'min' },
    fat: { target: fat, max: Math.round((0.35 * kcal) / 9), kind: 'target' },
    satfat: { max: Math.round((0.1 * kcal) / 9), kind: 'max' }, // SACN 2019: <=10% energy
    carbs: { target: carbs, kind: 'target' },
    sugars: { max: Math.round((0.18 * kcal) / 4), kind: 'max' }, // UK RI: 90 g per 2000 kcal
    fibre: { target: 30, kind: 'min' }, // SACN 2015
    salt: { max: 6, kind: 'max' },
  };

  return {
    ok: true,
    blocked,
    bmi: Math.round(bodyBmi * 10) / 10,
    bmiCategory: bmiCategory(bodyBmi),
    healthyWeightRange: [Math.round(minHealthy * 10) / 10, Math.round(weightForBmi(24.9, heightCm) * 10) / 10],
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    kcal,
    deficit: Math.round(deficit),
    weeklyLossKg: Math.round(weeklyLossKg * 100) / 100,
    targetWeightKg,
    weeksToGoal,
    macros,
    micros: microTargets(profile),
    warnings,
    notes,
  };
}

/**
 * Score a day's intake against targets: returns, per nutrient, the % of target
 * and a status of 'low' | 'ok' | 'high'.
 */
export function assessIntake(totals, targets) {
  const out = {};
  const kcal = totals.kcal ?? 0;
  out.kcal = { value: kcal, target: targets.kcal, pct: kcal / targets.kcal, status: kcal > targets.kcal * 1.05 ? 'high' : kcal < targets.kcal * 0.9 ? 'low' : 'ok' };
  for (const [key, t] of Object.entries(targets.macros)) {
    const v = totals[key] ?? 0;
    if (t.kind === 'max') out[key] = { value: v, max: t.max, pct: v / t.max, status: v > t.max ? 'high' : 'ok' };
    else if (t.kind === 'min') out[key] = { value: v, target: t.target, pct: v / t.target, status: v < t.target * 0.9 ? 'low' : 'ok' };
    else out[key] = { value: v, target: t.target, pct: v / t.target, status: t.max && v > t.max ? 'high' : 'ok' };
  }
  for (const [key, target] of Object.entries(targets.micros)) {
    const v = totals[key] ?? 0;
    out[key] = { value: v, target, pct: v / target, status: v < target ? 'low' : 'ok' };
  }
  return out;
}
