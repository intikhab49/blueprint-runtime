import { UnsupportedError } from './errors.ts';

/**
 * Date helpers. Make formats and does calendar math in the scenario's timezone
 * (corpus D, org timezone Asia/Karachi: parseDate("2026-01-31"; "YYYY-MM-DD") gave
 * 2026-01-30T19:00:00.000Z). Wall-clock fields come from Intl, so zones with
 * daylight saving work too.
 */

export interface LocalFields {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch {
      throw new UnsupportedError(`unknown timezone ${JSON.stringify(tz)}`);
    }
    formatters.set(tz, f);
  }
  return f;
}

export function toLocal(epochMs: number, tz: string): LocalFields {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
    ms: ((epochMs % 1000) + 1000) % 1000,
  };
}

/** Offset of tz from UTC at an instant, in ms (Asia/Karachi → +18000000). */
export function offsetMs(epochMs: number, tz: string): number {
  const f = toLocal(epochMs, tz);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms) - epochMs;
}

export function fromLocal(f: LocalFields, tz: string): number {
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms);
  const first = asUtc - offsetMs(asUtc, tz);
  return asUtc - offsetMs(first, tz);
}

/** Day of week in tz, 0 = Sunday. */
export function weekday(epochMs: number, tz: string): number {
  const f = toLocal(epochMs, tz);
  return new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Calendar months in tz; the day is clamped (Jan 31 + 1 month = Feb 28/29), as observed. */
export function addMonths(epochMs: number, n: number, tz: string): number {
  const f = toLocal(epochMs, tz);
  const total = f.year * 12 + (f.month - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return fromLocal({ ...f, year, month, day: Math.min(f.day, daysIn(year, month)) }, tz);
}

/** Calendar days in tz (keeps wall-clock time across DST changes). */
export function addDays(epochMs: number, n: number, tz: string): number {
  const f = toLocal(epochMs, tz);
  const shifted = new Date(Date.UTC(f.year, f.month - 1, f.day + n));
  return fromLocal({ ...f, year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }, tz);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** Format tokens seen in real Make runs, plus ss. Any other letter is refused rather than guessed. */
const TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss', 'X', 'Z'] as const;

function tokenize(format: string): (string | { token: (typeof TOKENS)[number] })[] {
  const out: (string | { token: (typeof TOKENS)[number] })[] = [];
  let i = 0;
  while (i < format.length) {
    const t = TOKENS.find((x) => format.startsWith(x, i));
    if (t) {
      out.push({ token: t });
      i += t.length;
    } else if (/[A-Za-z[\]]/.test(format[i]!)) {
      throw new UnsupportedError(`date format ${JSON.stringify(format)}: "${format[i]}" is not a format token observed in Make`);
    } else {
      out.push(format[i]!);
      i++;
    }
  }
  return out;
}

export function formatDate(epochMs: number, format: string, tz: string): string {
  const f = toLocal(epochMs, tz);
  return tokenize(format)
    .map((p) => {
      if (typeof p === 'string') return p;
      switch (p.token) {
        case 'YYYY': return pad(f.year, 4);
        case 'MM': return pad(f.month);
        case 'DD': return pad(f.day);
        case 'HH': return pad(f.hour);
        case 'mm': return pad(f.minute);
        case 'ss': return pad(f.second);
        case 'X': return String(Math.floor(epochMs / 1000));
        case 'Z': {
          const off = Math.round(offsetMs(epochMs, tz) / 60000);
          return `${off < 0 ? '-' : '+'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
        }
      }
    })
    .join('');
}

/** Parse text with a format, in tz. Anything that does not match exactly is refused. */
export function parseDate(text: string, format: string, tz: string): number {
  const f: LocalFields = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 };
  let i = 0;
  const fail = (): never => {
    throw new UnsupportedError(`parseDate(${JSON.stringify(text)}; ${JSON.stringify(format)}): Make's result for text that does not match the format has not been observed`);
  };
  for (const p of tokenize(format)) {
    if (typeof p === 'string') {
      if (text[i] !== p) fail();
      i++;
      continue;
    }
    const width = p.token === 'YYYY' ? 4 : 2;
    if (p.token === 'X' || p.token === 'Z') throw new UnsupportedError(`parseDate with "${p.token}" has not been observed in Make`);
    const digits = text.slice(i, i + width);
    if (!new RegExp(`^\\d{${width}}$`).test(digits)) fail();
    i += width;
    const n = Number(digits);
    if (p.token === 'YYYY') f.year = n;
    else if (p.token === 'MM') f.month = n;
    else if (p.token === 'DD') f.day = n;
    else if (p.token === 'HH') f.hour = n;
    else if (p.token === 'mm') f.minute = n;
    else f.second = n;
  }
  if (i !== text.length) fail();
  if (f.month < 1 || f.month > 12 || f.day < 1 || f.day > daysIn(f.year, f.month) || f.hour > 23 || f.minute > 59 || f.second > 59) fail();
  return fromLocal(f, tz);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Text Make accepted as a date in a real run: full ISO 8601 with a zone. */
export function parseIsoInstant(text: string): number | null {
  if (!ISO.test(text)) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
