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
import { DataFactory } from "n3";
import { asUrn, safeHttpIri, sanitizeText } from "./safe-iri.js";
import { AGENTIC_ASSERTS_OBJECT, AGENTIC_ASSERTS_OBJECT_IRI, AGENTIC_ASSERTS_PREDICATE, AGENTIC_ASSERTS_SUBJECT, AGENTIC_CALIBRATED, AGENTIC_CALIBRATION, AGENTIC_CONFIDENCE, AGENTIC_DETERMINISTIC, AGENTIC_HUMAN_CONFIRMED, AGENTIC_INTERPRETATION, AGENTIC_INTERPRETATION_METHOD, AGENTIC_LLM_INTERPRETATION, AGENTIC_MODEL, AGENTIC_SECURITY_BEARING, AGENTIC_SELF_REPORTED, AGENTIC_VERIFIED, DCT, PROV_ACTIVITY, PROV_ASSOCIATION, PROV_ENDED_AT_TIME, PROV_ENTITY, PROV_HAD_PLAN, PROV_QUALIFIED_ASSOCIATION, PROV_WAS_ASSOCIATED_WITH, PROV_WAS_DERIVED_FROM, PROV_WAS_GENERATED_BY, RDF_TYPE, XSD, } from "./vocab.js";
const { namedNode, literal, blankNode } = DataFactory;
const METHOD_IRI = {
    Deterministic: AGENTIC_DETERMINISTIC,
    LlmInterpretation: AGENTIC_LLM_INTERPRETATION,
    HumanConfirmed: AGENTIC_HUMAN_CONFIRMED,
};
const CALIBRATION_IRI = {
    SelfReported: AGENTIC_SELF_REPORTED,
    Calibrated: AGENTIC_CALIBRATED,
    Verified: AGENTIC_VERIFIED,
};
/** Clamp a confidence to [0,1]; a non-finite value fails closed to 0. */
export function clampConfidence(value) {
    if (!Number.isFinite(value))
        return 0;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
/**
 * Lower one {@link Interpretation} into the reified qualified-derivation quads (the
 * §3b shape) under `store`, minting `${docIri}#interp-<index>` for the interpretation
 * and `…#interp-<index>-activity` for its activity. Returns the interpretation node
 * IRI, or `undefined` if the datum was DROPPED because a required IRI was unsafe
 * (fail-closed — an un-lowerable interpretation never silently becomes a bare triple).
 */
export function addInterpretation(store, interp, index, ctx) {
    const subject = safeHttpIri(interp.subject);
    const predicate = safeHttpIri(interp.predicate);
    const rawMessage = safeHttpIri(ctx.rawMessageIri) ?? asUrn(ctx.rawMessageIri);
    const docBase = safeHttpIri(ctx.docIri) ?? asUrn(ctx.docIri);
    if (subject === undefined ||
        predicate === undefined ||
        rawMessage === undefined ||
        docBase === undefined) {
        return undefined;
    }
    // Object: an IRI must be safe; a literal is control-stripped, datatype validated.
    let objectAdd;
    const interpIri = `${docBase}#interp-${index}`;
    const interpNode = namedNode(interpIri);
    if (interp.object.kind === "iri") {
        const objIri = safeHttpIri(interp.object.value);
        if (objIri === undefined)
            return undefined;
        objectAdd = () => store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_OBJECT_IRI), namedNode(objIri));
    }
    else {
        const value = sanitizeText(interp.object.value);
        const dt = interp.object.datatype;
        const dtIri = dt === undefined ? `${XSD}string` : safeHttpIri(dt);
        if (dtIri === undefined)
            return undefined;
        objectAdd = () => store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_OBJECT), literal(value, namedNode(dtIri)));
    }
    store.addQuad(interpNode, namedNode(RDF_TYPE), namedNode(AGENTIC_INTERPRETATION));
    store.addQuad(interpNode, namedNode(RDF_TYPE), namedNode(PROV_ENTITY));
    store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_SUBJECT), namedNode(subject));
    store.addQuad(interpNode, namedNode(AGENTIC_ASSERTS_PREDICATE), namedNode(predicate));
    objectAdd();
    store.addQuad(interpNode, namedNode(PROV_WAS_DERIVED_FROM), namedNode(rawMessage));
    store.addQuad(interpNode, namedNode(AGENTIC_CONFIDENCE), literal(formatDecimal(clampConfidence(interp.confidence)), namedNode(`${XSD}decimal`)));
    // `method`/`calibration` are UNTRUSTED (an injected interpreter could emit an
    // out-of-enum string despite the type). An unknown value must NOT reach
    // `namedNode(undefined)`; fail closed to the LEAST-trusting member of each enum
    // (an LLM interpretation / a self-reported score) so a malformed datum can never
    // masquerade as a higher-trust one.
    store.addQuad(interpNode, namedNode(AGENTIC_INTERPRETATION_METHOD), namedNode(METHOD_IRI[interp.method] ?? AGENTIC_LLM_INTERPRETATION));
    store.addQuad(interpNode, namedNode(AGENTIC_CALIBRATION), namedNode(CALIBRATION_IRI[interp.calibration] ?? AGENTIC_SELF_REPORTED));
    if (interp.securityBearing === true) {
        store.addQuad(interpNode, namedNode(AGENTIC_SECURITY_BEARING), literal("true", namedNode(`${XSD}boolean`)));
    }
    if (interp.note !== undefined) {
        const note = sanitizeText(interp.note).trim();
        if (note !== "")
            store.addQuad(interpNode, namedNode(`${DCT}description`), literal(note));
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
    // LLM provenance (M2.3): the opaque model tag + the extraction-task id on the
    // activity. Both are owner-config / adapter-assigned (NEVER model output); they
    // are still sanitised + capped as untrusted-string defence-in-depth, and only
    // written when non-empty (a deterministic interpretation sets neither).
    if (interp.model !== undefined) {
        const model = sanitizeText(interp.model).trim().slice(0, 128);
        if (model !== "")
            store.addQuad(activity, namedNode(AGENTIC_MODEL), literal(model));
    }
    if (interp.extractionTask !== undefined) {
        const task = sanitizeText(interp.extractionTask).trim().slice(0, 128);
        if (task !== "")
            store.addQuad(activity, namedNode(`${DCT}description`), literal(task));
    }
    const ended = isoOrNow(ctx.endedAtTime);
    store.addQuad(activity, namedNode(PROV_ENDED_AT_TIME), literal(ended, namedNode(`${XSD}dateTime`)));
    return interpIri;
}
/** Format a [0,1] number as a compact xsd:decimal string (always has a decimal point). */
function formatDecimal(n) {
    // Keep up to 4 dp, trim trailing zeros, but always keep at least one fractional digit.
    const s = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
    return s;
}
/** Return `iso` if a valid ISO datetime, else now. */
function isoOrNow(iso) {
    if (iso !== undefined) {
        const ms = Date.parse(iso);
        if (!Number.isNaN(ms))
            return new Date(ms).toISOString();
    }
    return new Date().toISOString();
}
/** The suite defaults (LEGACY-INTEROP.md §3c). */
export const DEFAULT_THRESHOLDS = { tauAuto: 0.9, tauConfirm: 0.5 };
/**
 * Decide how a downstream consumer should treat a reliability-tagged datum (§3c):
 *  - **The hard rule (overrides everything):** a `securityBearing` datum is NEVER
 *    `auto` — it returns `confirm` regardless of score.
 *  - `auto` — confidence ≥ τ_auto AND calibration ∈ {Calibrated, Verified}
 *    (a self-reported score, however high, is never enough to auto-run).
 *  - `confirm` — confidence ≥ τ_confirm (the ambiguous middle: human confirm).
 *  - `audit` — below τ_confirm (retained for audit, never surfaced as data).
 */
export function classifyReliability(interp, thresholds = DEFAULT_THRESHOLDS) {
    const c = clampConfidence(interp.confidence);
    // Hard rule first — a security/value-bearing datum never auto-runs.
    if (interp.securityBearing === true) {
        return c >= thresholds.tauConfirm ? "confirm" : "audit";
    }
    const wellCalibrated = interp.calibration === "Calibrated" || interp.calibration === "Verified";
    if (c >= thresholds.tauAuto && wellCalibrated)
        return "auto";
    if (c >= thresholds.tauConfirm)
        return "confirm";
    return "audit";
}
//# sourceMappingURL=reliability.js.map