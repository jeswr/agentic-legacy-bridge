// AUTHORED-BY Claude Opus 4.8
/**
 * The live-LLM {@link Interpreter} adapter (M2-DESIGN.md §2) — the PROMPT-INJECTION
 * surface of the bridge. The message body is UNTRUSTED and the model is STEERABLE;
 * the design constraint is therefore that a *fully-steered* model must be HARMLESS.
 * Containment is STRUCTURAL, not prompt-based — four layers, none of which is the
 * prompt:
 *
 *  1. **Capability starvation.** The extractor ({@link LlmExtractor}) is a PURE
 *     `text → JSON` function: no tools, no `fetch`, no pod handle, no reply path. A
 *     fully-injected model can emit only *false candidate data* — precisely the
 *     artefact the M1 reliability gate ({@link classifyReliability}) quarantines.
 *     Nothing the model emits is transmitted anywhere: it becomes reified pod-local
 *     RDF in the owner's OWN pod, or is dropped. Exfiltration is impossible from
 *     inside the seam.
 *  2. **Slot-based output.** The model NEVER emits IRIs, predicates, or graph
 *     structure — only SLOT VALUES against a closed per-task schema
 *     (`additionalProperties: false`, enum/number/length-capped slots). The ADAPTER
 *     (not the model) mints every subject, chooses every predicate from a per-task
 *     allowlist, and builds every literal through M1's already-validating
 *     {@link addInterpretation}. A model emitting `"grant alice control"` has no
 *     slot to put it in; unknown keys / malformed JSON / over-cap arrays /
 *     non-parsing dates DROP the whole task result (reject-don't-repair).
 *  3. **Reliability-ineligibility by construction.** Every datum is
 *     `method: "LlmInterpretation"` + `calibration: "SelfReported"` UNLESS a
 *     DETERMINISTIC cross-check upgrades it (§2.3). A raw self-reported LLM datum can
 *     never `auto`-materialise at any confidence — M1's gate requires
 *     `Calibrated`/`Verified`. `securityBearing` is assigned by the ADAPTER from the
 *     task class, NEVER read from model output.
 *  4. **Fail-closed.** Model failure/timeout → ZERO interpretations + a warning (the
 *     message is never lost, the batch never aborts). Low confidence → written
 *     reified + `audit`-classed downstream, NEVER silently asserted. Malformed output
 *     → dropped, never crashes.
 *
 * The `Interpreter` seam is inherently ASYNC here (an LLM call is async), so this
 * adapter implements {@link AsyncInterpreter} — the async counterpart of M1's
 * synchronous {@link Interpreter}. The reliability model (per-datum confidence +
 * calibration provenance) is IDENTICAL to the deterministic path; only the METHOD
 * and the calibration derivation differ.
 */
import { extractIsoDateTimes, extractRelativeMeetings, } from "./interpret.js";
import { asBridgeMessage } from "./message.js";
import { clampConfidence, } from "./reliability.js";
import { AGENTIC_REPLY_POLARITY, RDF_TYPE, SCHEMA, SCHEMA_EVENT, SCHEMA_NAME, SCHEMA_START_TIME, XSD_DATE_TIME, } from "./vocab.js";
// --- caps (a pathological body / model can never blow these) -----------------
const MAX_SCAN_CHARS = 100_000;
const MAX_ITEMS = 16;
/** reply-polarity is one-per-message in practice — its closed schema caps at a few. */
const MAX_POLARITY_ITEMS = 4;
const MAX_SPAN_CHARS = 400;
const MIN_SPAN_NORMALIZED = 3;
const MAX_NAME_CHARS = 200;
const MAX_DESC_CHARS = 300;
const MAX_ISO_CHARS = 64;
/** The confidence floor an un-sourced ("cannot quote the sender") datum lands at → `audit`. */
const AUDIT_FLOOR = 0.3;
/** A span-verified but not-independently-re-derivable datum caps here (still `SelfReported`). */
const SPAN_ONLY_CAP = 0.7;
/** A span-verified AND deterministically re-derivable datum caps here (`Calibrated`). */
const REDERIVED_CAP = 0.95;
/** How far a proposed meeting time may lie from `now` before it is treated as un-calibrated. */
const SANE_PAST_YEARS = 2;
const SANE_FUTURE_YEARS = 5;
// --- generic fail-closed slot helpers ----------------------------------------
/** `hasOwnProperty`, prototype-pollution-safe (a JSON `__proto__` key is an OWN prop). */
function own(obj, key) {
    return Object.hasOwn(obj, key) ? obj[key] : undefined;
}
/**
 * Coerce raw extractor output to a plain object with EXACTLY one `items` array, or a
 * structural failure. A string is JSON-parsed (fail-closed on a parse error); any
 * unknown top-level key, a non-array `items`, or an over-cap array is a whole-task
 * drop (never partially salvaged).
 */
