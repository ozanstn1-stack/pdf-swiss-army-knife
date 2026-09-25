/**
 * Spreadsheet formula engine.
 *
 * Values are Excel-like: numbers, strings, booleans and explicit errors.
 * Unsupported functions and invalid operations produce visible errors
 * (#NAME?, #VALUE!, #REF!, #DIV/0!, #N/A) instead of silently wrong numbers.
 * The registry is extensible: `registerFunction(name, fn, minArgs, maxArgs)`.
 */

export type Scalar = number | string | boolean | FormulaError;
export type CellMatrix = Scalar[][];

export class FormulaError {
  constructor(public readonly code: string, public readonly detail = "") {}

  toString(): string {
    return this.detail ? `${this.code} (${this.detail})` : this.code;
  }
}

export const ERR = {
  name: () => new FormulaError("#NAME?"),
  value: () => new FormulaError("#VALUE!"),
  ref: () => new FormulaError("#REF!"),
  div: () => new FormulaError("#DIV/0!"),
  na: () => new FormulaError("#N/A"),
  num: () => new FormulaError("#NUM!"),
  circular: () => new FormulaError("#REF!", "circular reference"),
};

export function isError(value: unknown): value is FormulaError {
  return value instanceof FormulaError;
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

export function parseAddress(address: string): { row: number; col: number } | null {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(address.trim());
  if (!match) return null;
  const letters = match[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

export function formatAddress(row: number, col: number): string {
  let name = "";
  let value = col + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return `${name}${row + 1}`;
}

export function columnLabel(col: number): string {
  return formatAddress(0, col).replace(/\d+$/, "");
}

export interface RangeParts {
  start: { row: number; col: number };
  end: { row: number; col: number };
}

export function parseRange(range: string): RangeParts | null {
  const [first, second] = range.split(":");
  const start = parseAddress(first ?? "");
  const end = parseAddress(second ?? first ?? "");
  if (!start || !end) return null;
  return {
    start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
    end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
  };
}

export function addressesInRange(range: string, limit = 500_000): string[] {
  const parts = parseRange(range);
  if (!parts) return [];
  const out: string[] = [];
  for (let row = parts.start.row; row <= parts.end.row; row += 1) {
    for (let col = parts.start.col; col <= parts.end.col; col += 1) {
      if (out.length >= limit) return out;
      out.push(formatAddress(row, col));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation context
// ---------------------------------------------------------------------------

export interface FormulaContext {
  /** Value of a cell; sheet null means the current sheet. */
  getValue: (sheet: string | null, address: string) => Scalar;
  /** Names of all sheets, for validation and cross-sheet errors. */
  sheetNames: string[];
  /** Current sheet name ("" when single-sheet). */
  currentSheet: string;
  /** Guard against runaway ranges. */
  maxRangeCells?: number;
}

interface Token {
  type: "number" | "string" | "ref" | "range" | "ident" | "op" | "lparen" | "rparen" | "comma" | "bool" | "error";
  value: string;
  sheet?: string | null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const OPERATORS = ["<>", "<=", ">=", "=", "<", ">", "+", "-", "*", "/", "^", "&", "%"];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const ch = input[index];
    if (ch === " " || ch === "\t" || ch === "\n") {
      index += 1;
      continue;
    }
    if (ch === '"') {
      let value = "";
      index += 1;
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += input[index];
        index += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(input[index + 1] ?? ""))) {
      let value = "";
      while (index < input.length && /[0-9.eE+\-]/.test(input[index])) {
        // Stop a trailing +/- that is an operator, not an exponent sign.
        if ((input[index] === "+" || input[index] === "-") && !/[eE]$/.test(value)) break;
        value += input[index];
        index += 1;
      }
      tokens.push({ type: "number", value });
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      index += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      index += 1;
      continue;
    }
    if (ch === "," || ch === ";") {
      tokens.push({ type: "comma", value: "," });
      index += 1;
      continue;
    }
    if (ch === "'") {
      // Quoted sheet name: 'My Sheet'!A1
      let sheet = "";
      index += 1;
      while (index < input.length && input[index] !== "'") {
        sheet += input[index];
        index += 1;
      }
      index += 1;
      if (input[index] === "!") index += 1;
      const reference = readReference(input, index);
      if (reference) {
        tokens.push({ type: reference.range ? "range" : "ref", value: reference.address, sheet });
        index = reference.next;
        continue;
      }
      tokens.push({ type: "ident", value: sheet });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = index;
      while (index < input.length && /[A-Za-z0-9_$.]/.test(input[index])) index += 1;
      let word = input.slice(start, index);
      let sheet: string | null = null;
      if (input[index] === "!") {
        sheet = word;
        index += 1;
        const reference = readReference(input, index);
        if (reference) {
          tokens.push({ type: reference.range ? "range" : "ref", value: reference.address, sheet });
          index = reference.next;
          continue;
        }
      }
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({ type: "bool", value: upper });
        continue;
      }
      if (upper === "#REF!" || upper === "#VALUE!" || upper === "#NAME?" || upper === "#DIV/0!" || upper === "#N/A") {
        tokens.push({ type: "error", value: upper });
        continue;
      }
      // Bare cell reference?
      const reference = readReference(input, start);
      if (reference && (reference.range || /^\$?[A-Za-z]+\$?\d+$/.test(reference.address))) {
        tokens.push({ type: reference.range ? "range" : "ref", value: reference.address, sheet: null });
        index = reference.next;
        continue;
      }
      word = input.slice(start, index);
      tokens.push({ type: "ident", value: word.toUpperCase() });
      continue;
    }
    const doubleOperator = OPERATORS.find((operator) => operator.length === 2 && input.startsWith(operator, index));
    if (doubleOperator) {
      tokens.push({ type: "op", value: doubleOperator });
      index += 2;
      continue;
    }
    const singleOperator = OPERATORS.find((operator) => operator.length === 1 && input.startsWith(operator, index));
    if (singleOperator) {
      tokens.push({ type: "op", value: singleOperator });
      index += 1;
      continue;
    }
    // Unknown character: treat as a name error.
    tokens.push({ type: "error", value: "#NAME?" });
    index += 1;
  }
  return tokens;
}

function readReference(input: string, index: number): { address: string; range: boolean; next: number } | null {
  const pattern = /^\$?[A-Za-z]{1,3}\$?\d{1,7}/;
  const match = pattern.exec(input.slice(index));
  if (!match) return null;
  let end = index + match[0].length;
  let range = false;
  if (input[end] === ":") {
    const second = pattern.exec(input.slice(end + 1));
    if (second) {
      end = end + 1 + second[0].length;
      range = true;
    }
  }
  return { address: input.slice(index, end).replace(/\$/g, ""), range, next: end };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Node =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "error"; value: string }
  | { type: "ref"; address: string; sheet: string | null }
  | { type: "range"; range: string; sheet: string | null }
  | { type: "unary"; op: string; operand: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "percent"; operand: Node }
  | { type: "call"; name: string; args: Node[] };

class Parser {
  private position = 0;

  constructor(private tokens: Token[]) {}

  parse(): Node {
    const node = this.parseComparison();
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token | undefined {
    return this.tokens[this.position++];
  }

  private parseComparison(): Node {
    let left = this.parseConcat();
    while (this.peek()?.type === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(this.peek()!.value)) {
      const op = this.next()!.value;
      const right = this.parseConcat();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseConcat(): Node {
    let left = this.parseAdditive();
    while (this.peek()?.type === "op" && this.peek()!.value === "&") {
      this.next();
      const right = this.parseAdditive();
      left = { type: "binary", op: "&", left, right };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.peek()?.type === "op" && ["+", "-"].includes(this.peek()!.value)) {
      const op = this.next()!.value;
      const right = this.parseMultiplicative();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parsePower();
    while (this.peek()?.type === "op" && ["*", "/"].includes(this.peek()!.value)) {
      const op = this.next()!.value;
      const right = this.parsePower();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parsePower(): Node {
    const left = this.parseUnary();
    if (this.peek()?.type === "op" && this.peek()!.value === "^") {
      this.next();
      const right = this.parsePower();
      return { type: "binary", op: "^", left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token?.type === "op" && (token.value === "-" || token.value === "+")) {
      this.next();
      const operand = this.parseUnary();
      return { type: "unary", op: token.value, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    while (this.peek()?.type === "op" && this.peek()!.value === "%") {
      this.next();
      node = { type: "percent", operand: node };
    }
    return node;
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (!token) return { type: "error", value: "#NAME?" };
    switch (token.type) {
      case "number": {
        const value = Number(token.value);
        return Number.isFinite(value) ? { type: "number", value } : { type: "error", value: "#VALUE!" };
      }
      case "string":
        return { type: "string", value: token.value };
      case "bool":
        return { type: "bool", value: token.value === "TRUE" };
      case "error":
        return { type: "error", value: token.value };
      case "ref":
        return { type: "ref", address: token.value, sheet: token.sheet ?? null };
      case "range":
        return { type: "range", range: token.value, sheet: token.sheet ?? null };
      case "ident": {
        if (this.peek()?.type === "lparen") {
          this.next();
          const args: Node[] = [];
          if (this.peek()?.type !== "rparen") {
            args.push(this.parseComparison());
            while (this.peek()?.type === "comma") {
              this.next();
              args.push(this.parseComparison());
            }
          }
          if (this.peek()?.type === "rparen") this.next();
          return { type: "call", name: token.value, args };
        }
        return { type: "error", value: "#NAME?" };
      }
      case "lparen": {
        const inner = this.parseComparison();
        if (this.peek()?.type === "rparen") this.next();
        return inner;
      }
      default:
        return { type: "error", value: "#NAME?" };
    }
  }
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

type FunctionArgs = Scalar[][][];
type FunctionImplementation = (args: FunctionArgs) => Scalar;

interface FunctionSpec {
  fn: FunctionImplementation;
  min: number;
  max: number;
}

const FUNCTIONS = new Map<string, FunctionSpec>();

export function registerFunction(name: string, fn: FunctionImplementation, min = 0, max = 32) {
  FUNCTIONS.set(name.toUpperCase(), { fn, min, max });
}

export function functionNames(): string[] {
  return [...FUNCTIONS.keys()].sort();
}

function toNumber(value: Scalar): number | FormulaError {
  if (isError(value)) return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value).trim();
  if (text === "") return 0;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : ERR.value();
}

function toText(value: Scalar): string {
  if (isError(value)) return value.code;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatPlainNumber(value);
  return value;
}

function formatPlainNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

function toBool(value: Scalar): boolean | FormulaError {
  if (isError(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toUpperCase();
  if (text === "TRUE") return true;
  if (text === "FALSE") return false;
  return ERR.value();
}

function flatten(args: FunctionArgs): Scalar[] {
  const out: Scalar[] = [];
  for (const arg of args) for (const row of arg) out.push(...row);
  return out;
}

function numbers(args: FunctionArgs): number[] {
  const out: number[] = [];
  for (const value of flatten(args)) {
    if (isError(value)) continue;
    if (typeof value === "number") out.push(value);
    else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) out.push(Number(value));
  }
  return out;
}

function compareScalars(a: Scalar, b: Scalar): number {
  const numberA = typeof a === "string" && a.trim() !== "" && Number.isFinite(Number(a)) ? Number(a) : typeof a === "boolean" ? (a ? 1 : 0) : a;
  const numberB = typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b)) ? Number(b) : typeof b === "boolean" ? (b ? 1 : 0) : b;
  if (typeof numberA === "number" && typeof numberB === "number") return numberA - numberB;
  const textA = String(numberA).toUpperCase();
  const textB = String(numberB).toUpperCase();
  return textA.localeCompare(textB);
}

function criteriaMatcher(criteria: Scalar): (value: Scalar) => boolean {
  const text = String(criteria ?? "");
  const match = /^(<=|>=|<>|=|<|>)(.*)$/.exec(text);
  const operator = match?.[1] ?? "=";
  const operand = match ? match[2] : text;
  const operandNumber = Number(operand);
  const isNumeric = operand.trim() !== "" && Number.isFinite(operandNumber);
  return (value: Scalar) => {
    if (isError(value)) return false;
    const valueNumber = typeof value === "number" ? value : typeof value === "boolean" ? (value ? 1 : 0) : Number(String(value));
    const numeric = isNumeric && Number.isFinite(valueNumber);
    switch (operator) {
      case "=":
        return numeric ? valueNumber === operandNumber : String(value).toUpperCase() === operand.toUpperCase();
      case "<>":
        return numeric ? valueNumber !== operandNumber : String(value).toUpperCase() !== operand.toUpperCase();
      case "<":
        return numeric ? valueNumber < operandNumber : compareScalars(value, operand) < 0;
      case ">":
        return numeric ? valueNumber > operandNumber : compareScalars(value, operand) > 0;
      case "<=":
        return numeric ? valueNumber <= operandNumber : compareScalars(value, operand) <= 0;
      case ">=":
        return numeric ? valueNumber >= operandNumber : compareScalars(value, operand) >= 0;
      default:
        return false;
    }
  };
}

function padMatrix(args: FunctionArgs): Scalar[][][] {
  const matrices = args.map((arg) => (arg.length > 0 ? arg : [["" as Scalar]]));
  const width = Math.max(1, ...matrices.map((matrix) => matrix[0]?.length ?? 1));
  return matrices.map((matrix) => matrix.map((row) => (row.length >= width ? row : [...row, ...(Array(width - row.length).fill("") as Scalar[])])));
}

registerFunction("SUM", (args) => numbers(args).reduce((sum, value) => sum + value, 0), 1, 64);
registerFunction("PRODUCT", (args) => numbers(args).reduce((product, value) => product * value, 1), 1, 64);
registerFunction("AVERAGE", (args) => {
  const values = numbers(args);
  return values.length === 0 ? ERR.div() : values.reduce((sum, value) => sum + value, 0) / values.length;
}, 1, 64);
registerFunction("MIN", (args) => {
  const values = numbers(args);
  return values.length === 0 ? 0 : Math.min(...values);
}, 1, 64);
registerFunction("MAX", (args) => {
  const values = numbers(args);
  return values.length === 0 ? 0 : Math.max(...values);
}, 1, 64);
registerFunction("COUNT", (args) => numbers(args).length, 1, 64);
registerFunction("COUNTA", (args) => flatten(args).filter((value) => !isError(value) && String(value) !== "").length, 1, 64);
registerFunction("COUNTBLANK", (args) => flatten(args).filter((value) => String(value) === "").length, 1, 64);
registerFunction("MEDIAN", (args) => {
  const values = numbers(args).sort((a, b) => a - b);
  if (values.length === 0) return ERR.num();
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}, 1, 64);
registerFunction("STDEV", (args) => {
  const values = numbers(args);
  if (values.length < 2) return ERR.div();
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}, 1, 64);
registerFunction("IF", (args) => {
  const condition = toBool(args[0]?.[0]?.[0] ?? false);
  if (isError(condition)) return condition;
  return condition ? args[1]?.[0]?.[0] ?? true : args[2]?.[0]?.[0] ?? false;
}, 2, 4);
registerFunction("IFS", (args) => {
  for (let index = 0; index + 1 < args.length; index += 2) {
    const condition = toBool(args[index]?.[0]?.[0] ?? false);
    if (isError(condition)) return condition;
    if (condition) return args[index + 1]?.[0]?.[0] ?? true;
  }
  return ERR.na();
}, 2, 64);
registerFunction("IFERROR", (args) => {
  const value = args[0]?.[0]?.[0];
  return isError(value) ? args[1]?.[0]?.[0] ?? "" : value ?? "";
}, 2, 2);
registerFunction("AND", (args) => {
  const values = flatten(args).filter((value) => String(value) !== "");
  if (values.length === 0) return ERR.value();
  for (const value of values) {
    const bool = toBool(value);
    if (isError(bool)) return bool;
    if (!bool) return false;
  }
  return true;
}, 1, 64);
registerFunction("OR", (args) => {
  const values = flatten(args).filter((value) => String(value) !== "");
  if (values.length === 0) return ERR.value();
  for (const value of values) {
    const bool = toBool(value);
    if (isError(bool)) return bool;
    if (bool) return true;
  }
  return false;
}, 1, 64);
registerFunction("NOT", (args) => {
  const value = toBool(args[0]?.[0]?.[0] ?? false);
  return isError(value) ? value : !value;
}, 1, 1);
registerFunction("ROUND", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  const digits = toNumber(args[1]?.[0]?.[0] ?? 0);
  if (isError(value)) return value;
  if (isError(digits)) return digits;
  const factor = 10 ** Math.trunc(digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}, 1, 2);
registerFunction("ROUNDUP", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  const digits = toNumber(args[1]?.[0]?.[0] ?? 0);
  if (isError(value)) return value;
  if (isError(digits)) return digits;
  const factor = 10 ** Math.trunc(digits);
  return (value < 0 ? -1 : 1) * Math.ceil(Math.abs(value) * factor) / factor;
}, 1, 2);
registerFunction("ROUNDDOWN", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  const digits = toNumber(args[1]?.[0]?.[0] ?? 0);
  if (isError(value)) return value;
  if (isError(digits)) return digits;
  const factor = 10 ** Math.trunc(digits);
  return (value < 0 ? -1 : 1) * Math.floor(Math.abs(value) * factor) / factor;
}, 1, 2);
registerFunction("ABS", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  return isError(value) ? value : Math.abs(value);
}, 1, 1);
registerFunction("SQRT", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  if (isError(value)) return value;
  return value < 0 ? ERR.num() : Math.sqrt(value);
}, 1, 1);
registerFunction("POWER", (args) => {
  const base = toNumber(args[0]?.[0]?.[0] ?? 0);
  const exponent = toNumber(args[1]?.[0]?.[0] ?? 0);
  if (isError(base)) return base;
  if (isError(exponent)) return exponent;
  const result = base ** exponent;
  return Number.isFinite(result) ? result : ERR.num();
}, 2, 2);
registerFunction("MOD", (args) => {
  const dividend = toNumber(args[0]?.[0]?.[0] ?? 0);
  const divisor = toNumber(args[1]?.[0]?.[0] ?? 0);
  if (isError(dividend)) return dividend;
  if (isError(divisor)) return divisor;
  if (divisor === 0) return ERR.div();
  return dividend - divisor * Math.floor(dividend / divisor);
}, 2, 2);
registerFunction("INT", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  return isError(value) ? value : Math.floor(value);
}, 1, 1);
registerFunction("CEILING", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  const step = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(value)) return value;
  if (isError(step)) return step;
  if (step === 0) return 0;
  return Math.ceil(value / step) * step;
}, 1, 2);
registerFunction("FLOOR", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  const step = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(value)) return value;
  if (isError(step)) return step;
  if (step === 0) return 0;
  return Math.floor(value / step) * step;
}, 1, 2);
registerFunction("SUMIF", (args) => {
  const range = flatten([args[0] ?? []]);
  const criteria = args[1]?.[0]?.[0] ?? "";
  const sumRange = args[2] ? flatten([args[2]]) : range;
  const matches = criteriaMatcher(criteria);
  let total = 0;
  range.forEach((value, index) => {
    if (matches(value)) {
      const number = toNumber(sumRange[index] ?? 0);
      if (!isError(number)) total += number;
    }
  });
  return total;
}, 2, 3);
registerFunction("COUNTIF", (args) => {
  const range = flatten([args[0] ?? []]);
  const matches = criteriaMatcher(args[1]?.[0]?.[0] ?? "");
  return range.filter(matches).length;
}, 2, 2);
registerFunction("AVERAGEIF", (args) => {
  const range = flatten([args[0] ?? []]);
  const matches = criteriaMatcher(args[1]?.[0]?.[0] ?? "");
  const averageRange = args[2] ? flatten([args[2]]) : range;
  let total = 0;
  let count = 0;
  range.forEach((value, index) => {
    if (matches(value)) {
      const number = toNumber(averageRange[index] ?? 0);
      if (!isError(number)) {
        total += number;
        count += 1;
      }
    }
  });
  return count === 0 ? ERR.div() : total / count;
}, 2, 3);
registerFunction("SUMIFS", (args) => {
  const sumRange = flatten([args[0] ?? []]);
  let total = 0;
  sumRange.forEach((value, index) => {
    let ok = true;
    for (let position = 1; position + 1 < args.length; position += 2) {
      const range = flatten([args[position] ?? []]);
      const matches = criteriaMatcher(args[position + 1]?.[0]?.[0] ?? "");
      if (!matches(range[index] ?? "")) ok = false;
    }
    if (ok) {
      const number = toNumber(value);
      if (!isError(number)) total += number;
    }
  });
  return total;
}, 3, 64);
registerFunction("COUNTIFS", (args) => {
  const first = flatten([args[0] ?? []]);
  let count = 0;
  first.forEach((_value, index) => {
    let ok = true;
    for (let position = 0; position + 1 < args.length; position += 2) {
      const range = flatten([args[position] ?? []]);
      const matches = criteriaMatcher(args[position + 1]?.[0]?.[0] ?? "");
      if (!matches(range[index] ?? "")) ok = false;
    }
    if (ok) count += 1;
  });
  return count;
}, 2, 64);
registerFunction("VLOOKUP", (args) => {
  const needle = args[0]?.[0]?.[0] ?? "";
  const table = args[1] ?? [];
  const column = toNumber(args[2]?.[0]?.[0] ?? 1);
  const approximate = args[3] ? toBool(args[3]?.[0]?.[0] ?? false) : false;
  if (isError(column)) return column;
  const columnIndex = Math.trunc(column) - 1;
  if (columnIndex < 0 || (table[0] && columnIndex >= table[0].length)) return ERR.ref();
  let found: Scalar | undefined;
  for (const row of table) {
    const value = row[0] ?? "";
    if (compareScalars(value, needle) === 0) {
      found = row[columnIndex] ?? "";
      break;
    }
    if (approximate === true && compareScalars(value, needle) < 0) found = row[columnIndex] ?? "";
  }
  return found ?? ERR.na();
}, 3, 4);
registerFunction("HLOOKUP", (args) => {
  const needle = args[0]?.[0]?.[0] ?? "";
  const table = args[1] ?? [];
  const row = toNumber(args[2]?.[0]?.[0] ?? 1);
  if (isError(row)) return row;
  const rowIndex = Math.trunc(row) - 1;
  if (rowIndex < 0 || rowIndex >= table.length) return ERR.ref();
  const header = table[0] ?? [];
  for (let column = 0; column < header.length; column += 1) {
    if (compareScalars(header[column] ?? "", needle) === 0) return table[rowIndex]?.[column] ?? ERR.na();
  }
  return ERR.na();
}, 3, 4);
registerFunction("XLOOKUP", (args) => {
  const needle = args[0]?.[0]?.[0] ?? "";
  const lookup = flatten([args[1] ?? []]);
  const results = flatten([args[2] ?? []]);
  const index = lookup.findIndex((value) => compareScalars(value, needle) === 0);
  if (index < 0) return args[3]?.[0]?.[0] ?? ERR.na();
  return results[index] ?? ERR.na();
}, 3, 4);
registerFunction("INDEX", (args) => {
  const matrix = args[0] ?? [];
  const row = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(row)) return row;
  const rowIndex = Math.trunc(row) - 1;
  if (rowIndex < 0 || rowIndex >= matrix.length) return ERR.ref();
  const columnValue = args[2] ? toNumber(args[2]?.[0]?.[0] ?? 1) : 1;
  if (isError(columnValue)) return columnValue;
  const columnIndex = Math.trunc(columnValue) - 1;
  const target = matrix[rowIndex];
  if (!target) return ERR.ref();
  if (columnIndex < 0 || columnIndex >= target.length) {
    if (matrix.length === 1 || target.length === 1) {
      const flat = flatten([matrix]);
      const position = rowIndex;
      return flat[position] ?? ERR.ref();
    }
    return ERR.ref();
  }
  return target[columnIndex] ?? ERR.ref();
}, 1, 3);
registerFunction("MATCH", (args) => {
  const needle = args[0]?.[0]?.[0] ?? "";
  const lookup = flatten([args[1] ?? []]);
  for (let index = 0; index < lookup.length; index += 1) {
    if (compareScalars(lookup[index], needle) === 0) return index + 1;
  }
  return ERR.na();
}, 2, 3);
registerFunction("CONCAT", (args) => flatten(args).map(toText).join(""), 1, 64);
registerFunction("TEXTJOIN", (args) => {
  const delimiter = toText(args[0]?.[0]?.[0] ?? "");
  const ignoreEmpty = toBool(args[1]?.[0]?.[0] ?? false);
  const parts = flatten(args.slice(2)).map(toText).filter((text) => !(ignoreEmpty === true && text === ""));
  return parts.join(delimiter);
}, 2, 64);
registerFunction("LEFT", (args) => {
  const text = toText(args[0]?.[0]?.[0] ?? "");
  const count = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(count)) return count;
  return text.slice(0, Math.max(0, Math.trunc(count)));
}, 1, 2);
registerFunction("RIGHT", (args) => {
  const text = toText(args[0]?.[0]?.[0] ?? "");
  const count = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(count)) return count;
  const size = Math.max(0, Math.trunc(count));
  return size === 0 ? "" : text.slice(-size);
}, 1, 2);
registerFunction("MID", (args) => {
  const text = toText(args[0]?.[0]?.[0] ?? "");
  const start = toNumber(args[1]?.[0]?.[0] ?? 1);
  const count = toNumber(args[2]?.[0]?.[0] ?? 0);
  if (isError(start)) return start;
  if (isError(count)) return count;
  return text.substr(Math.max(0, Math.trunc(start) - 1), Math.max(0, Math.trunc(count)));
}, 3, 3);
registerFunction("LEN", (args) => toText(args[0]?.[0]?.[0] ?? "").length, 1, 1);
registerFunction("TRIM", (args) => toText(args[0]?.[0]?.[0] ?? "").trim().replace(/\s+/g, " "), 1, 1);
registerFunction("UPPER", (args) => toText(args[0]?.[0]?.[0] ?? "").toUpperCase(), 1, 1);
registerFunction("LOWER", (args) => toText(args[0]?.[0]?.[0] ?? "").toLowerCase(), 1, 1);
registerFunction("PROPER", (args) =>
  toText(args[0]?.[0]?.[0] ?? "")
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (_match, space, letter) => space + String(letter).toUpperCase()),
1, 1);
registerFunction("SUBSTITUTE", (args) => {
  const text = toText(args[0]?.[0]?.[0] ?? "");
  const search = toText(args[1]?.[0]?.[0] ?? "");
  const replacement = toText(args[2]?.[0]?.[0] ?? "");
  return search === "" ? text : text.split(search).join(replacement);
}, 3, 4);
registerFunction("REPT", (args) => {
  const text = toText(args[0]?.[0]?.[0] ?? "");
  const count = toNumber(args[1]?.[0]?.[0] ?? 0);
  if (isError(count)) return count;
  return text.repeat(Math.max(0, Math.min(1000, Math.trunc(count))));
}, 2, 2);
registerFunction("TEXT", (args) => {
  const value = args[0]?.[0]?.[0] ?? "";
  const format = toText(args[1]?.[0]?.[0] ?? "");
  if (typeof value !== "number") return toText(value);
  return formatNumber(value, format);
}, 2, 2);
registerFunction("VALUE", (args) => {
  const number = toNumber(args[0]?.[0]?.[0] ?? "");
  return number;
}, 1, 1);
registerFunction("TODAY", () => Math.floor(Date.now() / 86_400_000) + 25569, 0, 0);
registerFunction("NOW", () => Date.now() / 86_400_000 + 25569, 0, 0);
registerFunction("DATE", (args) => {
  const year = toNumber(args[0]?.[0]?.[0] ?? 1970);
  const month = toNumber(args[1]?.[0]?.[0] ?? 1);
  const day = toNumber(args[2]?.[0]?.[0] ?? 1);
  if (isError(year)) return year;
  if (isError(month)) return month;
  if (isError(day)) return day;
  const date = new Date(Date.UTC(Math.trunc(year), Math.trunc(month) - 1, Math.trunc(day)));
  return date.getTime() / 86_400_000 + 25569;
}, 3, 3);
registerFunction("YEAR", (args) => serialToDate(args[0]?.[0]?.[0] ?? 0)?.getUTCFullYear() ?? ERR.value(), 1, 1);
registerFunction("MONTH", (args) => (serialToDate(args[0]?.[0]?.[0] ?? 0)?.getUTCMonth() ?? -1) + 1, 1, 1);
registerFunction("DAY", (args) => serialToDate(args[0]?.[0]?.[0] ?? 0)?.getUTCDate() ?? ERR.value(), 1, 1);
registerFunction("HOUR", (args) => serialToDate(args[0]?.[0]?.[0] ?? 0)?.getUTCHours() ?? ERR.value(), 1, 1);
registerFunction("MINUTE", (args) => serialToDate(args[0]?.[0]?.[0] ?? 0)?.getUTCMinutes() ?? ERR.value(), 1, 1);
registerFunction("LARGE", (args) => {
  const values = numbers([args[0] ?? []]).sort((a, b) => b - a);
  const position = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(position)) return position;
  const value = values[Math.trunc(position) - 1];
  return value ?? ERR.num();
}, 2, 2);
registerFunction("SMALL", (args) => {
  const values = numbers([args[0] ?? []]).sort((a, b) => a - b);
  const position = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(position)) return position;
  const value = values[Math.trunc(position) - 1];
  return value ?? ERR.num();
}, 2, 2);
registerFunction("RANK", (args) => {
  const value = toNumber(args[0]?.[0]?.[0] ?? 0);
  const values = numbers([args[1] ?? []]);
  if (isError(value)) return value;
  const descending = args[2] ? (toNumber(args[2]?.[0]?.[0] ?? 0) as number) === 0 : false;
  const sorted = [...values].sort((a, b) => (descending ? a - b : b - a));
  const index = sorted.findIndex((candidate) => candidate === value);
  return index < 0 ? ERR.na() : index + 1;
}, 2, 3);
registerFunction("ISNUMBER", (args) => typeof args[0]?.[0]?.[0] === "number", 1, 1);
registerFunction("ISTEXT", (args) => typeof args[0]?.[0]?.[0] === "string", 1, 1);
registerFunction("ISBLANK", (args) => {
  const value = args[0]?.[0]?.[0];
  return value === undefined || value === "";
}, 1, 1);
registerFunction("ISERROR", (args) => isError(args[0]?.[0]?.[0]), 1, 1);
registerFunction("N", (args) => {
  const number = toNumber(args[0]?.[0]?.[0] ?? 0);
  return isError(number) ? 0 : number;
}, 1, 1);
registerFunction("PI", () => Math.PI, 0, 0);
registerFunction("RAND", () => Math.random(), 0, 0);
registerFunction("RANDBETWEEN", (args) => {
  const low = toNumber(args[0]?.[0]?.[0] ?? 0);
  const high = toNumber(args[1]?.[0]?.[0] ?? 1);
  if (isError(low)) return low;
  if (isError(high)) return high;
  return Math.floor(Math.random() * (high - low + 1)) + low;
}, 2, 2);
registerFunction("SUMPRODUCT", (args) => {
  const matrices = padMatrix(args);
  const first: Scalar[][] = matrices[0] ?? [];
  let total = 0;
  first.forEach((row: Scalar[], rowIndex: number) => {
    row.forEach((value: Scalar, columnIndex: number) => {
      const product = matrices.reduce((acc: number, matrix: Scalar[][]) => {
        const number = toNumber(matrix[rowIndex]?.[columnIndex] ?? 0);
        return isError(number) ? acc : acc * number;
      }, 1);
      const base = toNumber(value);
      if (!isError(base)) total += product;
    });
  });
  return total;
}, 1, 32);
registerFunction("TRANSPOSE", (args) => {
  const matrix = args[0] ?? [];
  if (matrix.length === 0) return ERR.value();
  const width = matrix[0].length;
  const out: Scalar[][] = [];
  for (let column = 0; column < width; column += 1) {
    out.push(matrix.map((row) => row[column] ?? ""));
  }
  return out[0]?.[0] ?? "";
}, 1, 1);

