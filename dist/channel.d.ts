/**
 * The {@link ChannelAdapter} seam (LEGACY-INTEROP.md §7) — the channel-plural
 * boundary. Email is the first channel; Slack / Matrix / Gmail-API adapters are M2.
 *
 * SECURITY CONTRACT for any LIVE adapter (M2): the remote (an IMAP/Gmail/Graph/Slack
 * endpoint) is a USER-CONFIGURED, UNTRUSTED remote — a classic SSRF surface. Every
 * remote read MUST go through `@jeswr/guarded-fetch`'s node pinning fetch
 * (https-only, private/loopback/metadata-blocked, DNS-pinned, redirect-refusing),
 * and any channel access token rides ONLY on that guarded request as a header —
 * never logged, never persisted, never in a URL. The POD write is the user's own
 * trusted origin and uses the caller's injectable authed `fetch` (see `importInbound`).
 *
 * M1 ships the interface + a hermetic {@link InMemoryChannelAdapter} (no network) so
 * the whole pipeline is unit-testable without a live server or credentials.
 */
import type { BuiltReply } from "./reply.js";
/** One raw inbound message pulled from a channel. */
export interface InboundRawMessage {
    /**
     * A channel-scoped, STABLE id for this message (e.g. an email Message-ID, a Slack
     * ts). Folded (base64url) into the in-pod resource slug, so it must be stable
     * across re-pulls for idempotent re-sync. Untrusted — never used unescaped.
     */
    readonly id: string;
    /** The raw message bytes/text (verbatim — the byte-exact provenance anchor). */
    readonly raw: string | Uint8Array;
}
/** Where to send a structured reply. */
export interface ReplyTarget {
    /** The recipient handle in the channel's namespace (e.g. an email address). */
    readonly to: string;
    /** The inbound message id this reply answers, when applicable. */
    readonly inReplyToId?: string;
}
/** A channel adapter: pull inbound messages, optionally send structured replies. */
export interface ChannelAdapter {
    /** The channel name (e.g. `"email"`) — written as `agentic:channel`. */
    readonly channel: string;
    /** Pull the batch of inbound messages to import. */
    pullInbound(): Promise<readonly InboundRawMessage[]>;
    /** Send a structured reply (optional — a read-only adapter omits it). */
    sendReply?(target: ReplyTarget, reply: BuiltReply): Promise<void>;
}
/**
 * A hermetic, in-memory reference {@link ChannelAdapter} — no network. Seed it with
 * a fixed set of inbound messages; sent replies are recorded on {@link sent}. Used
 * by the tests (and any offline dry-run) to exercise the whole pipeline.
 */
export declare class InMemoryChannelAdapter implements ChannelAdapter {
    readonly channel: string;
    /** Replies captured by {@link sendReply}, in order. */
    readonly sent: Array<{
        target: ReplyTarget;
        reply: BuiltReply;
    }>;
    private readonly messages;
    constructor(channel: string, messages: readonly InboundRawMessage[]);
    pullInbound(): Promise<readonly InboundRawMessage[]>;
    sendReply(target: ReplyTarget, reply: BuiltReply): Promise<void>;
}
//# sourceMappingURL=channel.d.ts.map