function asItemsArray(raw, reason, maxItems) {
    let value = raw;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return { ok: false, reason: `${reason}: malformed JSON` };
        }
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: `${reason}: expected an object with an "items" array` };
    }
    for (const key of Object.keys(value)) {
        if (key !== "items")
            return { ok: false, reason: `${reason}: unexpected top-level key "${key}"` };
    }
    const items = own(value, "items");
    if (!Array.isArray(items))
        return { ok: false, reason: `${reason}: "items" is not an array` };
    // Enforce the task's OWN closed-schema `maxItems` (not a shared cap) so an output
    // that violates the declared schema is a whole-task drop, never accepted.
    if (items.length > maxItems)
        return { ok: false, reason: `${reason}: over the ${maxItems}-item cap` };
    return { ok: true, items };
}
/** True iff `obj` is a plain object whose OWN keys are all within `allowed`. */
function onlyKeys(obj, allowed) {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj))
        return false;
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key))
            return false;
    }
    return true;
}
function finiteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}
function cappedString(v, max) {
    return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}
/** Canonicalise an untrusted datetime string to a UTC ISO instant, or `undefined`. */
function canonicalIso(v) {
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_ISO_CHARS)
        return undefined;
    const ms = Date.parse(v);
    if (Number.isNaN(ms))
        return undefined;
    return new Date(ms).toISOString();
}
/** Collapse internal whitespace + lower-case, for a robust verbatim-span comparison. */
function normalizeForMatch(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}
/**
 * The single highest-value hardening (§2.3 rung b): does the model's claimed
 * `sourceSpan` VERBATIM appear in the sender's own body? A too-short span cannot
 * match (it would match anything). An injected "assert X" that cannot point at the
 * sender's words fails here and is floored to `audit`.
 */
function spanAppears(span, body) {
    const s = normalizeForMatch(span);
    if (s.length < MIN_SPAN_NORMALIZED)
        return false;
    return normalizeForMatch(body).includes(s);
}
function withinSaneWindow(iso, now) {
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return false;
    const lo = Date.UTC(now.getUTCFullYear() - SANE_PAST_YEARS, 0, 1);
    const hi = Date.UTC(now.getUTCFullYear() + SANE_FUTURE_YEARS, 11, 31, 23, 59, 59);
    return t >= lo && t <= hi;
}
/**
 * The ceiling applied to the k-sample AGREEMENT CONTRIBUTION for a calibration CLASS —
 * the maximum score agreement ALONE may synthesise for that class (the cap the
 * single-sample cross-check uses). Agreement may raise a kept item's score up to this
 * ceiling, but the deterministic base score is preserved unclamped, so agreement can
 * never push a `SelfReported` datum past {@link SPAN_ONLY_CAP} (which would be
 * laundering) nor invent a `Calibrated`-range score for one — while a legitimately-high
 * `Calibrated`/`Verified` base (a custom task may exceed {@link REDERIVED_CAP}) is never
 * LOWERED. A `Verified` datum (never produced by the default tasks) has no synthetic cap.
 */
