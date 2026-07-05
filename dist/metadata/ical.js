// AUTHORED-BY Claude Fable 5
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
import { RDF_TYPE, SCHEMA_END_TIME, SCHEMA_EVENT, SCHEMA_EVENT_CANCELLED, SCHEMA_EVENT_SCHEDULED, SCHEMA_EVENT_STATUS, SCHEMA_IDENTIFIER, SCHEMA_LOCATION, SCHEMA_NAME, SCHEMA_START_TIME, } from "../vocab.js";
import { AMBIGUOUS_TZ_NOTE, asBoundedString, parseWhen, whenDatatype } from "./values.js";
/** Caps (fail-closed). The part text itself is already size-capped by the channel parse. */
const MAX_LINES = 8192;
const MAX_UNFOLDED_LINE_CHARS = 8192;
const MAX_COMPONENT_DEPTH = 8;
const MAX_VEVENTS = 16;
const MAX_NAME_CHARS = 200;
const MAX_LOCATION_CHARS = 200;
const MAX_UID_CHARS = 256;
/**
 * Unfold RFC 5545 §3.1 folded lines (a CRLF followed by SPACE/HTAB continues the
 * line). Linear, line- and length-capped; an over-long unfolded line is truncated.
 */
export function unfoldIcalLines(text) {
    const raw = text.split(/\r\n|\n|\r/, MAX_LINES + 1).slice(0, MAX_LINES);
    const out = [];
    for (const line of raw) {
        if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
            const prev = out[out.length - 1];
            if (prev.length < MAX_UNFOLDED_LINE_CHARS) {
                out[out.length - 1] = (prev + line.slice(1)).slice(0, MAX_UNFOLDED_LINE_CHARS);
            }
            continue;
        }
        if (line !== "")
            out.push(line.slice(0, MAX_UNFOLDED_LINE_CHARS));
    }
    return out;
}
/**
 * Parse one content line — a single LINEAR character walk that honours quoted
 * parameter values (a `:`/`;` inside `"…"` never splits). Malformed → `undefined`.
 */
