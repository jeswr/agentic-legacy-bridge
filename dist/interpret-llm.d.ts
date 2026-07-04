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
import { type InterpretContext } from "./interpret.js";
import { type BridgeMessage } from "./message.js";
import { type Calibration, type Interpretation, type InterpretationObject } from "./reliability.js";
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
/**
 * The ASYNC counterpart of M1's synchronous {@link Interpreter} — an LLM call is
 * inherently async, so the live adapter cannot satisfy the synchronous seam
 * verbatim. The reliability envelope (per-datum {@link Interpretation}) is identical.
 */
export interface AsyncInterpreter {
    interpret(message: BridgeMessage | EmailMessage, ctx: InterpretContext): Promise<Interpretation[]>;
}
interface MeetingItem {
    readonly startTime: string;
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
type ValidationResult<I> = {
    readonly ok: true;
    readonly items: I[];
} | {
    readonly ok: false;
    readonly reason: string;
};
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
    calibrate(item: I, ctx: {
        readonly body: string;
        readonly now: Date;
    }): {
        readonly score: number;
        readonly calibration: Calibration;
    };
    /** Mint the reified statement TEMPLATE(s) for one item (adapter mints all IRIs). */
    lower(item: I, index: number, ctx: {
        readonly docIri: string;
    }): SlotTriple[];
}
/** Task: proposed MEETING times. Slots → `schema:Event` + `schema:startTime` (+ `schema:name`). */
export declare const meetingTimesTask: ExtractionTask<MeetingItem>;
/** Task: ACTION items. Slots → `schema:Action` + `schema:name` (a descriptive LITERAL, never a grant). */
export declare const actionItemsTask: ExtractionTask<ActionItem>;
/** Task: yes/no/neutral reply POLARITY. Slot → `agentic:replyPolarity` literal. */
export declare const replyPolarityTask: ExtractionTask<PolarityItem>;
/** The default extraction-task registry (M2.3 first set). Callers may supply their own. */
export declare const DEFAULT_TASKS: readonly ExtractionTask[];
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
export declare class LlmInterpreter implements AsyncInterpreter {
    private readonly extractor;
    private readonly model;
    private readonly tasks;
    private readonly kSamples;
    private readonly kThreshold;
    private readonly timeoutMs;
    private readonly onWarning;
    constructor(options: LlmInterpreterOptions);
    /** The {@link AsyncInterpreter} contract — interpretations only (warnings go to `onWarning`). */
    interpret(message: BridgeMessage | EmailMessage, ctx: InterpretContext): Promise<Interpretation[]>;
    /** Interpret and ALSO return the fail-closed warnings (a task that produced nothing). */
    interpretDetailed(message: BridgeMessage | EmailMessage, ctx: InterpretContext): Promise<LlmInterpretResult>;
    /** Run ONE task fail-closed → its interpretations (or `[]` + a warning). */
    private runTask;
    /** The opt-in k-sample path (§2.3 rung c). */
    private runTaskKSample;
    /** Lower validated items → interpretations, wrapping each with the ADAPTER-assigned envelope. */
    private lowerItems;
    /** Call the extractor with a defence-in-depth timeout (a hang fails the task closed). */
    private callExtractor;
}
/**
 * A deterministic scripted {@link LlmExtractor} for hermetic tests + demos — returns
 * the pre-supplied output for each task id (a function per task, or a static value),
 * with no network. Production injects a real extractor (see `./interpret-llm-http`).
 */
export declare function scriptedExtractor(script: Readonly<Record<string, unknown | ((text: string) => unknown)>>): LlmExtractor;
export {};
//# sourceMappingURL=interpret-llm.d.ts.map