function classScoreCeiling(calibration) {
    switch (calibration) {
        case "SelfReported":
            return SPAN_ONLY_CAP;
        case "Calibrated":
            return REDERIVED_CAP;
        default:
            return 1;
    }
}
const AFFIRM_WORDS = ["yes", "yeah", "yep", "sure", "confirm", "confirmed", "agreed", "ok", "okay"];
const NEGATE_WORDS = ["no", "nope", "nah", "decline", "declined", "cannot", "can't", "won't"];
// --- the three default tasks (M2-DESIGN.md §5 M2.3 first set) -----------------
const SCHEMA_ACTION = `${SCHEMA}Action`;
const CONFIDENCE_SLOT = { type: "number", minimum: 0, maximum: 1 };
const SPAN_SLOT = {
    type: "string",
    maxLength: MAX_SPAN_CHARS,
    description: "a VERBATIM quote from the message that supports this item",
};
/** Task: proposed MEETING times. Slots → `schema:Event` + `schema:startTime` (+ `schema:name`). */
export const meetingTimesTask = {
    id: "meeting-times",
    securityBearing: false,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
            items: {
                type: "array",
                maxItems: MAX_ITEMS,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["startTime", "confidence", "sourceSpan"],
                    properties: {
                        startTime: { type: "string", description: "ISO-8601 datetime" },
                        name: { type: "string", maxLength: MAX_NAME_CHARS },
                        confidence: CONFIDENCE_SLOT,
                        sourceSpan: SPAN_SLOT,
                    },
                },
            },
        },
    },
    validate(raw) {
        const arr = asItemsArray(raw, "meeting-times", MAX_ITEMS);
        if (!arr.ok)
            return arr;
        const items = [];
        for (const it of arr.items) {
            if (!onlyKeys(it, ["startTime", "name", "confidence", "sourceSpan"]))
                return { ok: false, reason: "meeting-times: an item has an unexpected key" };
            const startTime = canonicalIso(own(it, "startTime"));
            const confidence = own(it, "confidence");
            const sourceSpan = cappedString(own(it, "sourceSpan"), MAX_SPAN_CHARS);
            if (startTime === undefined)
                return { ok: false, reason: "meeting-times: a non-parsing startTime" };
            if (!finiteNumber(confidence))
                return { ok: false, reason: "meeting-times: a non-numeric confidence" };
            if (sourceSpan === undefined)
                return { ok: false, reason: "meeting-times: a missing/over-cap sourceSpan" };
            const nameRaw = own(it, "name");
            const name = nameRaw === undefined ? undefined : cappedString(nameRaw, MAX_NAME_CHARS);
            if (nameRaw !== undefined && name === undefined)
                return { ok: false, reason: "meeting-times: an over-cap/non-string name" };
            items.push({ startTime, confidence, sourceSpan, ...(name !== undefined ? { name } : {}) });
        }
        return { ok: true, items };
    },
    signature(item) {
        return `meeting:${item.startTime}`;
    },
    calibrate(item, { body, now }) {
        if (!spanAppears(item.sourceSpan, body))
            return { score: AUDIT_FLOOR, calibration: "SelfReported" };
        if (!withinSaneWindow(item.startTime, now))
            return { score: AUDIT_FLOOR, calibration: "SelfReported" };
        const reDerived = extractIsoDateTimes(body).includes(item.startTime) ||
            extractIsoDateTimes(item.sourceSpan).includes(item.startTime) ||
            extractRelativeMeetings(item.sourceSpan, now).some((r) => r.iso === item.startTime) ||
            extractRelativeMeetings(body, now).some((r) => r.iso === item.startTime);
        return reDerived
            ? { score: REDERIVED_CAP, calibration: "Calibrated" }
            : { score: SPAN_ONLY_CAP, calibration: "SelfReported" };
    },
    lower(item, index, { docIri }) {
        const subject = `${docIri}#llm-meeting-${index}`;
        const triples = [
            { subject, predicate: RDF_TYPE, object: { kind: "iri", value: SCHEMA_EVENT } },
            {
                subject,
                predicate: SCHEMA_START_TIME,
                object: { kind: "literal", value: item.startTime, datatype: XSD_DATE_TIME },
            },
        ];
        if (item.name !== undefined) {
            // The title is free text the datetime cross-check does NOT cover — descriptive.
            triples.push({
                subject,
                predicate: SCHEMA_NAME,
                object: { kind: "literal", value: item.name },
                descriptive: true,
            });
        }
        return triples;
    },
};
/** Task: ACTION items. Slots → `schema:Action` + `schema:name` (a descriptive LITERAL, never a grant). */
export const actionItemsTask = {
    id: "action-items",
    securityBearing: false,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
            items: {
                type: "array",
                maxItems: MAX_ITEMS,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["description", "confidence", "sourceSpan"],
                    properties: {
                        description: { type: "string", maxLength: MAX_DESC_CHARS },
                        confidence: CONFIDENCE_SLOT,
                        sourceSpan: SPAN_SLOT,
                    },
                },
            },
        },
    },
    validate(raw) {
        const arr = asItemsArray(raw, "action-items", MAX_ITEMS);
        if (!arr.ok)
            return arr;
        const items = [];
        for (const it of arr.items) {
            if (!onlyKeys(it, ["description", "confidence", "sourceSpan"]))
                return { ok: false, reason: "action-items: an item has an unexpected key" };
            const description = cappedString(own(it, "description"), MAX_DESC_CHARS);
            const confidence = own(it, "confidence");
            const sourceSpan = cappedString(own(it, "sourceSpan"), MAX_SPAN_CHARS);
            if (description === undefined)
                return { ok: false, reason: "action-items: a missing/over-cap description" };
            if (!finiteNumber(confidence))
                return { ok: false, reason: "action-items: a non-numeric confidence" };
            if (sourceSpan === undefined)
                return { ok: false, reason: "action-items: a missing/over-cap sourceSpan" };
            items.push({ description, confidence, sourceSpan });
        }
        return { ok: true, items };
    },
    signature(item) {
        return `action:${normalizeForMatch(item.description)}`;
    },
    calibrate(item, { body }) {
        // Free text is NOT deterministically re-derivable → never `Calibrated` by the
        // single-sample cross-check. The span check still applies (its ONLY job here is
        // to keep an un-sourced hallucination out of the surfaced band).
        return spanAppears(item.sourceSpan, body)
            ? { score: SPAN_ONLY_CAP, calibration: "SelfReported" }
            : { score: AUDIT_FLOOR, calibration: "SelfReported" };
    },
    lower(item, index, { docIri }) {
        const subject = `${docIri}#llm-action-${index}`;
        return [
            { subject, predicate: RDF_TYPE, object: { kind: "iri", value: SCHEMA_ACTION } },
            {
                subject,
                predicate: SCHEMA_NAME,
                // The description is free text NO cross-check re-derives → descriptive, at
                // parity with meetingTimes' name: forced `SelfReported` + capped at
                // {@link SPAN_ONLY_CAP} in `lowerItems`, so a hostile action description can
                // never ride an upgraded envelope into a `Calibrated`/`auto` literal.
                object: { kind: "literal", value: item.description },
                descriptive: true,
            },
        ];
    },
};
/** Task: yes/no/neutral reply POLARITY. Slot → `agentic:replyPolarity` literal. */
export const replyPolarityTask = {
    id: "reply-polarity",
    securityBearing: false,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
            items: {
                type: "array",
                maxItems: MAX_POLARITY_ITEMS,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["polarity", "confidence", "sourceSpan"],
                    properties: {
                        polarity: { type: "string", enum: ["affirmative", "negative", "neutral"] },
                        confidence: CONFIDENCE_SLOT,
                        sourceSpan: SPAN_SLOT,
                    },
                },
            },
        },
    },
    validate(raw) {
        const arr = asItemsArray(raw, "reply-polarity", MAX_POLARITY_ITEMS);
        if (!arr.ok)
            return arr;
        const items = [];
        for (const it of arr.items) {
            if (!onlyKeys(it, ["polarity", "confidence", "sourceSpan"]))
                return { ok: false, reason: "reply-polarity: an item has an unexpected key" };
            const polarity = own(it, "polarity");
            const confidence = own(it, "confidence");
            const sourceSpan = cappedString(own(it, "sourceSpan"), MAX_SPAN_CHARS);
            if (polarity !== "affirmative" && polarity !== "negative" && polarity !== "neutral")
                return { ok: false, reason: "reply-polarity: an out-of-enum polarity" };
            if (!finiteNumber(confidence))
                return { ok: false, reason: "reply-polarity: a non-numeric confidence" };
            if (sourceSpan === undefined)
                return { ok: false, reason: "reply-polarity: a missing/over-cap sourceSpan" };
            items.push({ polarity, confidence, sourceSpan });
        }
        return { ok: true, items };
    },
    signature(item) {
        return `polarity:${item.polarity}`;
    },
    calibrate(item, { body }) {
        if (!spanAppears(item.sourceSpan, body))
            return { score: AUDIT_FLOOR, calibration: "SelfReported" };
        const span = normalizeForMatch(item.sourceSpan);
        const words = item.polarity === "affirmative"
            ? AFFIRM_WORDS
            : item.polarity === "negative"
                ? NEGATE_WORDS
                : [];
        const wordMatch = words.some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(span));
        return wordMatch
            ? { score: 0.9, calibration: "Calibrated" }
            : { score: SPAN_ONLY_CAP, calibration: "SelfReported" };
    },
    lower(item, index, { docIri }) {
        return [
            {
                subject: `${docIri}#llm-reply-${index}`,
                predicate: AGENTIC_REPLY_POLARITY,
                object: { kind: "literal", value: item.polarity },
            },
        ];
    },
};
/** The default extraction-task registry (M2.3 first set). Callers may supply their own. */
export const DEFAULT_TASKS = Object.freeze([
    meetingTimesTask,
    actionItemsTask,
    replyPolarityTask,
]);
/**
 * The live-LLM interpreter — an {@link AsyncInterpreter} whose output is confined to
 * validated slot values with an adapter-assigned reliability envelope. See the module
 * docstring for the four containment layers.
 */
