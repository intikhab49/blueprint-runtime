/**
 * The expression engine can fail in three different ways, and they must never be
 * confused:
 *
 *   ExprSyntaxError  the expression text cannot be parsed.
 *   DataError        Make itself fails here. The message copies Make's wording,
 *                    which was observed in a real run (corpus D-05 and D-05b).
 *   UnsupportedError Make's behavior for this case has not been observed, so the
 *                    runtime refuses instead of guessing (spec 2.1, 19.1).
 */

export class ExprSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'ExprSyntaxError';
    this.offset = offset;
  }
}

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}
