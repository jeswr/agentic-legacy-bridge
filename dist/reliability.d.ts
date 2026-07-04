/**
 * The RELIABILITY model (LEGACY-INTEROP.md §3b/§3c) — the crux of "interpret with
 * reliability, not laundering".
 *
 * An interpreted datum is NEVER a bare triple. It is a **qualified PROV derivation**
 * carrying: the reified statement it asserts, `prov:wasDerivedFrom` the raw message,
 * `prov:wasGeneratedBy` the interpreting activity (under a signed ODRL mandate), an
 * explicit `agentic:confidence` in [0,1], the interpretation METHOD, and the
 * confidence's OWN calibration provenance. A downstream consumer materialises the
 * plain triple into working data ONLY after it passes {@link classifyReliability}.
 *
 * The hard rule ({@link classifyReliability}, non-negotiable, overrides any score):
 * a security-/value-bearing datum is NEVER `auto` — it always needs a human confirm.
 */
import { type Store } from "n3";
/** How a datum was interpreted (drives, with calibration, the downstream gate). */
export type InterpretationMethod = "Deterministic" | "LlmInterpretation" | "HumanConfirmed";
/** The provenance of the CONFIDENCE score itself (a self-reported 0.9 ≠ a calibrated 0.9). */
export type Calibration = "SelfReported" | "Calibrated" | "Verified";
/** The object of an interpreted (reified) statement — an IRI or a typed literal. */
export type InterpretationObject = {
    readonly kind: "iri";
    readonly value: string;
} | {
    readonly kind: "literal";
    readonly value: string;
    readonly datatype?: string;
};
/**
 * One interpreted datum. Produced by an {@link import("./interpret.js").Interpreter};
 * `subject`/`predicate`/`object`(iri)/`object.datatype` are all treated as
 * UNTRUSTED (an injected LLM interpreter could emit anything) and are
 * injection-validated before a quad is built.
 */
export interface Interpretation {
    /** The reified statement's subject IRI (absolute). */
    readonly subject: string;
    /** The reified statement's predicate IRI (absolute). */
    readonly predicate: string;
    /** The reified statement's object. */
    readonly object: InterpretationObject;
    /** The reliability score in [0,1] (clamped on write). */
    readonly confidence: number;
    /** How it was interpreted. */
    readonly method: InterpretationMethod;
    /** The confidence's own calibration provenance. */
    readonly calibration: Calibration;
    /**
     * True if materialising this datum would drive a SECURITY-/VALUE-bearing action
     * (grant access, pay, sign, share, delete). Such a datum is NEVER auto-executed,
     * at any confidence — {@link classifyReliability} forces `confirm`.
     */
    readonly securityBearing?: boolean;
    /** An optional human-readable note (control-stripped when written). */
    readonly note?: string;
}
/** Context for lowering interpretations into RDF quads. */
export interface InterpretationGraphContext {
    /** The document base IRI these interpretations live in (fragments are minted under it). */
    readonly docIri: string;
    /** The raw-message anchor IRI every interpretation is `prov:wasDerivedFrom`. */
    readonly rawMessageIri: string;
    /** The interpreting agent's WebID (`prov:wasAssociatedWith`), when known. */
    readonly interpretingAgentWebId?: string;
    /** The ODRL mandate IRI the agent acts under (`prov:hadPlan`), when known. */
    readonly mandateIri?: string;
    /** ISO-8601 activity end time; defaults to now. */
    readonly endedAtTime?: string;
}
/** Clamp a confidence to [0,1]; a non-finite value fails closed to 0. */
export declare function clampConfidence(value: number): number;
/**
 * Lower one {@link Interpretation} into the reified qualified-derivation quads (the
 * §3b shape) under `store`, minting `${docIri}#interp-<index>` for the interpretation
 * and `…#interp-<index>-activity` for its activity. Returns the interpretation node
 * IRI, or `undefined` if the datum was DROPPED because a required IRI was unsafe
 * (fail-closed — an un-lowerable interpretation never silently becomes a bare triple).
 */
export declare function addInterpretation(store: Store, interp: Interpretation, index: number, ctx: InterpretationGraphContext): string | undefined;
/** The two thresholds a consuming app configures. */
export interface ReliabilityThresholds {
    /** At/above this AND Calibrated/Verified → a reversible non-security action may auto-run. */
    readonly tauAuto: number;
    /** Between τ_confirm and τ_auto → quarantine for human confirm; below → audit-only. */
    readonly tauConfirm: number;
}
/** The suite defaults (LEGACY-INTEROP.md §3c). */
export declare const DEFAULT_THRESHOLDS: ReliabilityThresholds;
/** The gate decision for a reliability-tagged datum. */
export type ReliabilityDecision = "auto" | "confirm" | "audit";
/**
 * Decide how a downstream consumer should treat a reliability-tagged datum (§3c):
 *  - **The hard rule (overrides everything):** a `securityBearing` datum is NEVER
 *    `auto` — it returns `confirm` regardless of score.
 *  - `auto` — confidence ≥ τ_auto AND calibration ∈ {Calibrated, Verified}
 *    (a self-reported score, however high, is never enough to auto-run).
 *  - `confirm` — confidence ≥ τ_confirm (the ambiguous middle: human confirm).
 *  - `audit` — below τ_confirm (retained for audit, never surfaced as data).
 */
export declare function classifyReliability(interp: Pick<Interpretation, "confidence" | "calibration" | "securityBearing">, thresholds?: ReliabilityThresholds): ReliabilityDecision;
//# sourceMappingURL=reliability.d.ts.map