export class LlmInterpreter {
    extractor;
    model;
    tasks;
    kSamples;
    kThreshold;
    timeoutMs;
    onWarning;
    constructor(options) {
        if (typeof options.extractor !== "function") {
            throw new TypeError("LlmInterpreter: an `extractor` function is required");
        }
        this.extractor = options.extractor;
        this.model = options.model ?? "llm:unspecified";
        this.tasks = options.tasks ?? DEFAULT_TASKS;
        this.kSamples =
            Number.isInteger(options.kSamples) && options.kSamples > 1
                ? options.kSamples
                : 1;
        this.kThreshold =
            options.kAgreementThreshold !== undefined &&
                options.kAgreementThreshold > 0 &&
                options.kAgreementThreshold <= 1
                ? options.kAgreementThreshold
                : 0.66;
        this.timeoutMs =
            options.perTaskTimeoutMs !== undefined && options.perTaskTimeoutMs > 0
                ? options.perTaskTimeoutMs
                : 30_000;
        this.onWarning = options.onWarning;
    }
    /** The {@link AsyncInterpreter} contract — interpretations only (warnings go to `onWarning`). */
    async interpret(message, ctx) {
        const { interpretations } = await this.interpretDetailed(message, ctx);
        return interpretations;
    }
    /** Interpret and ALSO return the fail-closed warnings (a task that produced nothing). */
    async interpretDetailed(message, ctx) {
        const bridge = asBridgeMessage(message);
        const now = ctx.now ?? new Date();
        // Clip FIRST so `unquote` never splits/filters an unbounded body in memory (the
        // MAX_SCAN_CHARS scan cap must bound the work, not just the final string).
        const text = unquote(clip(bridge.textBody));
        const warnings = [];
        // Each task is INDEPENDENT + fail-closed: one task failing never rejects the
        // batch and never loses the message (the deterministic pass + the raw anchor are
        // written by the caller regardless). Tasks run concurrently for latency.
        const perTask = await Promise.all(this.tasks.map((task) => this.runTask(task, text, now, ctx.docIri, warnings)));
        const interpretations = perTask.flat();
        for (const w of warnings)
            this.onWarning?.(w);
        return { interpretations, warnings };
    }
    /** Run ONE task fail-closed → its interpretations (or `[]` + a warning). */
    async runTask(task, text, now, docIri, warnings) {
        const nowIso = now.toISOString();
        try {
            if (this.kSamples > 1) {
                return await this.runTaskKSample(task, text, now, nowIso, docIri, warnings);
            }
            const raw = await this.callExtractor(task, text, nowIso);
            const validated = task.validate(raw);
            if (!validated.ok) {
                warnings.push(validated.reason);
                return [];
            }
            return this.lowerItems(task, validated.items, docIri, (item) => task.calibrate(item, { body: text, now }));
        }
        catch (err) {
            warnings.push(`${task.id}: extractor failed (${errText(err)}) — no interpretations`);
            return [];
        }
    }
    /** The opt-in k-sample path (§2.3 rung c). */
    async runTaskKSample(task, text, now, nowIso, docIri, warnings) {
        const runs = [];
        for (let i = 0; i < this.kSamples; i++) {
            const raw = await this.callExtractor(task, text, nowIso);
            const v = task.validate(raw);
            if (v.ok)
                runs.push(v.items);
        }
        if (runs.length === 0) {
            warnings.push(`${task.id}: no valid k-sample run — no interpretations`);
            return [];
        }
        const denom = runs.length;
        // Aggregate agreement over ALL valid runs (not just the first): count the DISTINCT
        // runs each signature appears in, keeping the FIRST item seen as the representative.
        // A signature present in enough LATER runs still qualifies even if run 0 missed it.
        const runCount = new Map();
        const representative = new Map();
        for (const run of runs) {
            const seenInRun = new Set();
            for (const item of run) {
                const sig = task.signature(item);
                if (!representative.has(sig))
                    representative.set(sig, item);
                if (!seenInRun.has(sig)) {
                    seenInRun.add(sig);
                    runCount.set(sig, (runCount.get(sig) ?? 0) + 1);
                }
            }
        }
        const kept = [];
        const agreement = new Map();
        for (const [sig, count] of runCount) {
            const ratio = count / denom;
            if (ratio >= this.kThreshold) {
                const item = representative.get(sig);
                kept.push(item);
                agreement.set(item, ratio);
            }
        }
        if (kept.length === 0) {
            warnings.push(`${task.id}: no item cleared the k-sample agreement threshold — no interpretations`);
            return [];
        }
        return this.lowerItems(task, kept, docIri, (item) => {
            // The per-task deterministic cross-check is AUTHORITATIVE for the calibration
            // CLASS. k-sample agreement is only an independent-repetition signal on the
            // SCORE — it must NEVER promote the class the cross-check earned. Otherwise a
            // hostile message could launder its own free-text (a `SelfReported`
            // action-item description) into `Calibrated`/`auto` merely by the extractor
            // repeating it — which at temperature 0 it does with perfect "agreement".
            const base = task.calibrate(item, { body: text, now });
            // The span floor is NEVER bypassable by agreement: an un-sourced item stays
            // `audit` even if every sample agreed on the hallucination.
            if (base.score <= AUDIT_FLOOR)
                return base;
            const ratio = agreement.get(item) ?? 0;
            // Agreement may raise the score toward `ratio`, but never BELOW the deterministic
            // score. Clamp ONLY the agreement CONTRIBUTION to the class ceiling (never the
            // deterministic base itself), so a `SelfReported` datum can never be pushed past
            // {@link SPAN_ONLY_CAP} (laundering) while a legitimately-high `Calibrated` base
            // (a custom task may exceed {@link REDERIVED_CAP}) is preserved, never lowered.
            // The calibration CLASS is preserved verbatim — agreement raises score in-class.
            const ceiling = classScoreCeiling(base.calibration);
            const score = Math.max(base.score, Math.min(ratio, ceiling));
            return { score, calibration: base.calibration };
        });
    }
    /** Lower validated items → interpretations, wrapping each with the ADAPTER-assigned envelope. */
    lowerItems(task, items, docIri, calibrateItem) {
        const out = [];
        items.forEach((item, i) => {
            const { score, calibration } = calibrateItem(item);
            const self = clampConfidence(item.confidence);
            const confidence = clampConfidence(Math.min(self, score));
            for (const triple of task.lower(item, i + 1, { docIri })) {
                // A DESCRIPTIVE slot is not covered by the item cross-check → forced
                // SelfReported + capped, so a re-derived datetime cannot launder an
                // attacker-supplied title into a Calibrated/auto literal.
                const tripleCalibration = triple.descriptive === true ? "SelfReported" : calibration;
                const tripleConfidence = triple.descriptive === true
                    ? clampConfidence(Math.min(confidence, SPAN_ONLY_CAP))
                    : confidence;
                out.push({
                    subject: triple.subject,
                    predicate: triple.predicate,
                    object: triple.object,
                    confidence: tripleConfidence,
                    method: "LlmInterpretation",
                    // securityBearing comes from the TASK CLASS — never from model output.
                    securityBearing: task.securityBearing,
                    calibration: tripleCalibration,
                    model: this.model,
                    extractionTask: task.id,
                });
            }
        });
        return out;
    }
    /** Call the extractor with a defence-in-depth timeout (a hang fails the task closed). */
    callExtractor(task, text, nowIso) {
        const call = Promise.resolve().then(() => this.extractor({ task: task.id, schema: task.schema, text, now: nowIso }));
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        });
        return Promise.race([call, timeout]).finally(() => {
            if (timer !== undefined)
                clearTimeout(timer);
        });
    }
}
// --- test/demo helper --------------------------------------------------------
/**
 * A deterministic scripted {@link LlmExtractor} for hermetic tests + demos — returns
 * the pre-supplied output for each task id (a function per task, or a static value),
 * with no network. Production injects a real extractor (see `./interpret-llm-http`).
 */
export function scriptedExtractor(script) {
    return async ({ task, text }) => {
        const entry = Object.hasOwn(script, task) ? script[task] : undefined;
        return typeof entry === "function" ? entry(text) : entry;
    };
}
// --- private helpers (mirroring interpret.ts's clip/unquote — kept local so the
//     LLM adapter adds no coupling to M1 internals) ---------------------------
function clip(text) {
    return text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
}
function unquote(text) {
    return text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n");
}
function errText(err) {
    if (err instanceof Error)
        return err.name === "Error" ? err.message : `${err.name}: ${err.message}`;
    return "unknown error";
}
//# sourceMappingURL=interpret-llm.js.map