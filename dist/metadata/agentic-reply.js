// AUTHORED-BY Claude Fable 5
/**
 * Deterministic extraction of a peer agent's **`AgenticReply` carrier** (metadata-
 * protocol Rule 1c — `NOW-PERSONAL-AGENT.md` §5.1/§5.4): the inline JSON-LD block
 * {@link import("../reply.js").buildReply} itself emits, optionally signed as a
 * `@jeswr/solid-vc` Verifiable Credential over the RDFC-1.0 canonical graph.
 *
 * Signature verification is an INJECTABLE seam ({@link AgenticReplyVerifier} — the
 * concrete `solid-vc` verifier is an adapter; this package stays creds/crypto-free
 * and hermetically testable). The trust split is load-bearing:
 *
 *  - **Verified block** → content lands at confidence 1.0 **Calibrated** (eligible
 *    for the reversible-auto lane) and the VC issuer is asserted as
 *    `prov:wasAttributedTo` at calibration **Verified**.
 *  - **Unverified block** (no verifier injected, no/invalid proof, or a throwing
 *    verifier) → the STRUCTURE still parses deterministically (it is what the message
 *    carries), but every datum is **SelfReported** — which `classifyReliability`
 *    NEVER auto-runs — and the issuer/identity is NEVER asserted. An attacker who
 *    pastes an unsigned "AcceptAction" block into an email gets a human-confirm
 *    queue entry, not an automatic booking. Fail-closed on every branch.
 *
 * Pattern conformance (`dct:conformsTo` + the a2a-rdf `protocolHash` content-address)
 * is surfaced so a consuming agent can run the §5.3 `(pattern hash → handler)` cache
 * — the "learn the pattern once, no LLM ever after" ratchet.
 */
