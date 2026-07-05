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
import type { InterpretContext } from "../interpret.js";
import type { Interpretation } from "../reliability.js";
/** The verdict an injected verifier returns. Anything but `verified: true` fails closed. */
export interface AgenticReplyVerification {
    /** True ONLY when the Data Integrity proof verified over the canonical graph. */
    readonly verified: boolean;
    /** The VERIFIED issuer identity (asserted only when `verified` is true). */
    readonly issuer?: string;
}
/**
 * The injectable signature-verification seam (the concrete `@jeswr/solid-vc`
 * `verifyVc` adapter implements this). Receives the parsed credential block.
 */
export type AgenticReplyVerifier = (credential: Record<string, unknown>) => Promise<AgenticReplyVerification> | AgenticReplyVerification;
/** A pattern conformance declared by a reply block (Rule 3 — the handler-cache key). */
export interface PatternConformance {
    /** The pattern's stable IRI (`https://w3id.org/jeswr/agentic/patterns/…`). */
    readonly iri: string;
    /** The declared `sha256:` content-address of the pattern document, when present. */
    readonly protocolHash?: string;
}
/** The result of extracting a message's AgenticReply blocks. */
export interface AgenticReplyExtraction {
    readonly interpretations: readonly Interpretation[];
    /** Every `dct:conformsTo` pattern declared across the blocks (deduped by IRI). */
    readonly patterns: readonly PatternConformance[];
    /** True iff at least one block's signature VERIFIED via the injected verifier. */
    readonly verified: boolean;
    /** The verified issuer (from the first verified block), when any. */
    readonly issuer?: string;
}
/**
 * SYNC structural extraction — no verifier, so every block is treated UNVERIFIED
 * (all SelfReported, no issuer). This is what the sync
 * {@link import("./interpreter.js").StructuredMetadataInterpreter} seam runs;
 * use {@link extractAgenticReply} with an injected verifier to land verified,
 * auto-lane-eligible interpretations.
 */
export declare function extractAgenticReplyStructural(blocks: readonly string[] | undefined, ctx: InterpretContext): AgenticReplyExtraction;
/**
 * Extract one message's AgenticReply blocks into reliability-tagged interpretations,
 * awaiting the injected verifier per block when one is supplied. Never throws:
 * malformed blocks are skipped, and a throwing/rejecting verifier counts as
 * unverified (fail-closed).
 */
export declare function extractAgenticReply(blocks: readonly string[] | undefined, ctx: InterpretContext, options?: {
    readonly verify?: AgenticReplyVerifier;
}): Promise<AgenticReplyExtraction>;
//# sourceMappingURL=agentic-reply.d.ts.map