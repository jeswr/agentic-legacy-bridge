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
import { type MimePart, type ReplySigner } from "../reply.js";
/** Options for {@link buildActionMetadata}. */
export interface ActionMetadataOptions {
    /**
     * When the action happened (ISO-8601 with an EXPLICIT timezone → canonical UTC).
     * REQUIRED — this is the descriptor's one load-bearing datum. This is OUR OWN
     * action time (a trusted caller value, not channel input), so a malformed or
     * zone-ambiguous value throws rather than silently emitting a wrong instant.
     */
    readonly sentAt: string;
    /** The acting agent IRI (`schema:sender` + `prov:wasAttributedTo`). http(s) only. */
    readonly sender?: string;
    /** The issuing agent identity (the VC issuer). http(s) only. */
    readonly issuer?: string;
    /** The raw-message anchor this action answers (`agentic:inReplyTo`, a `urn:agentic:*`). */
    readonly inReplyTo?: string;
    /** What the action derived from (`prov:wasDerivedFrom`) — an http(s) IRI or a `urn:agentic:*`. */
    readonly derivedFrom?: string;
    /** The ODRL mandate the agent acted under (`prov:hadPlan` via a qualified association). */
    readonly mandateIri?: string;
    /** The authoritative pod-hosted copy URL (→ `X-Agentic-Reply` header). http(s) only. */
    readonly podCopyUrl?: string;
    /** The injectable Data-Integrity signer (see {@link ReplySigner}). */
    readonly sign?: ReplySigner;
}
/** The assembled action-metadata carrier (mirrors `BuiltReply`). */
export interface BuiltActionMetadata {
    /** The JSON-LD credential (with a `proof` iff a signer was supplied AND attached one). */
    readonly credential: Record<string, unknown>;
    /** True iff the credential carries a Data Integrity proof. */
    readonly signed: boolean;
    /** An HTML-safe `<script type="application/ld+json">…</script>` block for the body. */
    readonly inlineHtml: string;
    /** The `application/ld+json` part for `multipart/alternative`. */
    readonly mimePart: MimePart;
    /** Carrier headers (`X-Agentic-Reply` → the pod copy) — safe, single-line values only. */
    readonly headers: Readonly<Record<string, string>>;
}
/**
 * Build the standardized "the agent did X at \<time\>" descriptor: a `schema:Message`
 * conforming to (and hash-pinning) the {@link SENT_AT_PATTERN_IRI} pattern, with PROV
 * attribution. Pure + hermetic (the only async is the optional injected signer).
 * Optional fields with unsafe values are OMITTED (fail-closed); a bad `sentAt` throws
 * (see {@link ActionMetadataOptions.sentAt}).
 */
export declare function buildActionMetadata(options: ActionMetadataOptions): Promise<BuiltActionMetadata>;
//# sourceMappingURL=emit.d.ts.map