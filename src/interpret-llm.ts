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

import type { EmailMessage } from "./email/types.js";
import {
  extractIsoDateTimes,
  extractRelativeMeetings,
  type InterpretContext,
} from "./interpret.js";
import { asBridgeMessage, type BridgeMessage } from "./message.js";
import {
  type Calibration,
  clampConfidence,
  type Interpretation,
  type InterpretationObject,
} from "./reliability.js";
import {
  AGENTIC_REPLY_POLARITY,
  RDF_TYPE,
  SCHEMA,
  SCHEMA_EVENT,
  SCHEMA_NAME,
  SCHEMA_START_TIME,
  XSD_DATE_TIME,
} from "./vocab.js";

// --- the injectable extractor seam (kept hermetic — no live network in this build) -
/**
 * The injectable LLM extractor — a PURE `text → JSON` function (capability
 * starvation, layer 1). Given a fixed task id + the closed slot schema + the
 * untrusted body (as DATA, clearly delimited by the caller) + an ISO `now`, it
 * returns the model's RAW output (validated fail-closed by the adapter — the return
 * type is deliberately `unknown`). The owner injects their own endpoint; a hardened
 * reference over a chat-completions endpoint ships in `./interpret-llm-http`
 * ({@link import("./interpret-llm-http.js").createHttpLlmExtractor}), and tests
 * inject a scripted fake ({@link scriptedExtractor}). The extractor is NEVER given a
 * tool, a pod handle, or a reply path.
 */
export type LlmExtractor = (input: {
  /** The fixed task id, e.g. `"meeting-times"`. */
  readonly task: string;
  /** The JSON schema of the SLOTS for this task (a closed schema). */
  readonly schema: object;
  /** The untrusted, clipped+unquoted body — DATA, never instructions. */
  readonly text: string;
  /** ISO `now`, for relative-date resolution. */
  readonly now: string;
}) => Promise<unknown>;

// --- the async Interpreter counterpart ---------------------------------------
/**
 * The ASYNC counterpart of M1's synchronous {@link Interpreter} — an LLM call is
 * inherently async, so the live adapter cannot satisfy the synchronous seam
 * verbatim. The reliability envelope (per-datum {@link Interpretation}) is identical.
 */
export interface AsyncInterpreter {
  interpret(
    message: BridgeMessage | EmailMessage,
    ctx: InterpretContext,
  ): Promise<Interpretation[]>;
}

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

// --- slot item shapes (the VALIDATED output of a task, all attacker-derived) --
interface MeetingItem {
  readonly startTime: string; // canonical ISO (validated)
  readonly name?: string;
  readonly confidence: number;
  readonly sourceSpan: string;
}
interface ActionItem {
  readonly description: string;
  readonly confidence: number;
  readonly sourceSpan: string;
}
interface PolarityItem {
  readonly polarity: "affirmative" | "negative" | "neutral";
  readonly confidence: number;
  readonly sourceSpan: string;
}

/** A single reified statement TEMPLATE a task mints from a slot — no reliability envelope. */
interface SlotTriple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: InterpretationObject;
  /**
   * A DESCRIPTIVE (free-text) slot that the item's cross-check does NOT cover — e.g. a
   * meeting `name` when only the datetime is re-derivable. Such a triple is forced to
   * `SelfReported` + capped at {@link SPAN_ONLY_CAP} so a re-derived datetime never
   * launders an attacker-supplied title into a `Calibrated`/`auto` literal (this is the
   * deterministic reference's own treatment of the event name).
   */
  readonly descriptive?: boolean;
}

/** The result of a task's fail-closed structural validation: items, or drop-the-whole-task. */
type ValidationResult<I> =
  | { readonly ok: true; readonly items: I[] }
  | { readonly ok: false; readonly reason: string };

/**
 * One extraction TASK: a closed slot schema + a fail-closed validator + a per-slot
 * lowering to reified triples + a deterministic calibration cross-check + a k-sample
 * signature. The `securityBearing` flag is a property of the TASK CLASS (assigned
 * here, NEVER read from model output) — a grant/pay/sign/share/delete-adjacent task
 * is born `securityBearing: true` and its output is permanently human-confirm.
 */
