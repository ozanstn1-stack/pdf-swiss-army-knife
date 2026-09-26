/**
 * Number-format rendering for Calc cells.
 *
 * Handles the subset of Excel number-format codes the ribbon exposes (General,
 * fixed decimals, percent, currency, thousands separators, accounting
 * parentheses and date/time patterns) plus the serial-date conversion the
 * financial and date functions share.
 */

/** Days between the 1899-12-30 epoch and 1970-01-01, per the Excel spec. */
export const SERIAL_EPOCH_OFFSET = 25_569;

/** A date/time that a serial number represents, or null when out of range. */
export function serialToDate(value: number): Date | null {
  if (!Number.isFinite(value) || value < -69_217 || value > 2_958_465) return null;
  return new Date(Math.round((value - SERIAL_EPOCH_OFFSET) * 86_400_000));
}

/** Inverse of `serialToDate`. */
export function dateToSerial(date: Date): number {
  return date.getTime() / 86_400_000 + SERIAL_EPOCH_OFFSET;
}

/** Whole days between two serial dates, ignoring the time of day. */
export function serialDay(serial: number): number {
  return Math.floor(serial);
}

export function formatPlainNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

export function formatNumber(value: number, format: string): string {
  const trimmed = format.trim();
  if (!trimmed || trimmed.toLowerCase() === "general") return formatPlainNumber(value);
  const datePattern = /(yyyy|yy|dd|mm|hh|ss|mmm)/i.test(trimmed) && !/[#0]/.test(trimmed);
  if (datePattern) return formatDateSerial(value, trimmed);
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
  const suffix = percent ? "%" : "";
  if (sign === "-" && negativePattern) return `(${currency}${text}${suffix})`;
  return `${sign}${currency}${text}${suffix}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateSerial(value: number, pattern: string): string {
  const date = serialToDate(value);
  if (!date) return formatPlainNumber(value);
  const pad = (input: number) => String(input).padStart(2, "0");
  // `mm` is month when it follows a date token, minutes otherwise - matching
  // the way Excel disambiguates the same letter.
  return pattern
    .replace(/yyyy/gi, String(date.getUTCFullYear()))
    .replace(/yy/gi, String(date.getUTCFullYear()).slice(-2))
    .replace(/mmm/gi, MONTH_NAMES[date.getUTCMonth()])
    .replace(/mm/gi, pad(date.getUTCMonth() + 1))
    .replace(/dd/gi, pad(date.getUTCDate()))
    .replace(/hh/gi, pad(date.getUTCHours()))
    .replace(/ss/gi, pad(date.getUTCSeconds()))
    .replace(/m(?![a-z])/gi, String(date.getUTCMinutes()));
}
