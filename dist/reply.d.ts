/**
 * Rung 3 (LEGACY-INTEROP.md §4) — build the STRUCTURED, machine-readable carrier
 * embedded alongside the human prose in an outbound reply.
 *
 * The design's endorsed carrier (recorded in `docs/DECISIONS.md`): an **inline
 * JSON-LD** block (Gmail's own markup path — survives forwarding), signed as a
 * `@jeswr/solid-vc` Verifiable Credential **over the canonicalised graph** (so the
 * proof holds even if a mail client re-flows the HTML), plus a `multipart/alternative`
 * `application/ld+json` fallback part and an `X-Agentic-Reply` header pointing at the
 * authoritative pod copy. The onboarding link (§5) is the ratchet's teeth.
 *
 * M1 builds the carrier + wires an INJECTABLE `sign` seam (so tests are hermetic and
 * no crypto dependency is pulled in); the concrete `solid-vc` Data-Integrity signer
 * is the M2 adapter. Without a signer the payload is an honest UNSIGNED reply (it does
 * NOT claim the `VerifiableCredential` type). Every URL is injection-validated; the
 * inline JSON is HTML-escaped so it cannot break out of the `<script>` element.
 */
/** A proposed meeting time in the reply (a `schema:Event`). */
export interface OfferedTime {
    /** Event name/summary (control-stripped, capped). */
    readonly name?: string;
    /** Start time — MUST be a valid ISO-8601 datetime (else the offer is dropped). */
    readonly startTime: string;
    /** End time — optional ISO-8601 datetime. */
    readonly endTime?: string;
}
/** A signer that attaches a Data Integrity proof over the credential's canonical graph. */
export type ReplySigner = (credential: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
/** Options for {@link buildReply}. */
export interface BuildReplyOptions {
    /** The raw-message anchor (a `urn:agentic:raw:…`) this reply answers. */
    readonly inReplyTo: string;
    /** Proposed meeting times to offer (each a `schema:Event`). */
    readonly offeredTimes?: readonly OfferedTime[];
    /** The authoritative pod-hosted copy URL (→ `X-Agentic-Reply` + a body link). http(s) only. */
    readonly podCopyUrl?: string;
    /** The onboarding entry URL (§5). http(s) only. */
    readonly onboardingUrl?: string;
    /** The replying agent's issuer WebID (the VC issuer). http(s) only. */
    readonly issuer?: string;
    /**
     * An injectable signer. When provided, the credential is signed (Data Integrity
     * over the canonical graph — the M2 `solid-vc` adapter) and typed
     * `VerifiableCredential`. When absent, the payload is an honest UNSIGNED reply.
     */
    readonly sign?: ReplySigner;
}
/** A MIME part (for `multipart/alternative`). */
export interface MimePart {
    readonly contentType: string;
    readonly body: string;
}
/** The assembled reply carrier. */
export interface BuiltReply {
    /** The JSON-LD credential (with a `proof` iff a signer was supplied). */
    readonly credential: Record<string, unknown>;
    /** True iff the credential carries a Data Integrity proof. */
    readonly signed: boolean;
    /** An HTML-safe `<script type="application/ld+json">…</script>` block for the body. */
    readonly inlineHtml: string;
    /** The `application/ld+json` fallback part for `multipart/alternative`. */
    readonly mimePart: MimePart;
    /** Reply headers (`X-Agentic-Reply` → the pod copy) — safe, single-line values only. */
    readonly headers: Readonly<Record<string, string>>;
    /** A plain-text onboarding block for the human body, when an onboarding URL was given. */
    readonly onboardingBlock?: string;
}
/**
 * Build the structured reply carrier. Pure + hermetic (the only async is an optional
 * injected signer). Invalid offered times are dropped; unsafe URLs are omitted.
 */
export declare function buildReply(options: BuildReplyOptions): Promise<BuiltReply>;
/**
 * Produce a `<script>`-safe form of a JSON string. Valid JSON escapes for `<`, `>`,
 * `&` and the JS line separators keep the JSON well-formed while making it impossible
 * to close the `<script>` element or open a comment/CDATA sequence — the canonical
 * JSON-in-HTML-script XSS guard.
 */
export declare function htmlSafeJson(json: string): string;
//# sourceMappingURL=reply.d.ts.map