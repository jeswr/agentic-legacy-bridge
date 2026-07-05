/**
 * `BridgeMessage` — the CHANNEL-NEUTRAL parsed inbound message (M2-DESIGN.md
 * §M2.0): what {@link EmailMessage} already is, minus the email-isms. This is the
 * one shape the whole pipeline (interpret → graph → canonical → persist) runs on,
 * so adding a channel means writing ONE pure `parse` transform — never a copy of
 * the pipeline.
 *
 * Every field is UNTRUSTED (the channel remote is hostile end-to-end); a
 * `BridgeMessage` is the output of a HARDENED channel parse (control-stripped
 * text, plain-text-only body — the stored-XSS rule — and best-effort envelope
 * fields that downstream code re-validates before minting any IRI from them).
 *
 * Email maps 1:1 via {@link toBridgeMessage}; `EmailMessage` stays exported and
 * the `./email` subexport is untouched. The widened pipeline entry points accept
 * `BridgeMessage | EmailMessage` (via {@link asBridgeMessage}) so every M1 call
 * site keeps working unchanged.
 */
import type { EmailMessage } from "./email/types.js";
/** The channel-namespace sender handle — UNTRUSTED (a `From:` authenticates nothing). */
export interface BridgeSender {
    /**
     * The sender's handle in the channel's own namespace — an email addr-spec, a
     * Slack `team:user` pair, a WhatsApp `wa_id`. NOT validated here; downstream
     * code re-validates before the handle becomes an identity key or an IRI
     * (`normalizeEmailAddress` / `safeMailtoIri` / `safeTelIri`).
     */
    readonly handle: string;
    /** The decoded, control-stripped display name, when the channel carries one. */
    readonly displayName?: string;
}
/** The channel-neutral parsed inbound message (M2-DESIGN.md §M2.0). */
export interface BridgeMessage {
    /** The channel this arrived on (`"email"` | `"slack"` | `"whatsapp"` | …). */
    readonly channel: string;
    /** The sender, when the channel identifies one. UNTRUSTED. */
    readonly sender?: BridgeSender;
    /** The plain-text body ONLY (the stored-XSS rule) — decoded, control-stripped, capped. */
    readonly textBody: string;
    /** Email subject / thread title; absent on channels without one. */
    readonly subject?: string;
    /** The sender-claimed date as ISO-8601, when parseable. */
    readonly date?: string;
    /** A channel-stable message id (email Message-ID / Slack event `ts` / a wamid). */
    readonly messageId?: string;
    /** The thread linkage (email In-Reply-To / Slack `thread_ts` / WA `context.id`). */
    readonly threadId?: string;
    /**
     * The transport-authentication domain CLAIMED by the channel (email's DKIM
     * `d=`). UNVERIFIED — a low-trust signal only, carried so the email path's
     * graph output is unchanged through the adapter seam. Channels without an
     * analogue omit it.
     */
    readonly dkimDomainClaim?: string;
    /**
     * The channel-neutral header-map equivalent feeding `detectBridgeCapability`
     * (email headers / Slack message-metadata fields / pod-copy-derived fields).
     * Lower-cased keys, first occurrence wins (a later duplicate can never
     * override), null-prototype-safe on construction.
     */
    readonly signals: Readonly<Record<string, string>>;
    /** The lower-case hex SHA-256 of the raw input bytes — the provenance anchor digest. */
    readonly rawSha256: string;
    /** The raw input byte length. */
    readonly rawByteLength: number;
    /** The media type of the raw bytes (`"message/rfc822"` | `"application/json"` | …). */
    readonly rawMediaType: string;
    /** Non-fatal issues encountered while parsing. */
    readonly warnings: readonly string[];
    /**
     * Machine-readable JSON-LD block texts the channel carried (email: embedded
     * `<script type="application/ld+json">` + `application/ld+json` MIME parts).
     * UNTRUSTED, capped; consumed by the deterministic metadata extractors
     * (metadata-protocol Rule 1). Channels without an analogue omit it.
     */
    readonly jsonLdBlocks?: readonly string[];
    /** `text/calendar` (RFC 5545) part texts the channel carried. UNTRUSTED, capped. */
    readonly calendarParts?: readonly string[];
}
/**
 * Map a parsed {@link EmailMessage} 1:1 onto the channel-neutral shape —
 * email is the FIRST channel. `sender` comes from `From:`, `signals` from the
 * header map (names are already lower-cased by the parser; the FIRST occurrence
 * of a duplicated header wins, so an appended duplicate can never override the
 * original), `threadId` from `In-Reply-To`, `rawMediaType` is `message/rfc822`.
 */
export declare function toBridgeMessage(email: EmailMessage): BridgeMessage;
/**
 * Discriminate the widened pipeline union. A {@link BridgeMessage} carries the
 * required `channel` + `rawMediaType` strings; an {@link EmailMessage} carries
 * neither.
 */
export declare function isBridgeMessage(message: BridgeMessage | EmailMessage): message is BridgeMessage;
/**
 * Normalise a widened pipeline input to the channel-neutral shape: a
 * {@link BridgeMessage} passes through unchanged; an {@link EmailMessage} is
 * mapped via {@link toBridgeMessage} (so every M1 `EmailMessage` call site
 * behaves identically through the new seam).
 */
export declare function asBridgeMessage(message: BridgeMessage | EmailMessage): BridgeMessage;
//# sourceMappingURL=message.d.ts.map