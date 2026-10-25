// Unit helpers. Everything is stored in kg and cm; these only affect display/input.

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export function kgToStLb(kg) {
  const totalLb = kg / KG_PER_LB;
  let st = Math.floor(totalLb / 14);
  let lb = Math.round((totalLb - st * 14) * 10) / 10;
  if (lb >= 14) { st += 1; lb -= 14; }
  return { st, lb };
}

export const stLbToKg = (st, lb = 0) => (st * 14 + lb) * KG_PER_LB;

export function cmToFtIn(cm) {
  const totalIn = cm / CM_PER_IN;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return { ft, inch };
}

export const ftInToCm = (ft, inch = 0) => (ft * 12 + inch) * CM_PER_IN;

export function formatWeight(kg, unit = 'kg') {
  if (kg == null || !Number.isFinite(kg)) return '–';
  if (unit === 'stlb') {
    const { st, lb } = kgToStLb(kg);
    return `${st} st ${lb.toFixed(1).replace(/\.0$/, '')} lb`;
  }
  return `${kg.toFixed(1)} kg`;
}

/** Local calendar date as YYYY-MM-DD (not UTC, so late-evening entries stay on the right day). */
export function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

/** Whole days from a to b (b - a), safe across clock changes. */
export function daysBetween(a, b) {
  const ua = Date.UTC(...a.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  const ub = Date.UTC(...b.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  return Math.round((ub - ua) / 86400000);
}
