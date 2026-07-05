/**
 * Deterministic extraction of **`text/calendar` (RFC 5545) VEVENTs** (metadata-protocol
 * Rule 1b — `NOW-PERSONAL-AGENT.md` §5.1): meeting invites, updates and cancellations,
 * mapped to `schema:Event` interpretations at deterministic confidence — the same
 * mapping family `@jeswr/solid-dav-bridge` maintains for CalDAV.
 *
 * **Why an in-house content-line parser** (same rationale as dav-bridge's `ical.ts`
 * and this repo's own RFC-5322 parser): the bridge needs only the line/property/param
 * grammar plus a handful of VEVENT fields — a small, exhaustively-testable surface —
 * not a third-party parser's whole RRULE/timezone-database machinery. The RDF house
 * rule bans bespoke *RDF* parsers; iCalendar is not RDF.
 *
 * Every input is UNTRUSTED and the parse is fail-closed: hard caps on line count,
 * unfolded line length, component depth/count and events; a malformed line is skipped,
 * never fatal. Datetimes are FIELD-EXACT validated (`values.ts`) — a floating or
 * TZID-qualified local time is resolved as UTC but flagged ambiguous and carries
 * reduced, SELF-REPORTED confidence (resolving arbitrary TZIDs needs a timezone
 * database this package deliberately does not carry).
 */
import type { InterpretContext } from "../interpret.js";
import type { Interpretation } from "../reliability.js";
import { parseWhen } from "./values.js";
/** One parsed iCalendar content line: `NAME(;PARAM=VALUE)*:VALUE`. */
export interface IcalContentLine {
    /** The property name, upper-cased. */
    readonly name: string;
    /** Parameter map, names upper-cased, values dequoted. First occurrence wins. */
    readonly params: Readonly<Record<string, string>>;
    /** The raw (still text-escaped) property value. */
    readonly value: string;
}
/**
 * Unfold RFC 5545 §3.1 folded lines (a CRLF followed by SPACE/HTAB continues the
 * line). Linear, line- and length-capped; an over-long unfolded line is truncated.
 */
export declare function unfoldIcalLines(text: string): string[];
/**
 * Parse one content line — a single LINEAR character walk that honours quoted
 * parameter values (a `:`/`;` inside `"…"` never splits). Malformed → `undefined`.
 */
export declare function parseIcalContentLine(line: string): IcalContentLine | undefined;
/** RFC 5545 §3.3.11 TEXT unescaping: `\n` `\N` `\,` `\;` `\\` (linear). */
export declare function unescapeIcalText(value: string): string;
/** A collected VEVENT: the properties this extractor maps (first occurrence wins). */
interface VEvent {
    dtstart?: IcalContentLine;
    dtend?: IcalContentLine;
    summary?: string;
    location?: string;
    uid?: string;
    status?: string;
}
/** The parsed calendar: its METHOD (REQUEST/CANCEL/…) + the collected VEVENTs. */
export interface ParsedCalendar {
    readonly method?: string;
    readonly events: readonly VEvent[];
}
/**
 * Walk one iCalendar text's component tree (BEGIN/END, depth/count-capped) and
 * collect the VEVENT properties this extractor maps. Never throws; a mismatched
 * END or an over-cap structure just stops collection (fail-closed).
 */
export declare function parseCalendar(text: string): ParsedCalendar;
/**
 * Convert an RFC 5545 DATE / DATE-TIME property to a validated ISO form via
 * {@link parseWhen}: `YYYYMMDD` (or `VALUE=DATE`) → a date; `YYYYMMDDTHHMMSSZ` → an
 * exact UTC instant; a floating or TZID-qualified local time → ambiguous (resolved
 * as UTC, downgraded by the caller). Malformed/overflowing → `undefined`.
 */
export declare function icalWhen(line: IcalContentLine): {
    when: NonNullable<ReturnType<typeof parseWhen>>;
    ambiguous: boolean;
} | undefined;
/**
 * Extract deterministic {@link Interpretation}s from a message's `text/calendar`
 * parts (Rule 1b). Exact UTC datetimes land at confidence 1.0 (Calibrated); local
 * times are downgraded (0.6, SelfReported, noted) rather than asserted as instants.
 * A METHOD:CANCEL calendar or STATUS:CANCELLED event asserts
 * `schema:eventStatus schema:EventCancelled` — a cancellation must never look like
 * a fresh invite. Returns `[]` when there is nothing machine-readable.
 */
export declare function extractCalendarInterpretations(parts: readonly string[] | undefined, ctx: InterpretContext): Interpretation[];
export {};
//# sourceMappingURL=ical.d.ts.map