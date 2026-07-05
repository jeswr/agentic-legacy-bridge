// AUTHORED-BY Claude Fable 5
/**
 * The OUTBOUND standardized-metadata emitter (metadata-protocol Rule 2 —
 * `NOW-PERSONAL-AGENT.md` §5.2): when the agent performs an action — the flagship
 * case being *"this message was sent at \<time\>"* — it emits a machine-readable RDF
 * descriptor alongside the human prose, so a PEER agent's Rule-1 pass parses it
 * deterministically and, after learning the pattern once, never needs an LLM again.
 *
 * The descriptor MINTS NOTHING: `schema:Message` / `schema:dateSent` /
 * `schema:sender` for the envelope, PROV for attribution (which agent, under which
 * ODRL mandate, derived from which raw message), Dublin Core `dct:conformsTo` naming
 * the pattern, and the a2a-rdf `protocolHash` content-addressing it (Rule 3). The
 * carrier is the same landed Rung-3 assembly as {@link import("../reply.js").buildReply}:
 * inline JSON-LD for the HTML body (script-breakout-escaped), an
 * `application/ld+json` part for byte-exact consumers, an `X-Agentic-Reply` header
 * pointing at the authoritative pod copy, and an injectable {@link ReplySigner} seam
 * (the concrete `@jeswr/solid-vc` Data-Integrity signer is an adapter — this package
 * stays creds/crypto-free). Without a signer the payload is an honest UNSIGNED
 * descriptor (it never claims the `VerifiableCredential` type).
 *
 * `buildReply` already carries the sent-at envelope for REPLIES (its `dateSent` /
 * `sender` options); this emitter is for actions that are not a reply to anything —
 * an outbox log entry, a notification, a calendar write receipt.
 */
import { htmlSafeJson, INLINE_CONTEXT } from "../reply.js";
import { asUrn, safeHttpIri } from "../safe-iri.js";
import { SENT_AT_PATTERN_HASH, SENT_AT_PATTERN_IRI } from "./patterns.js";
import { parseWhen } from "./values.js";
/**
 * Build the standardized "the agent did X at \<time\>" descriptor: a `schema:Message`
 * conforming to (and hash-pinning) the {@link SENT_AT_PATTERN_IRI} pattern, with PROV
 * attribution. Pure + hermetic (the only async is the optional injected signer).
 * Optional fields with unsafe values are OMITTED (fail-closed); a bad `sentAt` throws
 * (see {@link ActionMetadataOptions.sentAt}).
 */
export async function buildActionMetadata(options) {
    const when = parseWhen(options.sentAt);
    if (when === undefined || when.kind !== "dateTime" || when.ambiguous) {
        throw new Error("buildActionMetadata: sentAt must be a valid ISO-8601 datetime with an explicit timezone");
    }
    const subject = {
        type: "Message",
        conformsTo: [{ "@id": SENT_AT_PATTERN_IRI, protocolHash: SENT_AT_PATTERN_HASH }],
        dateSent: when.value,
    };
    const sender = safeHttpIri(options.sender);
    if (sender !== undefined) {
        subject.sender = sender;
        subject.wasAttributedTo = sender;
    }
    const inReplyTo = asUrn(options.inReplyTo);
    if (inReplyTo !== undefined)
        subject.inReplyTo = inReplyTo;
    const derivedFrom = safeHttpIri(options.derivedFrom) ?? asUrn(options.derivedFrom);
    if (derivedFrom !== undefined)
        subject.wasDerivedFrom = derivedFrom;
    const mandate = safeHttpIri(options.mandateIri);
    if (mandate !== undefined) {
        subject.qualifiedAssociation = {
            type: "Association",
            ...(sender !== undefined ? { agent: sender } : {}),
            hadPlan: mandate,
        };
    }
    const issuer = safeHttpIri(options.issuer);
    const base = {
        "@context": INLINE_CONTEXT,
        type: ["AgenticReply"],
        ...(issuer !== undefined ? { issuer } : {}),
        credentialSubject: subject,
    };
    let credential = base;
    let signed = false;
    if (options.sign !== undefined) {
        const toSign = {
            ...base,
            type: ["VerifiableCredential", "AgenticReply"],
        };
        const result = await options.sign(toSign);
        // Honest: only treat as signed if the signer actually attached a proof.
        if (result !== null && typeof result === "object" && "proof" in result) {
            credential = result;
            signed = true;
        }
    }
    const json = JSON.stringify(credential, null, 2);
    const headers = {};
    const podCopy = safeHttpIri(options.podCopyUrl);
    if (podCopy !== undefined)
        headers["X-Agentic-Reply"] = podCopy;
    return {
        credential,
        signed,
        inlineHtml: `<script type="application/ld+json">\n${htmlSafeJson(json)}\n</script>`,
        mimePart: { contentType: "application/ld+json", body: json },
        headers,
    };
}
//# sourceMappingURL=emit.js.map