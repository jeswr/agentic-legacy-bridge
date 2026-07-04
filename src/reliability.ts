// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
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

import { DataFactory, type Store } from "n3";
import { safeHttpIri, sanitizeText } from "./safe-iri.js";
import {
  AGENTIC_ASSERTS_OBJECT,
  AGENTIC_ASSERTS_OBJECT_IRI,
  AGENTIC_ASSERTS_PREDICATE,
  AGENTIC_ASSERTS_SUBJECT,
  AGENTIC_CALIBRATED,
  AGENTIC_CALIBRATION,
  AGENTIC_CONFIDENCE,
  AGENTIC_DETERMINISTIC,
  AGENTIC_HUMAN_CONFIRMED,
  AGENTIC_INTERPRETATION,
  AGENTIC_INTERPRETATION_METHOD,
  AGENTIC_LLM_INTERPRETATION,
  AGENTIC_SECURITY_BEARING,
  AGENTIC_SELF_REPORTED,
  AGENTIC_VERIFIED,
  DCT,
  PROV_ACTIVITY,
  PROV_ASSOCIATION,
  PROV_ENDED_AT_TIME,
  PROV_ENTITY,
  PROV_HAD_PLAN,
  PROV_QUALIFIED_ASSOCIATION,
  PROV_WAS_ASSOCIATED_WITH,
  PROV_WAS_DERIVED_FROM,
  PROV_WAS_GENERATED_BY,
  RDF_TYPE,
  XSD,
} from "./vocab.js";

const { namedNode, literal, blankNode } = DataFactory;

/** How a datum was interpreted (drives, with calibration, the downstream gate). */
export type InterpretationMethod = "Deterministic" | "LlmInterpretation" | "HumanConfirmed";
/** The provenance of the CONFIDENCE score itself (a self-reported 0.9 ≠ a calibrated 0.9). */
export type Calibration = "SelfReported" | "Calibrated" | "Verified";

/** The object of an interpreted (reified) statement — an IRI or a typed literal. */
export type InterpretationObject =
  | { readonly kind: "iri"; readonly value: string }
  | { readonly kind: "literal"; readonly value: string; readonly datatype?: string };

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

const METHOD_IRI: Readonly<Record<InterpretationMethod, string>> = {
  Deterministic: AGENTIC_DETERMINISTIC,
  LlmInterpretation: AGENTIC_LLM_INTERPRETATION,
  HumanConfirmed: AGENTIC_HUMAN_CONFIRMED,
};
const CALIBRATION_IRI: Readonly<Record<Calibration, string>> = {
  SelfReported: AGENTIC_SELF_REPORTED,
  Calibrated: AGENTIC_CALIBRATED,
  Verified: AGENTIC_VERIFIED,
};

/** Clamp a confidence to [0,1]; a non-finite value fails closed to 0. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Lower one {@link Interpretation} into the reified qualified-derivation quads (the
 * §3b shape) under `store`, minting `${docIri}#interp-<index>` for the interpretation
 * and `…#interp-<index>-activity` for its activity. Returns the interpretation node
 * IRI, or `undefined` if the datum was DROPPED because a required IRI was unsafe
 * (fail-closed — an un-lowerable interpretation never silently becomes a bare triple).
 */
