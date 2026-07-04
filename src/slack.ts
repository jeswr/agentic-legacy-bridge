// AUTHORED-BY Claude Opus 4.8
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
 *  3. **Retry / replay dedupe.** `event_id` is globally unique; a Slack `ts` is only
 *     CONVERSATION-scoped (which is why `messageId`/`threadId` above are qualified
 *     with the conversation id) — so a deterministic in-pod slug must key on
 *     `event_id` (or a conversation-qualified id), NOT a bare `ts`, to map a
 *     retried/replayed delivery to the SAME URL. NOTE the M2.1 `importInbound` write
 *     path is a plain `PUT` (overwrite) and does NOT itself provide idempotency; the
 *     M2.4 service must add create-only writes (`If-None-Match: *`, treating `412` as
 *     already-imported) — the property the design assigns to the service, not this
 *     adapter (M2-DESIGN.md §3.3/§3.4). No dedupe table is then needed.
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

import { createHash } from "node:crypto";
import type { ChannelAdapter, InboundRawMessage } from "./channel.js";
import { ChannelParseError } from "./errors.js";
import type { BridgeMessage, BridgeSender } from "./message.js";
import { CHANNELS_HEADER, REPLY_HEADER } from "./negotiate.js";
import { sanitizeText } from "./safe-iri.js";

/** The channel name written as `agentic:channel` for a Slack message. */
export const SLACK_CHANNEL = "slack";
/** The media type of the byte-exact raw anchor (a Slack event is JSON). */
export const SLACK_RAW_MEDIA_TYPE = "application/json";
/**
 * The `metadata.event_type` our own outbound structured replies carry (the Slack
 * rung-3 carrier, M2-DESIGN.md §1.1) — an inbound message with this metadata is read
 * as a bridge-capable counterparty. Its `event_payload` advertises `channels` (the
 * `X-Agentic-Channels` equivalent) and `reply` (the `X-Agentic-Reply` pod-copy URL),
 * mapped into {@link BridgeMessage.signals} for `detectBridgeCapability`.
 */
export const SLACK_AGENTIC_METADATA_EVENT_TYPE = "agentic_reply";

// --- hard caps (fail-closed) -------------------------------------------------
/** Hard cap on the whole event; over this throws {@link SlackParseError}. */
const MAX_EVENT_BYTES = 1024 * 1024;
/** Cap on the retained plain-text body length. */
const MAX_TEXT_CHARS = 100_000;
/** Cap on a display name. */
const MAX_NAME_CHARS = 200;
/** Cap on a single signal value folded from the reply metadata. */
const MAX_SIGNAL_CHARS = 4096;

// --- Slack id / ts shapes (anchored + linear → ReDoS-free) -------------------
/** A Slack workspace/team id (`T…`). */
const SLACK_TEAM_ID = /^T[A-Z0-9]{1,20}$/;
/** A Slack user id (`U…`, or `W…` on Enterprise Grid). */
const SLACK_USER_ID = /^[UW][A-Z0-9]{1,20}$/;
/** A Slack conversation id — public channel (`C…`), DM (`D…`), or private group (`G…`). */
const SLACK_CONVERSATION_ID = /^[CDG][A-Z0-9]{1,20}$/;
/** A Slack message timestamp (`<epoch-seconds>.<microseconds>`). */
const SLACK_TS = /^\d{1,10}\.\d{1,6}$/;

/** The inner-event types this transform accepts as an inbound message. */
const MESSAGE_TYPES = new Set(["message", "app_mention"]);
/**
 * Message subtypes that are NOT an original inbound message — an edit or a delete
 * needs dedicated fold-then-write / tombstone handling (the `matrix-chat-to-pod`
 * pattern), which is out of M2.1 scope, so they are REFUSED (skipped) fail-closed
 * rather than mis-imported as fresh messages.
 */
const REFUSED_SUBTYPES = new Set(["message_changed", "message_deleted", "message_replied"]);

/**
 * A controlled, typed, fail-closed refusal (the only throw from
 * {@link slackEventToBridgeMessage}). Extends the channel-neutral
 * {@link ChannelParseError} (M2.0) so `importInbound`'s skip-don't-abort catch is
 * channel-agnostic.
 */