export function parseIcalContentLine(line) {
    // Split off the name/params region from the value at the first top-level `:`.
    let inQuote = false;
    let valueStart = -1;
    const semis = [];
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"')
            inQuote = !inQuote;
        else if (!inQuote && c === ";")
            semis.push(i);
        else if (!inQuote && c === ":") {
            valueStart = i;
            break;
        }
    }
    if (valueStart <= 0)
        return undefined;
    const nameEnd = semis.length > 0 ? semis[0] : valueStart;
    const name = line.slice(0, nameEnd).trim().toUpperCase();
    if (name === "" || !/^[A-Z0-9-]+$/.test(name))
        return undefined;
    const params = Object.create(null);
    const bounds = [...semis, valueStart];
    for (let s = 0; s < semis.length && s < 32; s++) {
        const seg = line.slice(bounds[s] + 1, bounds[s + 1]);
        const eq = seg.indexOf("=");
        if (eq === -1)
            continue;
        const key = seg.slice(0, eq).trim().toUpperCase();
        let val = seg.slice(eq + 1).trim();
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2)
            val = val.slice(1, -1);
        if (key !== "" && key.length <= 64 && params[key] === undefined)
            params[key] = val;
    }
    return { name, params, value: line.slice(valueStart + 1) };
}
/** RFC 5545 §3.3.11 TEXT unescaping: `\n` `\N` `\,` `\;` `\\` (linear). */
export function unescapeIcalText(value) {
    return value.replace(/\\([nN,;\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}
/**
 * Walk one iCalendar text's component tree (BEGIN/END, depth/count-capped) and
 * collect the VEVENT properties this extractor maps. Never throws; a mismatched
 * END or an over-cap structure just stops collection (fail-closed).
 */
export function parseCalendar(text) {
    const stack = [];
    const events = [];
    let method;
    let current;
    for (const rawLine of unfoldIcalLines(text)) {
        const line = parseIcalContentLine(rawLine);
        if (line === undefined)
            continue;
        if (line.name === "BEGIN") {
            const comp = line.value.trim().toUpperCase();
            if (stack.length >= MAX_COMPONENT_DEPTH)
                break; // depth bomb → stop, keep what we have
            stack.push(comp);
            if (comp === "VEVENT" && current === undefined && events.length < MAX_VEVENTS) {
                current = {};
            }
            continue;
        }
        if (line.name === "END") {
            const comp = line.value.trim().toUpperCase();
            if (stack.length === 0 || stack[stack.length - 1] !== comp)
                break; // mismatched → stop
            stack.pop();
            if (comp === "VEVENT" && current !== undefined) {
                events.push(current);
                current = undefined;
            }
            continue;
        }
        if (stack.length === 1 && stack[0] === "VCALENDAR" && line.name === "METHOD") {
            if (method === undefined)
                method = line.value.trim().toUpperCase().slice(0, 32);
            continue;
        }
        if (current === undefined || stack[stack.length - 1] !== "VEVENT")
            continue;
        switch (line.name) {
            case "DTSTART":
                current.dtstart ??= line;
                break;
            case "DTEND":
                current.dtend ??= line;
                break;
            case "SUMMARY":
                current.summary ??=
                    asBoundedString(unescapeIcalText(line.value), MAX_NAME_CHARS) ?? current.summary;
                break;
            case "LOCATION":
                current.location ??=
                    asBoundedString(unescapeIcalText(line.value), MAX_LOCATION_CHARS) ?? current.location;
                break;
            case "UID":
                current.uid ??= asBoundedString(line.value, MAX_UID_CHARS) ?? current.uid;
                break;
            case "STATUS":
                current.status ??= line.value.trim().toUpperCase().slice(0, 32);
                break;
            default:
                break;
        }
    }
    return { ...(method !== undefined ? { method } : {}), events };
}
/**
 * Convert an RFC 5545 DATE / DATE-TIME property to a validated ISO form via
 * {@link parseWhen}: `YYYYMMDD` (or `VALUE=DATE`) → a date; `YYYYMMDDTHHMMSSZ` → an
 * exact UTC instant; a floating or TZID-qualified local time → ambiguous (resolved
 * as UTC, downgraded by the caller). Malformed/overflowing → `undefined`.
 */
export function icalWhen(line) {
    const v = line.value.trim();
    const dateOnly = line.params.VALUE === "DATE" || /^\d{8}$/.test(v);
    if (dateOnly) {
        if (!/^\d{8}$/.test(v))
            return undefined;
        const when = parseWhen(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
        return when === undefined ? undefined : { when, ambiguous: false };
    }
    const m = /^(\d{8})T(\d{6})(Z?)$/.exec(v);
    if (m === null)
        return undefined;
    const [, dpart, tpart, zulu] = m;
    const iso = `${dpart.slice(0, 4)}-${dpart.slice(4, 6)}-${dpart.slice(6, 8)}` +
        `T${tpart.slice(0, 2)}:${tpart.slice(2, 4)}:${tpart.slice(4, 6)}${zulu === "Z" ? "Z" : ""}`;
    const when = parseWhen(iso);
    if (when === undefined)
        return undefined;
    // A local time is ambiguous whether floating or TZID-qualified (no tz database here).
    return { when, ambiguous: zulu !== "Z" };
}
/**
 * Extract deterministic {@link Interpretation}s from a message's `text/calendar`
 * parts (Rule 1b). Exact UTC datetimes land at confidence 1.0 (Calibrated); local
 * times are downgraded (0.6, SelfReported, noted) rather than asserted as instants.
 * A METHOD:CANCEL calendar or STATUS:CANCELLED event asserts
 * `schema:eventStatus schema:EventCancelled` — a cancellation must never look like
 * a fresh invite. Returns `[]` when there is nothing machine-readable.
 */
export function extractCalendarInterpretations(parts, ctx) {
    const out = [];
    if (parts === undefined || parts.length === 0)
        return out;
    let eventCount = 0;
    const push = (subject, predicate, object, overrides) => {
        out.push({
            subject,
            predicate,
            object,
            confidence: overrides?.confidence ?? 1,
            method: "Deterministic",
            calibration: overrides?.calibration ?? "Calibrated",
            securityBearing: false,
            ...(overrides?.note !== undefined ? { note: overrides.note } : {}),
        });
    };
    for (const part of parts) {
        const calendar = parseCalendar(part);
        for (const event of calendar.events) {
            if (eventCount >= MAX_VEVENTS)
                return out;
            eventCount++;
            const eventIri = `${ctx.docIri}#ical-event-${eventCount}`;
            push(eventIri, RDF_TYPE, { kind: "iri", value: SCHEMA_EVENT });
            for (const [line, predicate] of [
                [event.dtstart, SCHEMA_START_TIME],
                [event.dtend, SCHEMA_END_TIME],
            ]) {
                if (line === undefined)
                    continue;
                const parsed = icalWhen(line);
                if (parsed === undefined)
                    continue;
                const object = {
                    kind: "literal",
                    value: parsed.when.value,
                    datatype: whenDatatype(parsed.when),
                };
                if (parsed.ambiguous) {
                    push(eventIri, predicate, object, {
                        confidence: 0.6,
                        calibration: "SelfReported",
                        note: AMBIGUOUS_TZ_NOTE,
                    });
                }
                else {
                    push(eventIri, predicate, object);
                }
            }
            if (event.summary !== undefined) {
                push(eventIri, SCHEMA_NAME, { kind: "literal", value: event.summary });
            }
            if (event.location !== undefined) {
                push(eventIri, SCHEMA_LOCATION, { kind: "literal", value: event.location });
            }
            if (event.uid !== undefined) {
                push(eventIri, SCHEMA_IDENTIFIER, { kind: "literal", value: event.uid });
            }
            const cancelled = calendar.method === "CANCEL" || event.status === "CANCELLED";
            if (cancelled) {
                push(eventIri, SCHEMA_EVENT_STATUS, { kind: "iri", value: SCHEMA_EVENT_CANCELLED });
            }
            else if (event.status === "CONFIRMED") {
                push(eventIri, SCHEMA_EVENT_STATUS, { kind: "iri", value: SCHEMA_EVENT_SCHEDULED });
            }
        }
    }
    return out;
}
//# sourceMappingURL=ical.js.map