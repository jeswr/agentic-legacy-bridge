// AUTHORED-BY Claude Fable 5
/**
 * Shared UNTRUSTED-VALUE helpers for the deterministic metadata extractors
 * (metadata-protocol Rule 1 — `agentic-solid-vision/docs/NOW-PERSONAL-AGENT.md` §5.1).
 *
 * Everything an extractor reads out of an inbound JSON-LD block or iCalendar part is
 * hostile: keys may shadow prototype members, dates may overflow calendars, strings may
 * carry control sequences, "IRIs" may carry Turtle-breakout characters. These helpers
 * make each read fail-closed:
 *
 *  - {@link prop}/{@link firstProp} — own-property-only reads (a missing key can never
 *    resolve through `Object.prototype`; a hostile `__proto__`/`constructor` key is an
 *    ordinary own property under `JSON.parse` and is read as such, touching nothing).
 *  - {@link asBoundedString} — string-typed, control-stripped, length-capped.
 *  - {@link parseWhen} — FIELD-EXACT ISO-8601 date/datetime validation (a
 *    calendar-overflow like `2026-02-31` is rejected, not silently normalised into a
 *    different day), with an explicit `ambiguous` flag for zone-less values so a
 *    floating local time is never asserted as a confident instant.
 */

import { sanitizeText } from "../safe-iri.js";

/** Own-property-only read of a key on an untrusted parsed-JSON value. */
export function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** The first defined own-property among `keys` — the deterministic ALIAS-table read. */
export function firstProp(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    const v = prop(value, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** A string value, control-stripped + trimmed + length-capped; else `undefined`. */
export function asBoundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitizeText(value).trim();
  if (cleaned === "" || cleaned.length > maxChars) return undefined;
  return cleaned;
}

/** A validated calendar value: an exact instant, a zone-less local time, or a date. */
export interface ParsedWhen {
  /** `dateTime` (an instant / local time) or `date` (a whole calendar day). */
  readonly kind: "dateTime" | "date";
  /**
   * The canonical value: a UTC ISO instant (`…Z`) for `dateTime`, `YYYY-MM-DD` for
   * `date`. A zone-less input is RESOLVED AS UTC and flagged {@link ambiguous}.
   */
  readonly value: string;
  /** True when the input carried NO timezone — the instant is a UTC assumption. */
  readonly ambiguous: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Max accepted length of a date/datetime string (belt-and-braces). */
const MAX_WHEN_CHARS = 40;

/**
 * FIELD-EXACT validation of Date.UTC fields: build the ms value, then check every
 * field survived (so `Date.UTC`'s silent overflow-normalisation — Feb 31 → Mar 3 —
 * is REJECTED rather than laundered into a different day).
 */
function exactUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): number | undefined {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(ms)) return undefined;
  const probe = new Date(ms);
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d ||
    probe.getUTCHours() !== h ||
    probe.getUTCMinutes() !== mi ||
    probe.getUTCSeconds() !== s
  ) {
    return undefined;
  }
  return ms;
}

/**
 * Parse + validate an untrusted ISO-8601 date/datetime. Returns the canonicalised
 * value, or `undefined` for anything malformed, overflowing, or non-string. The
 * fractional-second part (≤3 digits) is accepted but dropped from the canonical form.
 */
export function parseWhen(value: unknown): ParsedWhen | undefined {
  if (typeof value !== "string" || value.length > MAX_WHEN_CHARS) return undefined;
  const v = value.trim();

  const dm = ISO_DATE.exec(v);
  if (dm !== null) {
    const [, ys, mos, ds] = dm as unknown as [string, string, string, string];
    const ms = exactUtcMs(Number(ys), Number(mos), Number(ds), 0, 0, 0);
    if (ms === undefined) return undefined;
    return { kind: "date", value: `${ys}-${mos}-${ds}`, ambiguous: false };
  }

  const tm = ISO_DATE_TIME.exec(v);
  if (tm === null) return undefined;
  const y = Number(tm[1]);
  const mo = Number(tm[2]);
  const d = Number(tm[3]);
  const h = Number(tm[4]);
  const mi = Number(tm[5]);
  const s = tm[6] === undefined ? 0 : Number(tm[6]);
  if (h > 23 || mi > 59 || s > 59) return undefined;
  const baseMs = exactUtcMs(y, mo, d, h, mi, s);
  if (baseMs === undefined) return undefined;

  const tz = tm[7];
  if (tz === undefined) {
    // Zone-less local time: resolve AS UTC, flagged ambiguous (never a confident instant).
    return { kind: "dateTime", value: new Date(baseMs).toISOString(), ambiguous: true };
  }
  if (tz === "Z") {
    return { kind: "dateTime", value: new Date(baseMs).toISOString(), ambiguous: false };
  }
  // ±HH:MM / ±HHMM offset — bounded fields, subtracted from the local wall-clock.
  const sign = tz[0] === "-" ? -1 : 1;
  const cleaned = tz.slice(1).replace(":", "");
  const oh = Number(cleaned.slice(0, 2));
  const om = Number(cleaned.slice(2, 4));
  if (oh > 14 || om > 59) return undefined;
  const utcMs = baseMs - sign * (oh * 60 + om) * 60_000;
  return { kind: "dateTime", value: new Date(utcMs).toISOString(), ambiguous: false };
}

/** The `xsd:` datatype IRI matching a {@link ParsedWhen}. */
export function whenDatatype(when: ParsedWhen): string {
  return when.kind === "date"
    ? "http://www.w3.org/2001/XMLSchema#date"
    : "http://www.w3.org/2001/XMLSchema#dateTime";
}

/** The literal value to assert for a {@link ParsedWhen}. */
export function whenValue(when: ParsedWhen): string {
  return when.value;
}

/** The standing note attached to any timezone-ambiguous datum (mirrors `interpret.ts`). */
export const AMBIGUOUS_TZ_NOTE =
  "resolved from a zone-less local time assuming UTC — verify the timezone.";
