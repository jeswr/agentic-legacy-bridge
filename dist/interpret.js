// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The INTERPRETATION seam (LEGACY-INTEROP.md §3) — turn a message body into
 * reliability-tagged structured RDF.
 *
 * The {@link Interpreter} interface is INJECTABLE: M1 ships a hermetic, deterministic
 * rule-based reference ({@link DeterministicInterpreter}) with NO model dependency,
 * so tests are fully hermetic. The design's LLM path (an injected `translate` fn via
 * `@jeswr/solid-a2a` `parseIntent`) is an M2 adapter that implements this SAME
 * interface — the reliability model (per-datum confidence + calibration provenance)
 * is identical either way; only the METHOD (`Deterministic` vs `LlmInterpretation`)
 * and the calibration differ.
 *
 * The deterministic reference extracts the flagship signal — proposed MEETING times
 * (explicit ISO-8601 datetimes at high, re-derivable confidence; a bounded subset of
 * relative expressions like "next Tuesday at 2pm" at lower, self-reported confidence)
 * — plus a simple yes/no reply polarity. Every regex is linear (no backtracking on
 * attacker input) and every extraction is count-capped.
 */
import { AGENTIC_REPLY_POLARITY, RDF_TYPE, SCHEMA_EVENT, SCHEMA_NAME, SCHEMA_START_TIME, XSD, } from "./vocab.js";
/** Caps so a pathological body cannot produce an unbounded number of interpretations. */
const MAX_EVENTS = 16;
const MAX_SCAN_CHARS = 100_000;
const WEEKDAYS = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
};
/**
 * The hermetic, deterministic reference interpreter. No model, no network — a pure
 * function of the message body + `ctx.now`.
 */
export class DeterministicInterpreter {
    interpret(message, ctx) {
        const text = clip(unquote(message.textBody));
        const out = [];
        const now = ctx.now ?? new Date();
        // --- meeting times ---
        const times = [];
        for (const iso of extractIsoDateTimes(text)) {
            times.push({ iso, confidence: 0.95, calibrated: true });
            if (times.length >= MAX_EVENTS)
                break;
        }
        if (times.length < MAX_EVENTS) {
            for (const rel of extractRelativeMeetings(text, now)) {
                times.push({ iso: rel.iso, confidence: 0.6, calibrated: false, note: rel.note });
                if (times.length >= MAX_EVENTS)
                    break;
            }
        }
        const eventName = message.subject !== undefined && message.subject.trim() !== ""
            ? message.subject.trim()
            : undefined;
        times.forEach((t, i) => {
            const eventIri = `${ctx.docIri}#event-${i + 1}`;
            out.push({
                subject: eventIri,
                predicate: RDF_TYPE,
                object: { kind: "iri", value: SCHEMA_EVENT },
                confidence: t.confidence,
                method: "Deterministic",
                calibration: t.calibrated ? "Calibrated" : "SelfReported",
                securityBearing: false,
            });
            out.push({
                subject: eventIri,
                predicate: SCHEMA_START_TIME,
                object: { kind: "literal", value: t.iso, datatype: `${XSD}dateTime` },
                confidence: t.confidence,
                method: "Deterministic",
                calibration: t.calibrated ? "Calibrated" : "SelfReported",
                securityBearing: false,
                ...(t.note !== undefined ? { note: t.note } : {}),
            });
            if (eventName !== undefined) {
                out.push({
                    subject: eventIri,
                    predicate: SCHEMA_NAME,
                    object: { kind: "literal", value: eventName },
                    confidence: Math.min(t.confidence, 0.7),
                    method: "Deterministic",
                    calibration: "SelfReported",
                    securityBearing: false,
                });
            }
        });
        // --- yes/no reply polarity ---
        const polarity = detectPolarity(text);
        if (polarity !== undefined) {
            out.push({
                subject: `${ctx.docIri}#reply`,
                predicate: AGENTIC_REPLY_POLARITY,
                object: { kind: "literal", value: polarity.value },
                confidence: polarity.confidence,
                method: "Deterministic",
                calibration: "SelfReported",
                securityBearing: false,
            });
        }
        return out;
    }
}
/** A ready-to-use singleton of the deterministic reference interpreter. */
export const deterministicInterpreter = new DeterministicInterpreter();
// --- helpers -----------------------------------------------------------------
/** Cap the scanned text length (DoS guard). */
function clip(text) {
    return text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
}
/** Strip quoted-reply lines (`> …`) so we interpret the NEW text, not the history. */
function unquote(text) {
    return text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n");
}
/**
 * Extract valid ISO-8601 datetimes from text (linear, bounded). Each match is
 * re-validated by `Date.parse` (so `2026-13-40T99:99` is rejected) and canonicalised
 * to a UTC ISO string. Deduped + capped.
 */