export function addInterpretation(
  store: Store,
  interp: Interpretation,
  index: number,
  ctx: InterpretationGraphContext,
): string | undefined {
  const subject = safeHttpIri(interp.subject);
  const predicate = safeHttpIri(interp.predicate);
  const rawMessage = safeHttpIri(ctx.rawMessageIri) ?? asUrn(ctx.rawMessageIri);
  const docBase = safeHttpIri(ctx.docIri) ?? asUrn(ctx.docIri);
  if (
    subject === undefined ||
    predicate === undefined ||
    rawMessage === undefined ||
    docBase === undefined
  ) {
    return undefined;
  }
  // Object: an IRI must be safe; a literal is control-stripped, datatype validated.
  let objectAdd: (() => void) | undefined;
  const interpIri = `${docBase}#interp-${index}`;
  const interpNode = namedNode(interpIri);
  if (interp.object.kind === "iri") {
    const objIri = safeHttpIri(interp.object.value);
    if (objIri === undefined) return undefined;
    objectAdd = () =>
      store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_OBJECT_IRI), namedNode(objIri));
  } else {
    const value = sanitizeText(interp.object.value);
    const dt = interp.object.datatype;
    const dtIri = dt === undefined ? `${XSD}string` : safeHttpIri(dt);
    if (dtIri === undefined) return undefined;
    objectAdd = () =>
      store.addQuad(
        interpNode,
        namedNode(AGENTIC_ASSERTS_OBJECT),
        literal(value, namedNode(dtIri)),
      );
  }

  store.addQuad(interpNode, namedNode(RDF_TYPE), namedNode(AGENTIC_INTERPRETATION));
  store.addQuad(interpNode, namedNode(RDF_TYPE), namedNode(PROV_ENTITY));
  store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_SUBJECT), namedNode(subject));
  store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_PREDICATE), namedNode(predicate));
  objectAdd();
  store.addQuad(interpNode, namedNode(PROV_WAS_DERIVED_FROM), namedNode(rawMessage));
  store.addQuad(
    interpNode,
    namedNode(AGENTIC_CONFIDENCE),
    literal(formatDecimal(clampConfidence(interp.confidence)), namedNode(`${XSD}decimal`)),
  );
  store.addQuad(
    interpNode,
    namedNode(AGENTIC_INTERPRETATION_METHOD),
    namedNode(METHOD_IRI[interp.method]),
  );
  store.addQuad(
    interpNode,
    namedNode(AGENTIC_CALIBRATION),
    namedNode(CALIBRATION_IRI[interp.calibration]),
  );
  if (interp.securityBearing === true) {
    store.addQuad(
      interpNode,
      namedNode(AGENTIC_SECURITY_BEARING),
      literal("true", namedNode(`${XSD}boolean`)),
    );
  }
  if (interp.note !== undefined) {
    const note = sanitizeText(interp.note).trim();
    if (note !== "") store.addQuad(interpNode, namedNode(`${DCT}description`), literal(note));
  }

  // The interpreting activity.
  const activityIri = `${docBase}#interp-${index}-activity`;
  const activity = namedNode(activityIri);
  store.addQuad(interpNode, namedNode(PROV_WAS_GENERATED_BY), activity);
  store.addQuad(activity, namedNode(RDF_TYPE), namedNode(PROV_ACTIVITY));
  const agent = safeHttpIri(ctx.interpretingAgentWebId);
  if (agent !== undefined) {
    store.addQuad(activity, namedNode(PROV_WAS_ASSOCIATED_WITH), namedNode(agent));
  }
  const mandate = safeHttpIri(ctx.mandateIri);
  if (mandate !== undefined) {
    const assoc = blankNode();
    store.addQuad(activity, namedNode(PROV_QUALIFIED_ASSOCIATION), assoc);
    store.addQuad(assoc, namedNode(RDF_TYPE), namedNode(PROV_ASSOCIATION));
    store.addQuad(assoc, namedNode(PROV_HAD_PLAN), namedNode(mandate));
  }
  const ended = isoOrNow(ctx.endedAtTime);
  store.addQuad(
    activity,
    namedNode(PROV_ENDED_AT_TIME),
    literal(ended, namedNode(`${XSD}dateTime`)),
  );

  return interpIri;
}

/** A permissive urn:/absolute-IRI passthrough for the internal anchor IRIs we mint. */
function asUrn(value: string): string | undefined {
  // We only mint `urn:agentic:*` anchors ourselves (safe by construction). Accept an
  // absolute `urn:` with no IRIREF-forbidden char; reject anything else.
  if (/^urn:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9._~%:-]+$/.test(value)) return value;
  return undefined;
}

/** Format a [0,1] number as a compact xsd:decimal string (always has a decimal point). */
function formatDecimal(n: number): string {
  // Keep up to 4 dp, trim trailing zeros, but always keep at least one fractional digit.
  const s = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
  return s;
}

/** Return `iso` if a valid ISO datetime, else now. */
function isoOrNow(iso: string | undefined): string {
  if (iso !== undefined) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

// --- the downstream gate (§3c) ----------------------------------------------
/** The two thresholds a consuming app configures. */
export interface ReliabilityThresholds {
  /** At/above this AND Calibrated/Verified → a reversible non-security action may auto-run. */
  readonly tauAuto: number;
  /** Between τ_confirm and τ_auto → quarantine for human confirm; below → audit-only. */
  readonly tauConfirm: number;
}

/** The suite defaults (LEGACY-INTEROP.md §3c). */
export const DEFAULT_THRESHOLDS: ReliabilityThresholds = { tauAuto: 0.9, tauConfirm: 0.5 };

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
export function classifyReliability(
  interp: Pick<Interpretation, "confidence" | "calibration" | "securityBearing">,
  thresholds: ReliabilityThresholds = DEFAULT_THRESHOLDS,
): ReliabilityDecision {
  const c = clampConfidence(interp.confidence);
  // Hard rule first — a security/value-bearing datum never auto-runs.
  if (interp.securityBearing === true) {
    return c >= thresholds.tauConfirm ? "confirm" : "audit";
  }
  const wellCalibrated = interp.calibration === "Calibrated" || interp.calibration === "Verified";
  if (c >= thresholds.tauAuto && wellCalibrated) return "auto";
  if (c >= thresholds.tauConfirm) return "confirm";
  return "audit";
}
