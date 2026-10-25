// Weight trend. Daily weigh-ins swing by 1-2 kg with water and food, so the
// app shows an exponentially smoothed trend (10% weight per day, adjusted for
// gaps) and estimates the weekly rate from the trend over the last 4 weeks.

import { daysBetween, addDays } from './units.js';

export const ALPHA = 0.1;

/** Sort by date, keep the last entry for each date, drop invalid values. */
export function cleanEntries(entries) {
  const byDate = new Map();
  for (const e of entries ?? []) {
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !Number.isFinite(e.kg) || e.kg <= 0) continue;
    byDate.set(e.date, { date: e.date, kg: e.kg });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function trendSeries(entries, alpha = ALPHA) {
  const clean = cleanEntries(entries);
  const out = [];
  let prev = null;
  for (const e of clean) {
    if (!prev) {
      prev = { date: e.date, trend: e.kg };
    } else {
      const gap = Math.max(1, daysBetween(prev.date, e.date));
      const a = 1 - (1 - alpha) ** gap;
      prev = { date: e.date, trend: prev.trend + a * (e.kg - prev.trend) };
    }
    out.push({ date: e.date, kg: e.kg, trend: prev.trend });
  }
  return out;
}

/** Least-squares slope of trend vs day, in kg per week, over the last `days` days. */
export function weeklyRate(series, days = 28) {
  if (series.length < 2) return null;
  const last = series[series.length - 1].date;
  const pts = series.filter((p) => daysBetween(p.date, last) <= days);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => daysBetween(pts[0].date, p.date));
  const span = xs[xs.length - 1] - xs[0];
  if (span < 6) return null; // less than a week of data is too noisy
  const ys = pts.map((p) => p.trend);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : (num / den) * 7;
}

/** Date the trend reaches the target at the current rate, or null if not heading there. */
export function projectGoalDate(series, targetKg, rate) {
  if (!series.length || targetKg == null || rate == null) return null;
  const last = series[series.length - 1];
  const diff = last.trend - targetKg;
  if (Math.abs(diff) < 0.05) return last.date;
  if (diff > 0 && rate >= -0.01) return null;
  if (diff < 0 && rate <= 0.01) return null;
  const weeks = Math.abs(diff / rate);
  if (weeks > 520) return null;
  return addDays(last.date, Math.round(weeks * 7));
}

export function progressSummary(entries, targetKg) {
  const series = trendSeries(entries);
  if (!series.length) return { series, latest: null };
  const first = series[0];
  const latest = series[series.length - 1];
  const rate = weeklyRate(series);
  return {
    series,
    latest,
    start: first,
    change: latest.trend - first.kg,
    rate,
    goalDate: projectGoalDate(series, targetKg, rate),
    toGo: targetKg == null ? null : latest.trend - targetKg,
  };
}
