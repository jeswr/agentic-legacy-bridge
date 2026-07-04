/**
 * The SLACK {@link ChannelAdapter} (M2-DESIGN.md §1.1) — a pure, hostile-input-
 * hardened transform ({@link slackEventToBridgeMessage}) from a Slack Events API
 * delivery (or a `conversations.history` message row) into the channel-neutral
 * {@link BridgeMessage}, plus a thin {@link SlackChannelAdapter} that plugs into the
 * M2.0 pipeline unchanged (`parse` = the transform).
 *
 * ## The event is UNTRUSTED end-to-end
 *
 * Everything in a Slack delivery is attacker-influenceable. The transform therefore:
 *  - **never crashes / never hangs** — every field is read defensively, the input is
 *    byte-capped before JSON parse, and every id/ts regex is ANCHORED + linear (no
 *    nested quantifier → no ReDoS). The ONLY throw is {@link SlackParseError} (a
 *    {@link ChannelParseError}) for a refused input, which `importInbound` treats as
 *    "skip this message, never abort the batch";
 *  - keeps `textBody` **plain text ONLY** — Slack `text` is mrkdwn, treated as opaque
 *    plain text (control-stripped, capped); `blocks`/attachments/rich content are
 *    NEVER flattened into HTML or persisted (the stored-XSS class the estate guards
 *    against — the `matrix-chat-to-pod` lesson);
 *  - **validates the `team`/`user` ids before they mint a URN** (`^T…`/`^[UW]…`
 *    shapes). An over-cap / out-of-shape id yields NO sender handle, so
 *    `personIriFor` falls back to a provisional anon node (fail-closed per M2.0) —
 *    an id carrying an IRIREF-forbidden char can never reach a `namedNode()`.
 *
 * The remote read side (the live `conversations.history` backfill and the webhook
 * receiver) is NOT built here — M2.1 is the PARSE transform only. When it lands
 * (M2.4) every remote read MUST go through `@jeswr/guarded-fetch`'s node pinning
 * fetch and the bot token rides only as a header on that guarded request, per the
 * {@link ChannelAdapter} security contract.
 *
 * ## Events API signature-verification contract (for the M2.4 webhook service)
 *
 * The transform authenticates NOTHING about the *source* — a Slack delivery's
 * authenticity is the webhook service's job, verified over the RAW request body
 * BEFORE any JSON parse (M2-DESIGN.md §3.2):
 *
 *  1. **v0 HMAC signature.** `X-Slack-Signature` = `v0=` + hex HMAC-SHA256 over the
 *     string `v0:<X-Slack-Request-Timestamp>:<raw-body>`, keyed by the app's Signing
 *     Secret, compared in CONSTANT TIME. Reject when `|now − X-Slack-Request-
 *     Timestamp| > 300s` (the replay window).
 *  2. **3-second ack.** Slack expects a 2xx within 3 s and retries ×3 (carrying
 *     `X-Slack-Retry-Num` / `X-Slack-Retry-Reason`) otherwise. The service must
 *     verify → transform → create-only pod write → 200 quickly; the LLM pass is
 *     decoupled (M2-DESIGN.md §3.6).
 *  3. **Retry / replay dedupe.** `event_id` (and `ts`) are globally unique, so a
 *     deterministic in-pod slug makes a retried/replayed delivery map to the SAME
 *     URL. NOTE the M2.1 `importInbound` write path is a plain `PUT` (overwrite) and
 *     does NOT itself provide idempotency; the M2.4 service must add create-only
 *     writes (`If-None-Match: *`, treating `412` as already-imported) — the property
 *     the design assigns to the service, not this adapter (M2-DESIGN.md §3.3/§3.4).
 *     No dedupe table is then needed.
 *  4. **`url_verification`.** The endpoint-registration handshake
 *     (`{ type: "url_verification", challenge }`) is answered by the service (echo
 *     `challenge`); it is NOT a message, so this transform REFUSES it
 *     ({@link SlackParseError}) — the service must handle it before calling `parse`.
 *
 * Self-hosters with no public endpoint use **Socket Mode** (the same event envelopes
 * over an outbound WebSocket) — the same transform, a different feed.
 *
 * ## Cross-channel identity hint (deferred, honestly)
 *
 * The design's member-email → `agentic:candidatePerson` bridge (M2-DESIGN.md §1.1)
 * needs a `users.info` lookup (a network call requiring `users:read.email`), so it
 * is NOT part of this pure transform. It is wired at the import layer (a caller
 * `candidateWebIdsFor` / future `candidatePersonIrisFor` hook, fail-closed filtered
 * by `addSenderPerson`) once the live Slack Web API client lands (M2.4) — no change
 * to the M2.0 pipeline.
 */
