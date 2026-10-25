process.env.TZ = 'Europe/London';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kgToStLb, stLbToKg, cmToFtIn, ftInToCm, formatWeight, localDateStr, addDays, daysBetween } from '../src/units.js';
import { cleanEntries, trendSeries, weeklyRate, projectGoalDate, progressSummary } from '../src/trend.js';

test('stone and pounds round-trip', () => {
  assert.deepEqual(kgToStLb(stLbToKg(15, 10)), { st: 15, lb: 10 });
  assert.deepEqual(kgToStLb(63.5029318), { st: 10, lb: 0 });
  const r = kgToStLb(stLbToKg(9, 13.97)); // rounds up to the next stone, never "13.97 -> 14 lb"
  assert.ok(r.lb < 14);
  assert.equal(formatWeight(100, 'kg'), '100.0 kg');
  assert.equal(formatWeight(stLbToKg(15, 10), 'stlb'), '15 st 10 lb');
  assert.equal(formatWeight(null), '–');
});

test('feet and inches round-trip', () => {
  assert.deepEqual(cmToFtIn(ftInToCm(5, 11)), { ft: 5, inch: 11 });
  assert.deepEqual(cmToFtIn(182.88), { ft: 6, inch: 0 });
  assert.deepEqual(cmToFtIn(ftInToCm(5, 11.8)), { ft: 6, inch: 0 });
});

test('local dates and clock changes', () => {
  assert.equal(localDateStr(new Date(2026, 9, 25, 23, 30)), '2026-10-25'); // late evening stays on the same day
  assert.equal(addDays('2026-03-28', 1), '2026-03-29'); // UK clocks go forward
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addDays('2026-10-25', -1), '2026-10-24'); // clocks go back
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-30', '2026-10-01'), -29);
});

const series = (days, start, perDay) => Array.from({ length: days }, (_, i) => ({ date: addDays('2026-01-01', i), kg: start + perDay * i }));

test('cleanEntries sorts, dedupes and drops junk', () => {
  const c = cleanEntries([{ date: '2026-01-02', kg: 80 }, { date: '2026-01-01', kg: 81 }, { date: '2026-01-02', kg: 79.5 }, { date: 'bad', kg: 1 }, { date: '2026-01-03', kg: NaN }, null]);
  assert.deepEqual(c, [{ date: '2026-01-01', kg: 81 }, { date: '2026-01-02', kg: 79.5 }]);
});

test('trend smooths noise and handles gaps', () => {
  const s = trendSeries([{ date: '2026-01-01', kg: 100 }, { date: '2026-01-02', kg: 102 }, { date: '2026-01-12', kg: 100 }]);
  assert.equal(s[0].trend, 100);
  assert.ok(Math.abs(s[1].trend - 100.2) < 1e-9);
  const a = 1 - 0.9 ** 10;
  assert.ok(Math.abs(s[2].trend - (100.2 + a * (100 - 100.2))) < 1e-9);
});

test('weekly rate recovers a steady loss', () => {
  const s = trendSeries(series(90, 100, -0.5 / 7));
  assert.ok(Math.abs(weeklyRate(s) + 0.5) < 0.03, `rate ${weeklyRate(s)}`);
  assert.equal(weeklyRate(trendSeries(series(4, 100, -0.1))), null, 'under a week of data');
  assert.equal(weeklyRate([]), null);
});

test('goal date projection', () => {
  const s = trendSeries(series(90, 100, -0.5 / 7));
  const rate = weeklyRate(s);
  const last = s[s.length - 1];
  const d = projectGoalDate(s, last.trend - 5, rate);
  assert.ok(Math.abs(daysBetween(last.date, d) - 70) <= 4, `${d}`);
  assert.equal(projectGoalDate(s, last.trend + 5, rate), null, 'moving away from target');
  assert.equal(projectGoalDate(s, 80, null), null);
  const ps = progressSummary(series(30, 90, -0.05), 85);
  assert.ok(ps.change < 0);
  assert.ok(ps.toGo > 0);
  assert.deepEqual(progressSummary([], 80), { series: [], latest: null });
});
