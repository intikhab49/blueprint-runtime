/**
 * Exact decimal arithmetic for Make's +, - and * operators.
 *
 * Make printed 0.1 + 0.7 = 0.8, 100.1 - 100 = 0.1 and 1.005 * 1000 = 1005, where
 * JavaScript gives 0.7999999999999999, 0.09999999999999432 and 1004.9999999999999
 * (corpus D2). Every observed result equals exact decimal arithmetic on the numbers
 * as written, rounded back to a double. Functions like sum() do not do this:
 * sum([0.1, 0.2]) was 0.30000000000000004.
 */

interface Dec {
  /** value = int × 10^-scale */
  int: bigint;
  scale: number;
}

function toDec(x: number): Dec {
  // String(x) is the shortest decimal that round-trips: "0.1", "1e+21", "1.5e-7".
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  if (!m) throw new Error(`not a finite number: ${x}`);
  const [, sign, whole, frac = '', exp = '0'] = m;
  let int = BigInt(`${sign}${whole}${frac}`);
  let scale = frac.length - Number(exp);
  if (scale < 0) {
    int *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { int, scale };
}

function toNumber(d: Dec): number {
  return Number(`${d.int}e${-d.scale}`);
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.int * 10n ** BigInt(scale - a.scale), b.int * 10n ** BigInt(scale - b.scale), scale];
}

const finite = (...xs: number[]) => xs.every(Number.isFinite);

export function decAdd(a: number, b: number): number {
  if (!finite(a, b)) return a + b;
  const [x, y, scale] = align(toDec(a), toDec(b));
  return toNumber({ int: x + y, scale });
}

export function decSub(a: number, b: number): number {
  if (!finite(a, b)) return a - b;
  const [x, y, scale] = align(toDec(a), toDec(b));
  return toNumber({ int: x - y, scale });
}

export function decMul(a: number, b: number): number {
  if (!finite(a, b)) return a * b;
  const x = toDec(a);
  const y = toDec(b);
  return toNumber({ int: x.int * y.int, scale: x.scale + y.scale });
}

/** Decimal quotient to 40 significant digits, rounded to a double. Used only to detect disagreement with JavaScript. */
export function decDiv(a: number, b: number): number {
  if (!finite(a, b) || b === 0) return a / b;
  const [x, y] = align(toDec(a), toDec(b));
  const digits = 40n;
  const q = (x * 10n ** digits) / y;
  return toNumber({ int: q, scale: Number(digits) });
}

export function decMod(a: number, b: number): number {
  if (!finite(a, b) || b === 0) return a % b;
  const [x, y, scale] = align(toDec(a), toDec(b));
  return toNumber({ int: x % y, scale });
}
