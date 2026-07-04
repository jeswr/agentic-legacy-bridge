// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
// M2.0 channel-neutral generalisation AUTHORED-BY Claude Fable 5.
/**
 * The {@link ChannelAdapter} seam (LEGACY-INTEROP.md §7, M2-DESIGN.md §M2.0) — the
 * channel-plural boundary. Email is the FIRST channel (its adapter parse is
 * {@link parseEmailInbound}); Slack / WhatsApp / Gmail-API adapters are the M2.1+
 * channels that plug into the same interface.
 *
 * SECURITY CONTRACT for any LIVE adapter (M2): the remote (an IMAP/Gmail/Graph/Slack
 * endpoint) is a USER-CONFIGURED, UNTRUSTED remote — a classic SSRF surface. Every
 * remote read MUST go through `@jeswr/guarded-fetch`'s node pinning fetch
 * (https-only, private/loopback/metadata-blocked, DNS-pinned, redirect-refusing),
 * and any channel access token rides ONLY on that guarded request as a header —
 * never logged, never persisted, never in a URL. The POD write is the user's own
 * trusted origin and uses the caller's injectable authed `fetch` (see `importInbound`).
 *
 * `parse` is the channel-specific HARDENED transform raw → {@link BridgeMessage}
 * (pure, hermetically testable). It throws (a subclass of) `ChannelParseError` for
 * an input it refuses — `importInbound` skips that message, never aborts the batch.
 *
 * M1 ships the interface + a hermetic {@link InMemoryChannelAdapter} (no network) so
 * the whole pipeline is unit-testable without a live server or credentials.
 */
import { parseEmail } from "./email/index.js";
import { toBridgeMessage } from "./message.js";
/**
 * The EMAIL channel's `parse` — email is the first {@link ChannelAdapter}: the
 * hardened RFC 5322 / MIME parse ({@link parseEmail}) mapped 1:1 onto the
 * channel-neutral shape ({@link toBridgeMessage}). Throws `EmailParseError`
 * (a `ChannelParseError`) on an over-cap input, exactly as in M1.
 */
export function parseEmailInbound(item) {
    return toBridgeMessage(parseEmail(item.raw));
}
/**
 * A hermetic, in-memory reference {@link ChannelAdapter} — no network. Seed it with
 * a fixed set of inbound messages; sent replies are recorded on {@link sent}. Used
 * by the tests (and any offline dry-run) to exercise the whole pipeline.
 *
 * The channel `parse` is injectable; when omitted it defaults to the email parse
 * ({@link parseEmailInbound}) for `channel === "email"` ONLY — a non-email channel
 * without an explicit parse is a construction error (fail-fast, never a silently
 * mis-channelled message).
 */
export class InMemoryChannelAdapter {
    channel;
    /** Replies captured by {@link sendReply}, in order. */
    sent = [];
    messages;
    parseFn;
    constructor(channel, messages, parse) {
        this.channel = channel;
        this.messages = messages;
        if (parse !== undefined) {
            this.parseFn = parse;
        }
        else if (channel === "email") {
            this.parseFn = parseEmailInbound;
        }
        else {
            throw new TypeError("InMemoryChannelAdapter: a non-email channel requires an explicit parse function.");
        }
    }
    parse(item) {
        return this.parseFn(item);
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