export interface ExtractionTask<I = unknown> {
  /** The fixed task id (also written as `dct:description` on the activity). */
  readonly id: string;
  /** The closed JSON slot schema handed to the model (a hint only — never trusted). */
  readonly schema: object;
  /** Task-class security bearing — assigned by the adapter, never by the model. */
  readonly securityBearing: boolean;
  /** Structural, fail-closed validation of the raw model output. */
  validate(raw: unknown): ValidationResult<I>;
  /** A stable per-item signature for k-sample agreement. */
  signature(item: I): string;
  /** The deterministic single-sample cross-check → confidence score + calibration. */
  calibrate(
    item: I,
    ctx: { readonly body: string; readonly now: Date },
  ): {
    readonly score: number;
    readonly calibration: Calibration;
  };
  /** Mint the reified statement TEMPLATE(s) for one item (adapter mints all IRIs). */
  lower(item: I, index: number, ctx: { readonly docIri: string }): SlotTriple[];
}

// --- generic fail-closed slot helpers ----------------------------------------
/** `hasOwnProperty`, prototype-pollution-safe (a JSON `__proto__` key is an OWN prop). */
function own(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Coerce raw extractor output to a plain object with EXACTLY one `items` array, or a
 * structural failure. A string is JSON-parsed (fail-closed on a parse error); any
 * unknown top-level key, a non-array `items`, or an over-cap array is a whole-task
 * drop (never partially salvaged).
 */
function asItemsArray(
  raw: unknown,
  reason: string,
  maxItems: number,
): { ok: true; items: unknown[] } | { ok: false; reason: string } {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
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
  if (!Array.isArray(items)) return { ok: false, reason: `${reason}: "items" is not an array` };
  // Enforce the task's OWN closed-schema `maxItems` (not a shared cap) so an output
  // that violates the declared schema is a whole-task drop, never accepted.
  if (items.length > maxItems)
    return { ok: false, reason: `${reason}: over the ${maxItems}-item cap` };
  return { ok: true, items };
}

/** True iff `obj` is a plain object whose OWN keys are all within `allowed`. */
function onlyKeys(obj: unknown, allowed: readonly string[]): obj is object {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function cappedString(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Canonicalise an untrusted datetime string to a UTC ISO instant, or `undefined`. */
function canonicalIso(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ISO_CHARS) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Collapse internal whitespace + lower-case, for a robust verbatim-span comparison. */
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The single highest-value hardening (§2.3 rung b): does the model's claimed
 * `sourceSpan` VERBATIM appear in the sender's own body? A too-short span cannot
 * match (it would match anything). An injected "assert X" that cannot point at the
 * sender's words fails here and is floored to `audit`.
 */
function spanAppears(span: string, body: string): boolean {
  const s = normalizeForMatch(span);
  if (s.length < MIN_SPAN_NORMALIZED) return false;
  return normalizeForMatch(body).includes(s);
}

function withinSaneWindow(iso: string, now: Date): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
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
function classScoreCeiling(calibration: Calibration): number {
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

const CONFIDENCE_SLOT = { type: "number", minimum: 0, maximum: 1 } as const;
const SPAN_SLOT = {
  type: "string",
  maxLength: MAX_SPAN_CHARS,
  description: "a VERBATIM quote from the message that supports this item",
} as const;

/** Task: proposed MEETING times. Slots → `schema:Event` + `schema:startTime` (+ `schema:name`). */
export const meetingTimesTask: ExtractionTask<MeetingItem> = {
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
  validate(raw): ValidationResult<MeetingItem> {
    const arr = asItemsArray(raw, "meeting-times", MAX_ITEMS);
    if (!arr.ok) return arr;
    const items: MeetingItem[] = [];
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
    const reDerived =
      extractIsoDateTimes(body).includes(item.startTime) ||
      extractIsoDateTimes(item.sourceSpan).includes(item.startTime) ||
      extractRelativeMeetings(item.sourceSpan, now).some((r) => r.iso === item.startTime) ||
      extractRelativeMeetings(body, now).some((r) => r.iso === item.startTime);
    return reDerived
      ? { score: REDERIVED_CAP, calibration: "Calibrated" }
      : { score: SPAN_ONLY_CAP, calibration: "SelfReported" };
  },
  lower(item, index, { docIri }) {
    const subject = `${docIri}#llm-meeting-${index}`;
    const triples: SlotTriple[] = [
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
export const actionItemsTask: ExtractionTask<ActionItem> = {
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
  validate(raw): ValidationResult<ActionItem> {
    const arr = asItemsArray(raw, "action-items", MAX_ITEMS);
    if (!arr.ok) return arr;
    const items: ActionItem[] = [];
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
export const replyPolarityTask: ExtractionTask<PolarityItem> = {
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
  validate(raw): ValidationResult<PolarityItem> {
    const arr = asItemsArray(raw, "reply-polarity", MAX_POLARITY_ITEMS);
    if (!arr.ok) return arr;
    const items: PolarityItem[] = [];
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
    const words =
      item.polarity === "affirmative"
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
export const DEFAULT_TASKS: readonly ExtractionTask[] = Object.freeze([
  meetingTimesTask as ExtractionTask,
  actionItemsTask as ExtractionTask,
  replyPolarityTask as ExtractionTask,
]);

// --- the LlmInterpreter ------------------------------------------------------
/** Options for {@link LlmInterpreter}. */
export interface LlmInterpreterOptions {
  /** The injected extractor seam (a fake in tests; the hardened HTTP client in prod). */
  readonly extractor: LlmExtractor;
  /** The opaque model tag written as `agentic:model` on every activity. Default `"llm:unspecified"`. */
  readonly model?: string;
  /** The extraction-task registry. Default {@link DEFAULT_TASKS}. */
  readonly tasks?: readonly ExtractionTask[];
  /**
   * Opt-in k-sample agreement (§2.3 rung c): run the extractor `kSamples` times per
   * task and keep only items whose cross-run agreement ≥ {@link kAgreementThreshold}.
   * Agreement raises a kept item's SCORE within the calibration class its per-task
   * deterministic cross-check earned — it NEVER promotes the class (a `SelfReported`
   * free-text datum stays `SelfReported` however many samples agree; only a datum the
   * cross-check already made `Calibrated` stays `Calibrated`). Default `1` (off).
   */
  readonly kSamples?: number;
  /** The k-sample agreement threshold in (0,1]. Default `0.66`. */
  readonly kAgreementThreshold?: number;
  /** A per-task defence-in-depth timeout (ms). A slow extractor fails the task closed. Default `30_000`. */
  readonly perTaskTimeoutMs?: number;
  /** Warnings sink (a failed/dropped task calls this). `interpret` also returns them via `interpretDetailed`. */
  readonly onWarning?: (warning: string) => void;
}

/** The richer result of {@link LlmInterpreter.interpretDetailed}. */
export interface LlmInterpretResult {
  readonly interpretations: Interpretation[];
  /** One entry per task that produced nothing because it failed/timed-out/was-dropped. */
  readonly warnings: string[];
}

/**
 * The live-LLM interpreter — an {@link AsyncInterpreter} whose output is confined to
 * validated slot values with an adapter-assigned reliability envelope. See the module
 * docstring for the four containment layers.
 */
export class LlmInterpreter implements AsyncInterpreter {
  private readonly extractor: LlmExtractor;
  private readonly model: string;
  private readonly tasks: readonly ExtractionTask[];
  private readonly kSamples: number;
  private readonly kThreshold: number;
  private readonly timeoutMs: number;
  private readonly onWarning: ((warning: string) => void) | undefined;

  constructor(options: LlmInterpreterOptions) {
    if (typeof options.extractor !== "function") {
      throw new TypeError("LlmInterpreter: an `extractor` function is required");
    }
    this.extractor = options.extractor;
    this.model = options.model ?? "llm:unspecified";
    this.tasks = options.tasks ?? DEFAULT_TASKS;
    this.kSamples =
      Number.isInteger(options.kSamples) && (options.kSamples as number) > 1
        ? (options.kSamples as number)
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
  async interpret(
    message: BridgeMessage | EmailMessage,
    ctx: InterpretContext,
  ): Promise<Interpretation[]> {
    const { interpretations } = await this.interpretDetailed(message, ctx);
    return interpretations;
  }

  /** Interpret and ALSO return the fail-closed warnings (a task that produced nothing). */
  async interpretDetailed(
    message: BridgeMessage | EmailMessage,
    ctx: InterpretContext,
  ): Promise<LlmInterpretResult> {
    const bridge = asBridgeMessage(message);
    const now = ctx.now ?? new Date();
    // Clip FIRST so `unquote` never splits/filters an unbounded body in memory (the
    // MAX_SCAN_CHARS scan cap must bound the work, not just the final string).
    const text = unquote(clip(bridge.textBody));
    const warnings: string[] = [];

    // Each task is INDEPENDENT + fail-closed: one task failing never rejects the
    // batch and never loses the message (the deterministic pass + the raw anchor are
    // written by the caller regardless). Tasks run concurrently for latency.
    const perTask = await Promise.all(
      this.tasks.map((task) => this.runTask(task, text, now, ctx.docIri, warnings)),
    );
    const interpretations = perTask.flat();
    for (const w of warnings) this.onWarning?.(w);
    return { interpretations, warnings };
  }

  /** Run ONE task fail-closed → its interpretations (or `[]` + a warning). */
  private async runTask(
    task: ExtractionTask,
    text: string,
    now: Date,
    docIri: string,
    warnings: string[],
  ): Promise<Interpretation[]> {
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
      return this.lowerItems(task, validated.items, docIri, (item) =>
        task.calibrate(item, { body: text, now }),
      );
    } catch (err) {
      warnings.push(`${task.id}: extractor failed (${errText(err)}) — no interpretations`);
      return [];
    }
  }

  /** The opt-in k-sample path (§2.3 rung c). */
  private async runTaskKSample(
    task: ExtractionTask,
    text: string,
    now: Date,
    nowIso: string,
    docIri: string,
    warnings: string[],
  ): Promise<Interpretation[]> {
    const runs: unknown[][] = [];
    for (let i = 0; i < this.kSamples; i++) {
      const raw = await this.callExtractor(task, text, nowIso);
      const v = task.validate(raw);
      if (v.ok) runs.push(v.items);
    }
    if (runs.length === 0) {
      warnings.push(`${task.id}: no valid k-sample run — no interpretations`);
      return [];
    }
    const denom = runs.length;
    // Aggregate agreement over ALL valid runs (not just the first): count the DISTINCT
    // runs each signature appears in, keeping the FIRST item seen as the representative.
    // A signature present in enough LATER runs still qualifies even if run 0 missed it.
    const runCount = new Map<string, number>();
    const representative = new Map<string, unknown>();
    for (const run of runs) {
      const seenInRun = new Set<string>();
      for (const item of run) {
        const sig = task.signature(item);
        if (!representative.has(sig)) representative.set(sig, item);
        if (!seenInRun.has(sig)) {
          seenInRun.add(sig);
          runCount.set(sig, (runCount.get(sig) ?? 0) + 1);
        }
      }
    }
    const kept: unknown[] = [];
    const agreement = new Map<unknown, number>();
    for (const [sig, count] of runCount) {
      const ratio = count / denom;
      if (ratio >= this.kThreshold) {
        const item = representative.get(sig);
        kept.push(item);
        agreement.set(item, ratio);
      }
    }
    if (kept.length === 0) {
      warnings.push(
        `${task.id}: no item cleared the k-sample agreement threshold — no interpretations`,
      );
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
      if (base.score <= AUDIT_FLOOR) return base;
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
  private lowerItems(
    task: ExtractionTask,
    items: unknown[],
    docIri: string,
    calibrateItem: (item: unknown) => { score: number; calibration: Calibration },
  ): Interpretation[] {
    const out: Interpretation[] = [];
    items.forEach((item, i) => {
      const { score, calibration } = calibrateItem(item);
      const self = clampConfidence((item as { confidence: number }).confidence);
      const confidence = clampConfidence(Math.min(self, score));
      for (const triple of task.lower(item, i + 1, { docIri })) {
        // A DESCRIPTIVE slot is not covered by the item cross-check → forced
        // SelfReported + capped, so a re-derived datetime cannot launder an
        // attacker-supplied title into a Calibrated/auto literal.
        const tripleCalibration: Calibration =
          triple.descriptive === true ? "SelfReported" : calibration;
        const tripleConfidence =
          triple.descriptive === true
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
  private callExtractor(task: ExtractionTask, text: string, nowIso: string): Promise<unknown> {
    const call = Promise.resolve().then(() =>
      this.extractor({ task: task.id, schema: task.schema, text, now: nowIso }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([call, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}

// --- test/demo helper --------------------------------------------------------
/**
 * A deterministic scripted {@link LlmExtractor} for hermetic tests + demos — returns
 * the pre-supplied output for each task id (a function per task, or a static value),
 * with no network. Production injects a real extractor (see `./interpret-llm-http`).
 */
export function scriptedExtractor(
  script: Readonly<Record<string, unknown | ((text: string) => unknown)>>,
): LlmExtractor {
  return async ({ task, text }) => {
    const entry = Object.hasOwn(script, task) ? script[task] : undefined;
    return typeof entry === "function" ? (entry as (t: string) => unknown)(text) : entry;
  };
}

// --- private helpers (mirroring interpret.ts's clip/unquote — kept local so the
//     LLM adapter adds no coupling to M1 internals) ---------------------------
function clip(text: string): string {
  return text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
}
function unquote(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}
function errText(err: unknown): string {
  if (err instanceof Error)
    return err.name === "Error" ? err.message : `${err.name}: ${err.message}`;
  return "unknown error";
}
