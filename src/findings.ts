/** Where something is in the source file. Line and column are 1-based. */
export interface Loc {
  line: number;
  column: number;
  offset: number;
}

/**
 * error       the input is invalid; nothing can run (exit 2)
 * unsupported valid Make, but this runtime has no evidence-backed support for it (exit 3)
 * warning     worth reading, does not block
 */
export type Severity = 'error' | 'unsupported' | 'warning';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** JSON pointer into the source document, when the finding has a place. */
  pointer?: string;
  loc?: Loc;
}

export const EXIT = {
  ok: 0,
  assertionFailed: 1,
  invalidInput: 2,
  unsupported: 3,
  runtimeFailure: 4,
  fixtureMismatch: 5,
  limitExceeded: 6,
} as const;