import { asUrn, safeHttpIri } from "../safe-iri.js";
import { A2A_PROTOCOL_HASH, AGENTIC_IN_REPLY_TO, DCT_CONFORMS_TO, PROV_WAS_ATTRIBUTED_TO, RDF_TYPE, SCHEMA_ACCEPT_ACTION, SCHEMA_DATE_SENT, SCHEMA_PROPOSE_ACTION, SCHEMA_REJECT_ACTION, } from "../vocab.js";
import { isAgenticReplyNode, mapEventNode } from "./jsonld.js";
import { AMBIGUOUS_TZ_NOTE, firstProp, parseWhen, prop, whenDatatype } from "./values.js";
/** Caps (fail-closed). */
const MAX_REPLY_BLOCKS = 4;
const MAX_REPLY_EVENTS = 16;
const MAX_CONFORMANCES = 4;
/** The `sha256:<64 lowercase hex>` content-address shape (a2a-rdf-extension). */
const SHA256_HASH = /^sha256:[0-9a-f]{64}$/;
/** The closed action-type map (bare / prefixed / full-IRI spellings). */
const ACTION_TYPES = new Map([
    ["ProposeAction", SCHEMA_PROPOSE_ACTION],
    ["AcceptAction", SCHEMA_ACCEPT_ACTION],
    ["RejectAction", SCHEMA_REJECT_ACTION],
].flatMap(([name, iri]) => [
    [name, iri],
    [`schema:${name}`, iri],
    [`https://schema.org/${name}`, iri],
]));
/** Parse a JSON block fail-closed to a non-null object, else `undefined`. */
function parseObject(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Read the declared conformances: a string, an `{"@id": …}` node, or an array of either. */
function readConformances(subject) {
    const raw = firstProp(subject, ["conformsTo", "dct:conformsTo", DCT_CONFORMS_TO]);
    if (raw === undefined)
        return [];
    const entries = Array.isArray(raw) ? raw.slice(0, MAX_CONFORMANCES) : [raw];
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
        const iri = safeHttpIri(typeof entry === "string" ? entry : prop(entry, "@id"));
        if (iri === undefined || seen.has(iri))
            continue;
        seen.add(iri);
        const hashRaw = firstProp(entry, ["protocolHash", "a2a:protocolHash", A2A_PROTOCOL_HASH]);
        const hash = typeof hashRaw === "string" && SHA256_HASH.test(hashRaw) ? hashRaw : undefined;
        out.push({ iri, ...(hash !== undefined ? { protocolHash: hash } : {}) });
        if (out.length >= MAX_CONFORMANCES)
            break;
    }
    return out;
}
/** The SYNC per-block mapping core (verification verdict already decided). */
function mapReplyBlock(root, ctx, replyIndex, verified, issuer) {
    const interpretations = [];
    const patterns = [];
    const subject = prop(root, "credentialSubject");
    if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
        return { interpretations, patterns };
    }
    // Unverified structure is still extracted, but SELF-REPORTED — never auto-run.
    const calibration = verified ? "Calibrated" : "SelfReported";
    const replyIri = `${ctx.docIri}#areply-${replyIndex}`;
    const push = (predicate, object, overrides) => {
        interpretations.push({
            subject: replyIri,
            predicate,
            object,
            confidence: overrides?.confidence ?? 1,
            method: "Deterministic",
            calibration: overrides?.calibration ?? calibration,
            securityBearing: false,
            ...(overrides?.note !== undefined ? { note: overrides.note } : {}),
        });
    };
    // --- the action type (closed set) ---
    const typeRaw = firstProp(subject, ["@type", "type"]);
    const typeNames = typeof typeRaw === "string" ? [typeRaw] : Array.isArray(typeRaw) ? typeRaw.slice(0, 8) : [];
    for (const t of typeNames) {
        if (typeof t !== "string")
            continue;
        const actionIri = ACTION_TYPES.get(t.trim());
        if (actionIri !== undefined) {
            push(RDF_TYPE, { kind: "iri", value: actionIri });
            break;
        }
    }
    // --- the sent-at envelope ---
    const when = parseWhen(firstProp(subject, ["dateSent", "schema:dateSent", SCHEMA_DATE_SENT]));
    if (when !== undefined && when.kind === "dateTime") {
        push(SCHEMA_DATE_SENT, { kind: "literal", value: when.value, datatype: whenDatatype(when) }, when.ambiguous
            ? { confidence: 0.6, calibration: "SelfReported", note: AMBIGUOUS_TZ_NOTE }
            : {});
    }
    // --- the reply linkage (this package's own tight urn shape only) ---
    const inReplyTo = asUrn(firstProp(subject, ["inReplyTo", "agentic:inReplyTo", AGENTIC_IN_REPLY_TO]));
    if (inReplyTo !== undefined) {
        push(AGENTIC_IN_REPLY_TO, { kind: "iri", value: inReplyTo });
    }
    // --- pattern conformance (Rule 3) ---
    for (const conformance of readConformances(subject)) {
        push(DCT_CONFORMS_TO, { kind: "iri", value: conformance.iri });
        patterns.push(conformance);
    }
    // --- offered/chosen events ---
    const objectRaw = prop(subject, "object");
    const events = Array.isArray(objectRaw) ? objectRaw.slice(0, MAX_REPLY_EVENTS) : [];
    events.forEach((event, i) => {
        mapEventNode(event, `${replyIri}-event-${i + 1}`, {
            out: interpretations,
            confidence: 1,
            calibration,
        });
    });
    // --- the VERIFIED issuer identity (never asserted unverified) ---
    if (verified && issuer !== undefined) {
        push(PROV_WAS_ATTRIBUTED_TO, { kind: "iri", value: issuer }, { calibration: "Verified" });
    }
    return { interpretations, patterns };
}
/** The parsed AgenticReply roots of a message's JSON-LD blocks (count-capped). */
function replyRoots(blocks) {
    const out = [];
    if (blocks === undefined)
        return out;
    for (const text of blocks) {
        if (out.length >= MAX_REPLY_BLOCKS)
            break;
        const root = parseObject(text);
        if (root !== undefined && isAgenticReplyNode(root))
            out.push(root);
    }
    return out;
}
/** Merge per-block results, deduping patterns by IRI. */
function mergeExtractions(parts, verified, issuer) {
    const interpretations = [];
    const patterns = [];
    const seen = new Set();
    for (const part of parts) {
        interpretations.push(...part.interpretations);
        for (const pattern of part.patterns) {
            if (!seen.has(pattern.iri)) {
                seen.add(pattern.iri);
                patterns.push(pattern);
            }
        }
    }
    return { interpretations, patterns, verified, ...(issuer !== undefined ? { issuer } : {}) };
}
/**
 * SYNC structural extraction — no verifier, so every block is treated UNVERIFIED
 * (all SelfReported, no issuer). This is what the sync
 * {@link import("./interpreter.js").StructuredMetadataInterpreter} seam runs;
 * use {@link extractAgenticReply} with an injected verifier to land verified,
 * auto-lane-eligible interpretations.
 */
export function extractAgenticReplyStructural(blocks, ctx) {
    const parts = replyRoots(blocks).map((root, i) => mapReplyBlock(root, ctx, i + 1, false, undefined));
    return mergeExtractions(parts, false, undefined);
}
/**
 * Extract one message's AgenticReply blocks into reliability-tagged interpretations,
 * awaiting the injected verifier per block when one is supplied. Never throws:
 * malformed blocks are skipped, and a throwing/rejecting verifier counts as
 * unverified (fail-closed).
 */
export async function extractAgenticReply(blocks, ctx, options) {
    const roots = replyRoots(blocks);
    const parts = [];
    let anyVerified = false;
    let verifiedIssuer;
    for (const [i, root] of roots.entries()) {
        let verified = false;
        let issuer;
        if (options?.verify !== undefined) {
            try {
                const verdict = await options.verify(root);
                if (verdict.verified === true) {
                    verified = true;
                    issuer = safeHttpIri(verdict.issuer);
                }
            }
            catch {
                verified = false;
            }
        }
        if (verified) {
            anyVerified = true;
            verifiedIssuer ??= issuer;
        }
        parts.push(mapReplyBlock(root, ctx, i + 1, verified, issuer));
    }
    return mergeExtractions(parts, anyVerified, verifiedIssuer);
}
//# sourceMappingURL=agentic-reply.js.map