function serialToDate(value: Scalar): Date | null {
  const number = toNumber(value);
  if (isError(number)) return null;
  return new Date(Math.round((number - 25569) * 86_400_000));
}

export function formatNumber(value: number, format: string): string {
  const trimmed = format.trim();
  if (!trimmed || trimmed.toLowerCase() === "general") return formatPlainNumber(value);
  const datePattern = /(yyyy|yy|dd|mm|hh|ss|mmm)/i.test(trimmed) && !/[#0]/.test(trimmed);
  if (datePattern) {
    const date = serialToDate(value);
    if (!date) return formatPlainNumber(value);
    const pad = (input: number) => String(input).padStart(2, "0");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return trimmed
      .replace(/yyyy/gi, String(date.getUTCFullYear()))
      .replace(/yy/gi, String(date.getUTCFullYear()).slice(-2))
      .replace(/mmm/gi, months[date.getUTCMonth()])
      .replace(/mm/gi, pad(date.getUTCMonth() + 1))
      .replace(/dd/gi, pad(date.getUTCDate()))
      .replace(/hh/gi, pad(date.getUTCHours()))
      .replace(/ss/gi, pad(date.getUTCSeconds()))
      .replace(/m/gi, String(date.getUTCMinutes()));
  }
  const percent = trimmed.includes("%");
  const currency = /[$€£₺]/.exec(trimmed)?.[0] ?? "";
  const decimalsMatch = /\.(0+)/.exec(trimmed);
  const decimals = decimalsMatch ? decimalsMatch[1].length : 0;
  const grouped = trimmed.includes(",");
  let display = percent ? value * 100 : value;
  const sign = display < 0 ? "-" : "";
  display = Math.abs(display);
  let text = display.toFixed(decimals);
  if (grouped) {
    const [whole, fraction] = text.split(".");
    text = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
  }
  const negativePattern = trimmed.includes("(") && trimmed.includes(")");
  let out = `${sign}${currency}${text}${percent ? "%" : ""}`;
  if (sign === "-" && negativePattern) out = `(${currency}${text}${percent ? "%" : ""})`;
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface EvalState {
  context: FormulaContext;
  stack: string[];
}

function evaluateNode(node: Node, state: EvalState): Scalar | CellMatrix {
  const { context } = state;
  switch (node.type) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "bool":
      return node.value;
    case "error":
      return new FormulaError(node.value);
    case "ref": {
      const sheet = node.sheet ?? null;
      if (sheet && !context.sheetNames.includes(sheet)) return ERR.ref();
      const key = `${sheet ?? context.currentSheet}!${node.address}`;
      if (state.stack.includes(key)) return ERR.circular();
      return context.getValue(sheet, node.address);
    }
    case "range": {
      const sheet = node.sheet ?? null;
      if (sheet && !context.sheetNames.includes(sheet)) return ERR.ref();
      const parts = parseRange(node.range);
      if (!parts) return ERR.ref();
      const limit = context.maxRangeCells ?? 200_000;
      if ((parts.end.row - parts.start.row + 1) * (parts.end.col - parts.start.col + 1) > limit) return ERR.ref();
      const matrix: Scalar[][] = [];
      for (let row = parts.start.row; row <= parts.end.row; row += 1) {
        const line: Scalar[] = [];
        for (let col = parts.start.col; col <= parts.end.col; col += 1) {
          line.push(context.getValue(sheet, formatAddress(row, col)));
        }
        matrix.push(line);
      }
      return matrix;
    }
    case "unary": {
      const value = asScalar(evaluateNode(node.operand, state));
      if (isError(value)) return value;
      const number = toNumber(value);
      if (isError(number)) return number;
      return node.op === "-" ? -number : number;
    }
    case "percent": {
      const value = toNumber(asScalar(evaluateNode(node.operand, state)));
      return isError(value) ? value : value / 100;
    }
    case "binary": {
      const left = asScalar(evaluateNode(node.left, state));
      const right = asScalar(evaluateNode(node.right, state));
      return evaluateBinary(node.op, left, right);
    }
    case "call": {
      const spec = FUNCTIONS.get(node.name);
      if (!spec) return ERR.name();
      if (node.args.length < spec.min || node.args.length > spec.max) return ERR.value();
      const args: FunctionArgs = node.args.map((argument) => {
        const value = evaluateNode(argument, state);
        return Array.isArray(value) ? value : [[value]];
      });
      const result = spec.fn(args);
      return result;
    }
  }
}

function asScalar(value: Scalar | CellMatrix): Scalar {
  if (Array.isArray(value)) {
    const first = value[0]?.[0];
    return first === undefined ? "" : first;
  }
  return value;
}

function evaluateBinary(op: string, left: Scalar, right: Scalar): Scalar {
  if (isError(left)) return left;
  if (isError(right)) return right;
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "^": {
      const a = toNumber(left);
      const b = toNumber(right);
      if (isError(a)) return a;
      if (isError(b)) return b;
      switch (op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return b === 0 ? ERR.div() : a / b;
        default: {
          const result = a ** b;
          return Number.isFinite(result) ? result : ERR.num();
        }
      }
    }
    case "&":
      return toText(left) + toText(right);
    case "=":
      return compareScalars(left, right) === 0;
    case "<>":
      return compareScalars(left, right) !== 0;
    case "<":
      return compareScalars(left, right) < 0;
    case ">":
      return compareScalars(left, right) > 0;
    case "<=":
      return compareScalars(left, right) <= 0;
    case ">=":
      return compareScalars(left, right) >= 0;
    default:
      return ERR.value();
  }
}

/** Evaluates a formula (with or without a leading "="). */
export function evaluateFormula(formula: string, context: FormulaContext): Scalar {
  const body = formula.trim().replace(/^=/, "").trim();
  if (body === "") return "";
  let tokens: Token[];
  try {
    tokens = tokenize(body);
  } catch {
    return ERR.value();
  }
  const parser = new Parser(tokens);
  const node = parser.parse();
  try {
    return asScalar(evaluateNode(node, { context, stack: [] }));
  } catch {
    return ERR.value();
  }
}

export function isFormula(text: string): boolean {
  return text.startsWith("=") && text.length > 1;
}

/** Suggests a function list for the formula bar autocomplete. */
export function suggestFunctions(prefix: string, limit = 8): string[] {
  const upper = prefix.toUpperCase();
  return functionNames()
    .filter((name) => name.startsWith(upper))
    .slice(0, limit);
}
