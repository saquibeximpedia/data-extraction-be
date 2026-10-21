import { Period } from '../types';

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(value: string): boolean {
  return PERIOD_RE.test(value);
}

/** Accepts "YYYY-MM" or "YYYY-MM-DD" and returns "YYYY-MM" */
export function toPeriod(value: string): Period {
  const period = value.trim().substring(0, 7);
  if (!isPeriod(period)) {
    throw new Error(`Invalid month "${value}" (expected YYYY-MM)`);
  }
  return period;
}

export function periodOfDate(date: Date): Period {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function splitPeriod(period: Period): { year: number; month: number } {
  const [year, month] = period.split('-').map(Number);
  return { year, month };
}

export function addMonths(period: Period, delta: number): Period {
  const { year, month } = splitPeriod(period);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Inclusive, ascending list of months between two periods */
export function periodRange(start: Period, end: Period): Period[] {
  if (start > end) {
    throw new Error(`Start month ${start} is after end month ${end}`);
  }
  const periods: Period[] = [];
  for (let p = start; p <= end; p = addMonths(p, 1)) {
    periods.push(p);
  }
  return periods;
}

export function periodBounds(period: Period): { startDate: string; endDate: string } {
  const { year, month } = splitPeriod(period);
  const lastDay = new Date(year, month, 0).getDate();
  return { startDate: `${period}-01`, endDate: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Most recent month a source should have published by `today`.
 * A country with a 1-month lag that publishes on the 15th has September data
 * from October 15th onwards; before that the latest is August.
 */
export function latestPublishedPeriod(lagMonths: number, updateDayOfMonth: number, today = new Date()): Period {
  const released = today.getDate() >= updateDayOfMonth;
  return addMonths(periodOfDate(today), -(lagMonths + (released ? 0 : 1)));
}

/** The months auto sync keeps checking for a country, oldest first */
export function autoSyncPeriods(
  lagMonths: number,
  updateDayOfMonth: number,
  lookbackMonths: number,
  today = new Date()
): Period[] {
  const latest = latestPublishedPeriod(lagMonths, updateDayOfMonth, today);
  return periodRange(addMonths(latest, -(lookbackMonths - 1)), latest);
}
