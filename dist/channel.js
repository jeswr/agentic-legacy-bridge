// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
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
/**
 * A hermetic, in-memory reference {@link ChannelAdapter} — no network. Seed it with
 * a fixed set of inbound messages; sent replies are recorded on {@link sent}. Used
 * by the tests (and any offline dry-run) to exercise the whole pipeline.
 */
export class InMemoryChannelAdapter {
    channel;
    /** Replies captured by {@link sendReply}, in order. */
    sent = [];
    messages;
    constructor(channel, messages) {
        this.channel = channel;
        this.messages = messages;
    }
    pullInbound() {
        return Promise.resolve(this.messages);
    }
    sendReply(target, reply) {
        this.sent.push({ target, reply });
        return Promise.resolve();
    }
}
//# sourceMappingURL=channel.js.map