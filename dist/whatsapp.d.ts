/**
 * The WHATSAPP (Business Cloud API) {@link ChannelAdapter} (M2-DESIGN.md §1.2) — a
 * pure, hostile-input-hardened transform ({@link waMessageToBridgeMessage}) from a
 * WhatsApp Cloud webhook delivery (its `entry[].changes[].value.messages[]` entry)
 * into the channel-neutral {@link BridgeMessage}, plus a thin
 * {@link WhatsAppChannelAdapter} that plugs into the M2.0 pipeline unchanged
 * (`parse` = the transform). Mirrors the M2.1 Slack adapter's posture exactly.
 *
 * ## Positioning — the BUSINESS / hosted persona ONLY
 *
 * PERSONAL WhatsApp (and Signal / Telegram) stay on the `@jeswr/matrix-chat-to-pod`
 * (mautrix → Matrix) path — already the working inbound path for personal accounts.
 * This native adapter serves ONLY the org-run bridge persona: a business / front-desk
 * agent with a WhatsApp Business Account (WABA), where webhook-native inbound + the
 * official send API matter. Do NOT route personal accounts here (M2-DESIGN.md §1.2).
 *
 * ## The webhook payload is UNTRUSTED end-to-end
 *
 * Everything in a Meta webhook delivery is attacker-influenceable. The transform
 * therefore:
 *  - **never crashes / never hangs** — every field is read defensively, the input is
 *    byte-capped BEFORE JSON parse, and every id/number regex is ANCHORED + linear
 *    (single char class, bounded quantifier → no nested quantifier → no ReDoS). The
 *    ONLY throw is {@link WhatsAppParseError} (a {@link ChannelParseError}) for a
 *    refused input, which `importInbound` treats as "skip this message, never abort
 *    the batch";
 *  - keeps `textBody` **plain text ONLY** — only a `type: "text"` message's
 *    `text.body` is retained (control-stripped, capped). Interactive / template /
 *    button / media / location / reaction messages carry NO plain-text body, so they
 *    are REFUSED (skipped) — their content is NEVER flattened into markup or
 *    persisted (the stored-XSS class the estate guards against — the
 *    `matrix-chat-to-pod` lesson). Media handling (record metadata, never fetch at
 *    webhook time) is a later phase (M2-DESIGN.md §1.2);
 *  - **validates the `from` / `wa_id` phone-number handle before it mints anything**
 *    (digits, bounded). An out-of-shape handle yields NO sender, so `personIriFor`
 *    falls back to a provisional anon node (fail-closed per M2.0) — a handle carrying
 *    an IRIREF-forbidden char can never reach a `namedNode()` (it is base64url-folded
 *    into the person URN regardless, but the shape gate keeps garbage out of the
 *    identity graph entirely);
 *  - mints a `tel:` IRI candidate ONLY via {@link waIdToTelIri} — strict E.164, the
 *    `safeMailtoIri` sibling — so an attacker-controlled `wa_id` can never inject a
 *    malformed `tel:` IRI (see below).
 *
 * The remote read side does not exist for WhatsApp: **there is no history-poll API**
 * for arbitrary past messages — inbound is webhook-only (Meta pushes). So the
 * {@link WhatsAppChannelAdapter}'s `pullInbound` returns only already-received
 * deliveries (a webhook batch); there is no backfill `pull` analogue to Slack's
 * `conversations.history`. M2.2 is the PARSE transform only; the live webhook
 * receiver (verify → transform → owner-private create-only pod write) is M2.4.
 *
 * ## Webhook signature-verification contract (for the M2.4 webhook service)
 *
 * The transform authenticates NOTHING about the *source* — a Meta delivery's
 * authenticity is the webhook service's job, verified over the RAW request body
 * BEFORE any JSON parse (M2-DESIGN.md §3.2), and endpoint registration is answered
 * before any message parse:
 *
 *  1. **Endpoint registration (`GET`).** Meta sends `GET` with `hub.mode=subscribe`,
 *     `hub.verify_token`, and `hub.challenge`. The service echoes `hub.challenge`
 *     back as the plain-text response body IFF `hub.verify_token` equals the
 *     configured verify token (a CONSTANT-TIME compare). This is a GET query, not a
 *     message body — it never reaches this transform.
 *  2. **`X-Hub-Signature-256` HMAC.** Every delivery `POST` carries
 *     `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(RAW body, App Secret)>`. The
 *     service recomputes the HMAC over the EXACT raw request bytes (before any JSON
 *     parse) and compares in CONSTANT TIME; a mismatch is answered `401` with no body
 *     detail and nothing written or logged beyond a counter (don't hand a prober an
 *     oracle). The App Secret lives ONLY in the service env — never in a URL, a log,
 *     or a pod resource.
 *  3. **Retry / replay dedupe.** Meta retries a failed delivery aggressively (over
 *     ~36 hours), so idempotent handling is MANDATORY — but the `id` (wamid) is
 *     GLOBALLY unique, so a deterministic in-pod slug keyed on the wamid maps a
 *     retried / replayed delivery to the SAME URL. NOTE the M2.1 `importInbound`
 *     write path is a plain `PUT` (overwrite) and does NOT itself provide
 *     idempotency; the M2.4 service must add create-only writes (`If-None-Match: *`,
 *     treating `412` as already-imported) — the property the design assigns to the
 *     service, not this adapter (M2-DESIGN.md §3.3/§3.4). No dedupe table is needed.
 *  4. **Batching / fan-out.** Unlike a Slack Events API delivery (one message per
 *     delivery), ONE Meta webhook body can carry MANY messages
 *     (`entry[].changes[].value.messages[]`). This transform parses ONE message per
 *     call — selected by {@link WhatsAppParseContext.messageIndex} (default 0) over
 *     the SAME raw bytes — so the M2.4 service fans a multi-message delivery out by
 *     calling the transform once per index (each yields a distinct
 *     `messageId`/wamid; all share the one signed-delivery `rawSha256` anchor, which
 *     is honest — they arrived in one authenticated delivery). A multi-message body
 *     records a `warnings` entry so the fan-out is visible.
 *
 * ## No structured-reply / capability carrier on WhatsApp
 *
 * WhatsApp has NO metadata / HTML carrier — replies are plain text (+ interactive
 * types) and free-form replies are only allowed inside the 24-hour customer-service
 * window (M2-DESIGN.md §1.2/§1.3). So `signals` is ALWAYS empty here (a WhatsApp
 * message can never advertise bridge capability inline; capabilities are read from
 * the pod copy at the negotiation layer, out of this transform's scope), and the
 * structured carrier degrades to the pod-copy pointer form — assembled by
 * `buildReply`/`sendReply` at the M2.4 send phase, NOT here. `sendReply` (when built)
 * MUST refuse to send free-form outside the 24-hour service window.
 */