import type { ChannelAdapter, InboundRawMessage } from "./channel.js";
import { ChannelParseError } from "./errors.js";
import type { BridgeMessage } from "./message.js";
/** The channel name written as `agentic:channel` for a Slack message. */
export declare const SLACK_CHANNEL = "slack";
/** The media type of the byte-exact raw anchor (a Slack event is JSON). */
export declare const SLACK_RAW_MEDIA_TYPE = "application/json";
/**
 * The `metadata.event_type` our own outbound structured replies carry (the Slack
 * rung-3 carrier, M2-DESIGN.md §1.1) — an inbound message with this metadata is read
 * as a bridge-capable counterparty. Its `event_payload` advertises `channels` (the
 * `X-Agentic-Channels` equivalent) and `reply` (the `X-Agentic-Reply` pod-copy URL),
 * mapped into {@link BridgeMessage.signals} for `detectBridgeCapability`.
 */
export declare const SLACK_AGENTIC_METADATA_EVENT_TYPE = "agentic_reply";
/**
 * A controlled, typed, fail-closed refusal (the only throw from
 * {@link slackEventToBridgeMessage}). Extends the channel-neutral
 * {@link ChannelParseError} (M2.0) so `importInbound`'s skip-don't-abort catch is
 * channel-agnostic.
 */
export declare class SlackParseError extends ChannelParseError {
    constructor(message: string);
}
/** Optional context for {@link slackEventToBridgeMessage}. */
export interface SlackParseContext {
    /**
     * The workspace/team id to attribute a message to when the payload itself does
     * NOT carry one (a bare `conversations.history` row has no `event_callback`
     * `team_id` envelope). Validated against the Slack team-id shape before use — an
     * out-of-shape value is ignored, never minted into a URN.
     */
    readonly teamId?: string;
    /**
     * The conversation (channel/DM/group) id to attribute a message to when the
     * payload itself does NOT carry one (a `conversations.history` row is fetched
     * per-conversation, so the channel id lives with the caller, not in the row).
     * Validated against the Slack conversation-id shape; used to make `messageId` /
     * `threadId` workspace-unambiguous (a Slack `ts` is only channel-scoped).
     */
    readonly channelId?: string;
}
/**
 * Parse a raw Slack event (an Events API `event_callback` JSON body, or a
 * `conversations.history` message row) into a channel-neutral {@link BridgeMessage}.
 *
 * Pure + hermetic + fail-closed. The `rawSha256`/`rawByteLength` provenance anchor is
 * computed over the EXACT input bytes (so it matches the byte-exact `.json` anchor
 * `importInbound` stores). The only throw is {@link SlackParseError} for a refused
 * input; everything survivable degrades with a `warnings` entry.
 *
 * @throws {SlackParseError} on an over-cap input, non-JSON / non-object body, a
 *   non-message inner event, a mutation subtype (edit/delete), a missing/invalid
 *   `ts`, or a missing plain-text `text`.
 */
export declare function slackEventToBridgeMessage(raw: string | Uint8Array, ctx?: SlackParseContext): BridgeMessage;
/** Options for {@link SlackChannelAdapter}. */
export interface SlackChannelAdapterOptions {
    /**
     * The workspace/team id to attribute messages to when a raw event lacks one
     * (a `conversations.history` backfill row has no `event_callback` envelope).
     * Passed through to {@link slackEventToBridgeMessage} (validated before use).
     */
    readonly teamId?: string;
    /**
     * The conversation (channel/DM/group) id for a per-conversation backfill whose
     * rows omit it — passed through to {@link slackEventToBridgeMessage} to qualify
     * `messageId`/`threadId` (validated before use). An event that carries its own
     * `channel` overrides this.
     */
    readonly channelId?: string;
    /**
     * Raw Slack events already received (a webhook delivery batch, a backfill page).
     * The default {@link pullInbound} returns these verbatim. Each is parsed by
     * {@link parse} — the same hardened transform the live webhook receiver will call.
     */
    readonly messages?: readonly InboundRawMessage[];
    /**
     * An injectable live puller (e.g. `conversations.history` paged through
     * `@jeswr/guarded-fetch`). When provided it supersedes {@link messages}. NOT
     * built in M2.1 (the transform-only phase) — this is the seam the M2.4 backfill
     * client plugs into WITHOUT touching this class.
     */
    readonly pull?: () => Promise<readonly InboundRawMessage[]>;
}
/**
 * The Slack {@link ChannelAdapter}: `parse` is {@link slackEventToBridgeMessage}, so
 * a Slack workspace plugs into the M2.0 `importInbound` pipeline with zero pipeline
 * changes (owner-private write of the byte-exact `.json` anchor + agentic graph +
 * canonical chat message, channel-scoped person URN, deterministic interpretations).
 *
 * Read-only in M2.1 — `sendReply` (the `chat.postMessage` `metadata.event_payload`
 * structured carrier, see the module doc) is the M2.4 live-transport phase.
 */
export declare class SlackChannelAdapter implements ChannelAdapter {
    readonly channel = "slack";
    private readonly teamId;
    private readonly channelId;
    private readonly messages;
    private readonly pullFn;
    constructor(options?: SlackChannelAdapterOptions);
    parse(item: InboundRawMessage): BridgeMessage;
    pullInbound(): Promise<readonly InboundRawMessage[]>;
}
//# sourceMappingURL=slack.d.ts.map