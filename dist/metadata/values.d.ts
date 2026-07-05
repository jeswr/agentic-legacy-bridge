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
/** Own-property-only read of a key on an untrusted parsed-JSON value. */
export declare function prop(value: unknown, key: string): unknown;
/** The first defined own-property among `keys` — the deterministic ALIAS-table read. */
export declare function firstProp(value: unknown, keys: readonly string[]): unknown;
/** A string value, control-stripped + trimmed + length-capped; else `undefined`. */
export declare function asBoundedString(value: unknown, maxChars: number): string | undefined;
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
/**
 * Parse + validate an untrusted ISO-8601 date/datetime. Returns the canonicalised
 * value, or `undefined` for anything malformed, overflowing, or non-string. The
 * fractional-second part (≤3 digits) is accepted but dropped from the canonical form.
 */
export declare function parseWhen(value: unknown): ParsedWhen | undefined;
/** The `xsd:` datatype IRI matching a {@link ParsedWhen}. */
export declare function whenDatatype(when: ParsedWhen): string;
/** The literal value to assert for a {@link ParsedWhen}. */
export declare function whenValue(when: ParsedWhen): string;
/** The standing note attached to any timezone-ambiguous datum (mirrors `interpret.ts`). */
export declare const AMBIGUOUS_TZ_NOTE = "resolved from a zone-less local time assuming UTC \u2014 verify the timezone.";
//# sourceMappingURL=values.d.ts.map