import type { ChannelAdapter, InboundRawMessage } from "./channel.js";
import { ChannelParseError } from "./errors.js";
import type { BridgeMessage } from "./message.js";
/** The channel name written as `agentic:channel` for a WhatsApp message. */
export declare const WHATSAPP_CHANNEL = "whatsapp";
/** The media type of the byte-exact raw anchor (a Meta webhook body is JSON). */
export declare const WHATSAPP_RAW_MEDIA_TYPE = "application/json";
/**
 * A controlled, typed, fail-closed refusal (the only throw from
 * {@link waMessageToBridgeMessage}). Extends the channel-neutral
 * {@link ChannelParseError} (M2.0) so `importInbound`'s skip-don't-abort catch is
 * channel-agnostic.
 */
export declare class WhatsAppParseError extends ChannelParseError {
    constructor(message: string);
}
/** Optional context for {@link waMessageToBridgeMessage}. */
export interface WhatsAppParseContext {
    /**
     * WHICH message to parse when the delivery carries more than one
     * (`entry[].changes[].value.messages[]` flattened in order). Default `0`. The
     * M2.4 webhook service fans a multi-message delivery out by calling the transform
     * once per index over the SAME raw bytes. An out-of-range index throws
     * {@link WhatsAppParseError} (there is no such message to import). Negative /
     * non-integer values are treated as `0`.
     */
    readonly messageIndex?: number;
}
/**
 * Build an injection-safe `tel:` IRI CANDIDATE (RFC 3966 global-number form) from a
 * WhatsApp `wa_id` — the phone-keyed sibling of email's `safeMailtoIri` (M2-DESIGN.md
 * §1.2). A `wa_id` is the customer's phone number WITHOUT the leading `+`, so this
 * prepends `+` and delegates to the strict-E.164 {@link safeTelIri} (which fails
 * closed on anything but `+` and 7–15 digits, first digit non-zero). Returns the
 * `tel:` IRI, or `undefined` when the handle is not a usable E.164 number.
 *
 * This is a PURE seam: M2.2 is the PARSE transform only, and the person → RDF path
 * (`addSenderPerson`) records a channel-scoped handle as a `schema:identifier`
 * literal EXACTLY as for Slack — the pipeline is unchanged. The `schema:telephone`
 * `tel:` edge the design describes (M2-DESIGN.md §1.2) is wired at the sender/import
 * layer via this helper WITHOUT touching the M2.0 pipeline — the same deferral posture
 * M2.1 used for its candidate-email → `agentic:candidatePerson` hint.
 */
