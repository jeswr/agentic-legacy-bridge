/**
 * Typed shapes for a parsed inbound email. The ENTIRE input is untrusted, so every
 * field here is the RESULT of hardened parsing — display names/subject/body are
 * decoded then control-stripped, addresses are best-effort extracted (validity is
 * re-checked downstream before an address becomes an identity key or `mailto:` IRI),
 * and the raw bytes are never re-emitted (only their digest travels, as the
 * provenance anchor).
 */
/** A parsed address: the extracted addr-spec plus an optional decoded display name. */
export interface EmailAddress {
    /**
     * The extracted `local@domain` addr-spec (control-stripped, trimmed). NOT
     * guaranteed RFC-valid — downstream code MUST re-validate (via
     * `isValidEmailAddress` / `safeMailtoIri`) before trusting it as an identity key.
     */
    readonly address: string;
    /** The decoded, control-stripped display name (`"Jane Doe"`), when present. */
    readonly displayName?: string;
}
/**
 * A parsed email message — the typed output of {@link parseEmail}. Deliberately
 * flat and small: a server/bridge needs the envelope + a plain-text body, not a
 * faithful MIME tree. HTML is never surfaced as HTML (the stored-XSS lesson) — the
 * body is always plain text.
 */
export interface EmailMessage {
    /** The `From:` sender (first address), if parseable. */
    readonly from?: EmailAddress;
    /** `To:` recipients (possibly empty). */
    readonly to: readonly EmailAddress[];
    /** `Cc:` recipients (possibly empty). */
    readonly cc: readonly EmailAddress[];
    /** `Reply-To:` addresses (possibly empty). */
    readonly replyTo: readonly EmailAddress[];
    /** Decoded, control-stripped `Subject:`. */
    readonly subject?: string;
    /** `Date:` as an ISO-8601 string, if parseable; omitted otherwise. */
    readonly date?: string;
    /** The `Message-ID` token WITHOUT its angle brackets (an email token, NOT an http IRI). */
    readonly messageId?: string;
    /** The `In-Reply-To` token WITHOUT its angle brackets. */
    readonly inReplyTo?: string;
    /**
     * The DKIM `d=` signing domain CLAIMED by the `DKIM-Signature` header. **Unverified
     * in M1** — the bridge reads the claimed domain but does NOT cryptographically
     * verify the signature, so this is a low-trust signal, never an identity proof.
     */
    readonly dkimDomain?: string;
    /** The best-effort plain-text body (decoded, control-stripped, size-capped). */
    readonly textBody: string;
    /**
     * Raw `<script type="application/ld+json">` block contents found in a text/html
     * part, plus any `application/ld+json` MIME parts (metadata-protocol Rule 1 —
     * Gmail email-markup / an embedded AgenticReply carrier). UNTRUSTED JSON text:
     * control-stripped + count/size-capped at parse time, but NOT yet parsed or
     * validated — the deterministic metadata extractors do that, fail-closed.
     * Present only when at least one block was found. This is DATA, not markup —
     * the no-stored-HTML rule is untouched (no HTML is ever surfaced).
     */
    readonly jsonLdBlocks?: readonly string[];
    /**
     * Decoded `text/calendar` MIME part texts (RFC 5545 — meeting invites /
     * updates / cancellations). UNTRUSTED text: control-stripped + count/size-
     * capped at parse time; parsed fail-closed by the deterministic iCal
     * extractor. Present only when at least one part was found.
     */
    readonly calendarParts?: readonly string[];
    /** All decoded, unfolded headers as `[lower-cased-name, value]` pairs (order preserved). */
    readonly headers: ReadonlyArray<readonly [string, string]>;
    /** The lower-case hex SHA-256 of the raw input bytes — the provenance anchor digest. */
    readonly rawSha256: string;
    /** The raw input byte length. */
    readonly rawByteLength: number;
    /** Non-fatal issues encountered while parsing (caps hit, decode fallbacks, …). */
    readonly warnings: readonly string[];
}
//# sourceMappingURL=types.d.ts.map