export class SlackParseError extends ChannelParseError {
  constructor(message: string) {
    super(message);
    this.name = "SlackParseError";
  }
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

/** Narrow an untrusted value to a plain (non-array) object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrow an untrusted value to a string. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The FIRST candidate matching `shape`, in precedence order; else undefined. */
function firstValid(
  candidates: ReadonlyArray<string | undefined>,
  shape: RegExp,
): string | undefined {
  for (const c of candidates) {
    if (c !== undefined && shape.test(c)) return c;
  }
  return undefined;
}

/** Force a value single-line (a display name must never carry a line break). */
function oneLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Best-effort, control-stripped, single-line, capped display name (or undefined). */
function slackDisplayName(inner: Record<string, unknown>): string | undefined {
  const profile = asRecord(inner.user_profile);
  const candidate =
    asString(inner.username) ??
    (profile !== undefined ? asString(profile.display_name) : undefined) ??
    (profile !== undefined ? asString(profile.real_name) : undefined);
  if (candidate === undefined) return undefined;
  const clean = oneLine(sanitizeText(candidate)).slice(0, MAX_NAME_CHARS).trim();
  return clean === "" ? undefined : clean;
}

/** Convert a validated Slack `ts` to an ISO-8601 datetime, or undefined. */
function tsToIso(ts: string): string | undefined {
  const ms = Math.round(Number(ts) * 1000);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Build the channel-neutral `signals` map (the `detectBridgeCapability` carrier)
 * from our own `agentic_reply` message metadata — null-prototype safe, only the two
 * known keys, so a hostile `__proto__`/`constructor` payload key can never touch the
 * prototype chain and an unrecognised field is simply ignored.
 */
function slackSignals(inner: Record<string, unknown>): Readonly<Record<string, string>> {
  const signals: Record<string, string> = Object.create(null);
  const metadata = asRecord(inner.metadata);
  if (metadata === undefined) return Object.freeze(signals);
  if (asString(metadata.event_type) !== SLACK_AGENTIC_METADATA_EVENT_TYPE) {
    return Object.freeze(signals);
  }
  const payload = asRecord(metadata.event_payload);
  if (payload === undefined) return Object.freeze(signals);

  const channels = asString(payload.channels);
  if (channels !== undefined) {
    const v = sanitizeText(channels).trim().slice(0, MAX_SIGNAL_CHARS);
    if (v !== "") signals[CHANNELS_HEADER.toLowerCase()] = v;
  }
  const reply = asString(payload.reply);
  if (reply !== undefined) {
    // Kept verbatim (capped) — `detectBridgeCapability` re-validates it via `safeHttpIri`.
    const v = sanitizeText(reply).trim().slice(0, MAX_SIGNAL_CHARS);
    if (v !== "") signals[REPLY_HEADER.toLowerCase()] = v;
  }
  return Object.freeze(signals);
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
export function slackEventToBridgeMessage(
  raw: string | Uint8Array,
  ctx: SlackParseContext = {},
): BridgeMessage {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  if (buf.length > MAX_EVENT_BYTES) {
    throw new SlackParseError(
      `slack event exceeds the ${MAX_EVENT_BYTES}-byte hard cap (${buf.length} bytes).`,
    );
  }
  const rawSha256 = createHash("sha256").update(buf).digest("hex");

  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new SlackParseError("slack event is not valid JSON.");
  }
  const envelope = asRecord(parsed);
  if (envelope === undefined) {
    throw new SlackParseError("slack event is not a JSON object.");
  }

  const warnings: string[] = [];

  // Resolve the inner message: an Events API `event_callback` wraps it in `.event`;
  // a `conversations.history` row IS the message object itself.
  const isEventCallback = asString(envelope.type) === "event_callback";
  const inner = isEventCallback ? asRecord(envelope.event) : envelope;
  if (inner === undefined) {
    throw new SlackParseError("slack event_callback has no inner event object.");
  }

  const innerType = asString(inner.type);
  if (innerType === undefined || !MESSAGE_TYPES.has(innerType)) {
    throw new SlackParseError(`unsupported slack event type: ${innerType ?? "<none>"}.`);
  }
  const subtype = asString(inner.subtype);
  if (subtype !== undefined && REFUSED_SUBTYPES.has(subtype)) {
    throw new SlackParseError(`unsupported slack message subtype: ${subtype}.`);
  }

  // `ts` is the channel-stable id AND the date source — required + shape-validated.
  const ts = asString(inner.ts);
  if (ts === undefined || !SLACK_TS.test(ts)) {
    throw new SlackParseError("slack message is missing a valid `ts`.");
  }

  // `text`: PLAIN TEXT ONLY. mrkdwn is treated as opaque plain text (control-stripped,
  // capped); `blocks`/attachments are NEVER persisted (the stored-XSS rule).
  const textField = inner.text;
  if (typeof textField !== "string") {
    throw new SlackParseError("slack message has no plain-text `text`.");
  }
  let textBody = sanitizeText(textField);
  if (textBody.length > MAX_TEXT_CHARS) {
    textBody = textBody.slice(0, MAX_TEXT_CHARS);
    warnings.push("slack text truncated at the length cap.");
  }
  if (Array.isArray(inner.blocks) && inner.blocks.length > 0) {
    warnings.push("slack blocks/rich content dropped (plain text only — stored-XSS rule).");
  }

  // sender `team:user` — BOTH ids validated before minting a URN key; an out-of-shape
  // id yields no handle → `personIriFor` falls back to a provisional anon node (M2.0).
  const team = firstValid(
    [asString(inner.team), asString(envelope.team_id), ctx.teamId],
    SLACK_TEAM_ID,
  );
  const user = firstValid([asString(inner.user)], SLACK_USER_ID);
  let sender: BridgeSender | undefined;
  if (team !== undefined && user !== undefined) {
    const displayName = slackDisplayName(inner);
    sender = {
      handle: `${team}:${user}`,
      ...(displayName !== undefined ? { displayName } : {}),
    };
  } else {
    warnings.push("slack sender team/user id missing or out-of-shape; sender left provisional.");
  }

  // A Slack `ts` is only CHANNEL-scoped, so `messageId`/`threadId` are qualified with
  // the (validated) conversation id — `<C…>:<ts>` — to be workspace-unambiguous (two
  // channels could otherwise present the same `ts`). The conversation id comes from
  // the event (`inner.channel`) or, for a per-conversation backfill row that omits it,
  // `ctx.channelId`. When neither is a valid id the ids fall back to the bare `ts`.
  const conversation = firstValid([asString(inner.channel), ctx.channelId], SLACK_CONVERSATION_ID);
  const qualify = (t: string): string => (conversation !== undefined ? `${conversation}:${t}` : t);
  if (conversation === undefined) {
    warnings.push("slack conversation id missing/out-of-shape; message/thread ids are ts-only.");
  }

  // Thread linkage — the parent root ts of a threaded reply (`thread_ts` ≠ own `ts`).
  const threadTs = asString(inner.thread_ts);
  const threadId =
    threadTs !== undefined && SLACK_TS.test(threadTs) && threadTs !== ts
      ? qualify(threadTs)
      : undefined;

  const date = tsToIso(ts);

  return {
    channel: SLACK_CHANNEL,
    ...(sender !== undefined ? { sender } : {}),
    textBody,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(date !== undefined ? { date } : {}),
    messageId: qualify(ts),
    signals: slackSignals(inner),
    rawSha256,
    rawByteLength: buf.length,
    rawMediaType: SLACK_RAW_MEDIA_TYPE,
    warnings,
  };
}

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
export class SlackChannelAdapter implements ChannelAdapter {
  readonly channel = SLACK_CHANNEL;
  private readonly teamId: string | undefined;
  private readonly channelId: string | undefined;
  private readonly messages: readonly InboundRawMessage[];
  private readonly pullFn: (() => Promise<readonly InboundRawMessage[]>) | undefined;

  constructor(options: SlackChannelAdapterOptions = {}) {
    this.teamId = options.teamId;
    this.channelId = options.channelId;
    this.messages = options.messages ?? [];
    this.pullFn = options.pull;
  }

  parse(item: InboundRawMessage): BridgeMessage {
    return slackEventToBridgeMessage(item.raw, {
      teamId: this.teamId,
      channelId: this.channelId,
    });
  }

  pullInbound(): Promise<readonly InboundRawMessage[]> {
    return this.pullFn !== undefined ? this.pullFn() : Promise.resolve(this.messages);
  }
}