export declare function waIdToTelIri(waId: unknown): string | undefined;
/**
 * Parse a raw WhatsApp Cloud webhook delivery into a channel-neutral
 * {@link BridgeMessage}, selecting ONE message ({@link WhatsAppParseContext.messageIndex},
 * default 0) from the delivery's flattened `messages[]`.
 *
 * Pure + hermetic + fail-closed. The `rawSha256`/`rawByteLength` provenance anchor is
 * computed over the EXACT input bytes (so it matches the byte-exact `.json` anchor
 * `importInbound` stores). Only a `type: "text"` message is importable — a non-text
 * (interactive / media / location / reaction / template) message carries no
 * plain-text body and is REFUSED (skipped). The only throw is
 * {@link WhatsAppParseError} for a refused input; everything survivable degrades with
 * a `warnings` entry.
 *
 * @throws {WhatsAppParseError} on an over-cap input, non-JSON / non-object body, a
 *   delivery with no importable `messages`, an out-of-range `messageIndex`, a
 *   non-text message type, a missing/invalid `id` (wamid), or a missing plain-text
 *   `text.body`.
 */
export declare function waMessageToBridgeMessage(raw: string | Uint8Array, ctx?: WhatsAppParseContext): BridgeMessage;
/** Options for {@link WhatsAppChannelAdapter}. */
export interface WhatsAppChannelAdapterOptions {
    /**
     * Raw WhatsApp webhook deliveries already received (a webhook batch). The default
     * {@link WhatsAppChannelAdapter.pullInbound} returns these verbatim. Each is parsed
     * by {@link WhatsAppChannelAdapter.parse} — the same hardened transform the live
     * webhook receiver will call.
     *
     * NOTE each {@link InboundRawMessage} is ONE message (`raw` = the delivery bytes,
     * `id` = the wamid). A multi-message delivery is fanned out at the SERVICE layer
     * (M2.4) into one {@link InboundRawMessage} per message (all sharing the delivery
     * bytes; each parsed with its own {@link WhatsAppParseContext.messageIndex}); this
     * transform-only phase does not fan out.
     */
    readonly messages?: readonly InboundRawMessage[];
    /**
     * An injectable puller. WhatsApp has NO history-poll API, so there is no backfill
     * analogue to Slack's `conversations.history` — this exists only so a self-hosted
     * deployment can feed already-received deliveries from its own queue. When provided
     * it supersedes {@link messages}. NOT built in M2.2 (the transform-only phase).
     */
    readonly pull?: () => Promise<readonly InboundRawMessage[]>;
    /**
     * The message index within each raw delivery to parse (default 0). Passed through
     * to {@link waMessageToBridgeMessage}. A pre-fanned-out feed (one message per raw)
     * leaves this 0.
     */
    readonly messageIndex?: number;
}
/**
 * The WhatsApp {@link ChannelAdapter}: `parse` is {@link waMessageToBridgeMessage}, so
 * a WhatsApp Business webhook plugs into the M2.0 `importInbound` pipeline with zero
 * pipeline changes (owner-private write of the byte-exact `.json` anchor + agentic
 * graph + canonical chat message, channel-scoped `urn:agentic:person:whatsapp:…` URN,
 * deterministic interpretations).
 *
 * Read-only in M2.2 — `sendReply` (the pod-copy-pointer reply, 24-hour service-window
 * refusal) is the M2.4 live-transport phase.
 */
export declare class WhatsAppChannelAdapter implements ChannelAdapter {
    readonly channel = "whatsapp";
    private readonly messages;
    private readonly pullFn;
    private readonly messageIndex;
    constructor(options?: WhatsAppChannelAdapterOptions);
    parse(item: InboundRawMessage): BridgeMessage;
    pullInbound(): Promise<readonly InboundRawMessage[]>;
}
//# sourceMappingURL=whatsapp.d.ts.map