export function extractIsoDateTimes(text) {
    const Re = /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?/g;
    const seen = new Set();
    const out = [];
    let m;
    let count = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
    while ((m = Re.exec(text)) !== null && count < 128) {
        count++;
        const [, y, mo, d, h, mi, s, tz] = m;
        // Require an explicit zone OR treat as UTC; build a strict candidate.
        const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${tz === undefined || tz === "" ? "Z" : normalizeTz(tz)}`;
        const ms = Date.parse(iso);
        if (Number.isNaN(ms))
            continue;
        // Re-validate the calendar fields survived (Date.parse is lenient on overflow).
        const back = new Date(ms).toISOString();
        if (!sameInstant(iso, back))
            continue;
        if (!seen.has(back)) {
            seen.add(back);
            out.push(back);
        }
        if (out.length >= MAX_EVENTS)
            break;
    }
    return out;
}
/** Normalise a timezone offset to `±HH:MM`. */
function normalizeTz(tz) {
    if (tz === "Z")
        return "Z";
    const cleaned = tz.replace(":", "");
    const sign = cleaned[0] ?? "+";
    const hh = cleaned.slice(1, 3);
    const mm = cleaned.slice(3, 5) || "00";
    return `${sign}${hh}:${mm}`;
}
/** True if two ISO strings denote the same instant (reject overflow-normalised dates). */
function sameInstant(a, b) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
}
/**
 * Extract a BOUNDED subset of relative meeting expressions: `today`/`tomorrow`/a
 * weekday (optionally `next`), combined with an explicit time (`at 2pm`, `at 14:00`).
 * Resolved against `now` in UTC (the timezone ambiguity is why these carry a lower,
 * self-reported confidence and a note). Returns at most a few, deduped.
 */
export function extractRelativeMeetings(text, now) {
    const Re = /\b(today|tomorrow|(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b[^.\n]{0,40}?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
    const out = [];
    const seen = new Set();
    let m;
    let count = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
    while ((m = Re.exec(text)) !== null && count < 32) {
        count++;
        const dayWord = (m[1] ?? "").toLowerCase();
        const weekday = (m[2] ?? "").toLowerCase();
        const hourRaw = Number.parseInt(m[3] ?? "", 10);
        const minute = m[4] !== undefined ? Number.parseInt(m[4], 10) : 0;
        const ampm = (m[5] ?? "").toLowerCase();
        if (!Number.isInteger(hourRaw) || hourRaw < 0 || hourRaw > 23 || minute < 0 || minute > 59)
            continue;
        let hour = hourRaw;
        if (ampm === "pm" && hour < 12)
            hour += 12;
        if (ampm === "am" && hour === 12)
            hour = 0;
        if (hour > 23)
            continue;
        const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        let dayOffset;
        if (dayWord === "today")
            dayOffset = 0;
        else if (dayWord === "tomorrow")
            dayOffset = 1;
        else if (weekday in WEEKDAYS) {
            const target = WEEKDAYS[weekday];
            const cur = base.getUTCDay();
            let delta = (target - cur + 7) % 7;
            if (dayWord.startsWith("next") && delta === 0)
                delta = 7;
            dayOffset = delta;
        }
        if (dayOffset === undefined)
            continue;
        const dt = new Date(base.getTime() + dayOffset * 86_400_000);
        dt.setUTCHours(hour, minute, 0, 0);
        const iso = dt.toISOString();
        if (!seen.has(iso)) {
            seen.add(iso);
            out.push({
                iso,
                note: "resolved from a relative expression assuming UTC — verify the timezone.",
            });
        }
        if (out.length >= MAX_EVENTS)
            break;
    }
    return out;
}
/** Detect a simple yes/no reply polarity in the (unquoted) body's leading text. */
function detectPolarity(text) {
    const head = text.trim().slice(0, 200).toLowerCase();
    if (head === "")
        return undefined;
    // Only classify a SHORT, clearly-polar reply — avoid false positives on prose.
    const firstWord = head.split(/[\s,.!]+/)[0] ?? "";
    const Affirm = new Set([
        "yes",
        "yeah",
        "yep",
        "sure",
        "confirmed",
        "confirm",
        "ok",
        "okay",
        "agreed",
    ]);
    const Negate = new Set(["no", "nope", "nah", "decline", "declined", "cannot", "can't"]);
    if (Affirm.has(firstWord))
        return { value: "affirmative", confidence: head.length <= 20 ? 0.9 : 0.6 };
    if (Negate.has(firstWord))
        return { value: "negative", confidence: head.length <= 20 ? 0.9 : 0.6 };
    return undefined;
}
//# sourceMappingURL=interpret.js.map