/**
 * The function registry.
 *
 * Function implementations live in themed modules under `./functions`; each one
 * calls `registerFunction` at import time and `registerBuiltinFunctions` pulls
 * them all in. `formula.ts` stays the parser/evaluator and does not know how
 * any individual function works.
 */
import type { CellMatrix, Scalar } from "./scalars";

/** Arguments arrive already grouped per parameter, each a 2D matrix. */
export type FunctionArgs = Scalar[][][];
/** A function returns a scalar, or a matrix for the dynamic-array family. */
export type FunctionResult = Scalar | CellMatrix;
export type FunctionImplementation = (args: FunctionArgs) => FunctionResult;

export interface FunctionSpec {
  fn: FunctionImplementation;
  min: number;
  max: number;
  /** Functions that inspect errors themselves (IFERROR, ISERROR, ...). */
  acceptsErrors?: boolean;
  /**
   * Counting functions, which skip error cells inside a range instead of
   * failing on them - the same exception Excel makes for COUNT/COUNTIF.
   */
  ignoresRangeErrors?: boolean;
  /** Extra help shown by the function picker, keyed by language-neutral text. */
  signature?: string;
  category?: string;
}

const FUNCTIONS = new Map<string, FunctionSpec>();

export interface FunctionMeta {
  signature?: string;
  category?: string;
  /** Opt out of the "an error inside a range poisons the result" rule. */
  ignoresRangeErrors?: boolean;
}

export function registerFunction(
  name: string,
  fn: FunctionImplementation,
  min = 0,
  max = 32,
  acceptsErrors = false,
  meta: FunctionMeta = {},
): void {
  FUNCTIONS.set(name.toUpperCase(), { fn, min, max, acceptsErrors, ...meta });
}

export function lookupFunction(name: string): FunctionSpec | undefined {
  return FUNCTIONS.get(name.toUpperCase());
}

export function functionNames(): string[] {
  return [...FUNCTIONS.keys()].sort();
}

export function functionCount(): number {
  return FUNCTIONS.size;
}

export function functionCatalogue(): Array<{ name: string; signature: string; category: string }> {
  return [...FUNCTIONS.entries()]
    .map(([name, spec]) => ({ name, signature: spec.signature ?? `${name}()`, category: spec.category ?? "Other" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
