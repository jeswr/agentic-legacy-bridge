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
 *    an id carrying an IRIREF-forbidden char can never reach a `namedNode()`;
 *  - **refuses bot/app-authored messages to prevent a responder loop, scoped to
 *    THIS bridge's own identity, PER FIELD and fail-closed** ({@link
 *    SlackParseContext.ownBotId} / {@link SlackParseContext.ownAppId}). A message
 *    is accepted as a different bridge's own message ONLY when every identity
 *    signal it carries (`bot_id`, `app_id`, Slack's `bot_message` subtype) is BOTH
 *    comparable (the matching `ctx.own*Id` is configured) AND provably
 *    non-matching; any signal that cannot be compared — no own-id configured for
 *    that field, or a bare `bot_message` subtype with no id at all — is treated as
 *    "could be ours" and refused. Without any own-identity configured, every
 *    bot/app message is refused (the original, safe default); this lets a
 *    DIFFERENT bridge's own message (e.g. a counterparty advertising Rung-3
 *    capability via `metadata.event_type: agentic_reply`) be read for its
 *    `signals` without ever reopening the loop through a partially-configured
 *    own identity;
 *
 * The Events API receiver lives in the stateless `./webhook` subexport. A live
 * `conversations.history` backfill is deliberately still a host-injected pull seam;
 * every such remote read MUST go through `@jeswr/guarded-fetch`'s node-pinning fetch,
 * with the bot token only in a request header, per the {@link ChannelAdapter}
 * security contract.
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
import { asChannel, CHANNELS_HEADER, type Channel, REPLY_HEADER } from "./negotiate.js";
import type { BuiltReply } from "./reply.js";
import { safeHttpIri, sanitizeText } from "./safe-iri.js";
import { readAllBounded } from "./stream-limit.js";

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
/** The only Slack Web API endpoint to which the sender will attach a bot token. */
export const SLACK_CHAT_POST_MESSAGE_ENDPOINT = "https://slack.com/api/chat.postMessage";

// --- hard caps (fail-closed) -------------------------------------------------
/** Hard cap on the whole event; over this throws {@link SlackParseError}. */
const MAX_EVENT_BYTES = 1024 * 1024;
/** Maximum JSON object/array nesting before parse (depth-bomb guard). */
const MAX_JSON_DEPTH = 64;
/** Cap on the retained plain-text body length. */
const MAX_TEXT_CHARS = 100_000;
/** Cap on a display name. */
const MAX_NAME_CHARS = 200;
/** Cap on a single signal value folded from the reply metadata. */
const MAX_SIGNAL_CHARS = 4096;
/** Slack truncates very long `text`; refuse to send more than its documented ceiling. */
const MAX_SLACK_REPLY_TEXT_CHARS = 40_000;
/** Keep the pointer-form metadata small and predictable. */
const MAX_SLACK_REPLY_URL_CHARS = 2048;
/** Defence-in-depth cap on a Slack Web API response body. */
const DEFAULT_MAX_SLACK_RESPONSE_BYTES = 256 * 1024;
const MAX_CONFIGURED_SLACK_RESPONSE_BYTES = 1024 * 1024;
/** Network timeout for the injected/default Slack Web API fetch. */
const DEFAULT_SLACK_REPLY_TIMEOUT_MS = 10_000;
const MAX_SLACK_REPLY_TIMEOUT_MS = 120_000;

// --- Slack id / ts shapes (anchored + linear → ReDoS-free) -------------------
/** A Slack workspace/team id (`T…`). */
const SLACK_TEAM_ID = /^T[A-Z0-9]{1,20}$/;
/** A Slack user id (`U…`, or `W…` on Enterprise Grid). */
const SLACK_USER_ID = /^[UW][A-Z0-9]{1,20}$/;
/** A Slack conversation id — public channel (`C…`), DM (`D…`), or private group (`G…`). */
const SLACK_CONVERSATION_ID = /^[CDG][A-Z0-9]{1,20}$/;
/** A Slack message timestamp (`<epoch-seconds>.<microseconds>`). */
const SLACK_TS = /^\d{1,10}\.\d{1,6}$/;
/** A bot token shape that cannot inject an HTTP Authorization header. */
const SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,512}$/;

/** The inner-event types this transform accepts as an inbound message. */
const MESSAGE_TYPES = new Set(["message", "app_mention"]);
/**
 * Message subtypes that are NOT an original inbound message — an edit or a delete
 * needs dedicated fold-then-write / tombstone handling (the `matrix-chat-to-pod`
 * pattern), which is out of M2.1 scope, so they are REFUSED (skipped) fail-closed
 * rather than mis-imported as fresh messages. `bot_message` is NOT in this set —
 * it is handled by the identity-scoped bot/app check below (roborev job 5342
 * finding 1), so a `bot_message`-subtype message from a DIFFERENT, provably
 * foreign bridge can still be read for its capability signal.
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
  /**
   * THIS bridge's own Slack bot id (from `auth.test`/deployment config), used to
   * scope loop-prevention to messages this bridge itself posted (roborev job 5335:
   * a blanket "refuse every bot/app-authored message" throws away a DIFFERENT
   * counterparty's own bridge advertising Rung-3 capability via
   * `metadata.event_type: agentic_reply` — M2-DESIGN.md §1.1 — before
   * {@link slackSignals} ever runs, so cross-bridge capability detection can never
   * fire on Slack).
   *
   * When `ownBotId`/`ownAppId` are both omitted (the default), the SAFE fallback
   * is preserved: EVERY bot/app-authored message is refused, exactly as before
   * this field existed. When one or both are supplied, a message is accepted as a
   * DIFFERENT bridge's own message ONLY when every identity signal it carries
   * (`bot_id`, `app_id`, the Slack `bot_message` subtype) is BOTH comparable (the
   * matching own-id is configured) AND provably non-matching — per-field,
   * fail-closed (roborev job 5342 finding 2: configuring only `ownBotId` must NOT
   * cause a message that is genuinely this bridge's own but happens to carry only
   * an `app_id` to be misread as foreign; that field stays uncomparable, so it is
   * refused, same as the all-omitted default). Sender stays provisional on an
   * accepted bot/app message — bot messages carry no `user` field.
   */
  readonly ownBotId?: string;
  /** THIS bridge's own Slack app id — see {@link ownBotId}. */
  readonly ownAppId?: string;
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

/**
 * Linear, allocation-free JSON structural-depth preflight. Braces/brackets inside
 * strings (including escaped quotes) are ignored. Syntax remains JSON.parse's job;
 * this guard exists solely so an under-byte-cap nesting bomb never reaches it.
 */
function exceedsJsonDepth(bytes: Uint8Array, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) {
        escaped = true; // backslash
      } else if (byte === 0x22) {
        inString = false; // quote
      }
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x7b || byte === 0x5b) {
      depth += 1; // `{` or `[`
      if (depth > maxDepth) return true;
    } else if (byte === 0x7d || byte === 0x5d) {
      depth = Math.max(0, depth - 1); // `}` or `]`; malformed balance is refused by JSON.parse
    }
  }
  return false;
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
  if (exceedsJsonDepth(buf, MAX_JSON_DEPTH)) {
    throw new SlackParseError(`slack event exceeds the ${MAX_JSON_DEPTH}-level JSON depth cap.`);
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
  // App-authored messages are never actionable inbound HUMAN messages, but the
  // refusal is scoped to LOOP PREVENTION (this bridge ingesting its OWN reply and
  // auto-responding to itself) — NOT to every bot/app in the workspace: a
  // DIFFERENT bridge's own bot/app message is exactly how its Rung-3 capability
  // signal (M2-DESIGN.md §1.1, `metadata.event_type: agentic_reply`) would arrive,
  // and refusing it unconditionally would make cross-bridge capability detection
  // on Slack unreachable (roborev job 5335). This applies to Slack's own
  // `bot_message` subtype too (roborev job 5342 finding 1) — a bare subtype has no
  // id to compare, so it is NOT itself sufficient evidence of "foreign"; only
  // `bot_id`/`app_id` are.
  //
  // Fail-closed PER FIELD (roborev job 5342 finding 2): a message is accepted as
  // a different bridge's own message ONLY when EVERY identity signal it carries is
  // BOTH comparable (this bridge's own counterpart is configured) AND provably
  // non-matching. Any signal we cannot compare — no `ctx.ownBotId`/`ctx.ownAppId`
  // configured for that field, or a bare `bot_message` subtype with no id at all —
  // is conservatively treated as "could be ours" and refused. This prevents a
  // partial own-identity configuration (only one of the two ids set) from
  // reopening the loop via the unconfigured field.
  const botMessageSubtype = subtype === "bot_message";
  const botId = asString(inner.bot_id);
  const appId = asString(inner.app_id);
  const hasAppIdentity = botId !== undefined || appId !== undefined || botMessageSubtype;
  if (hasAppIdentity) {
    const botIsOwnOrUncomparable =
      botId !== undefined && (ctx.ownBotId === undefined || botId === ctx.ownBotId);
    const appIsOwnOrUncomparable =
      appId !== undefined && (ctx.ownAppId === undefined || appId === ctx.ownAppId);
    const noComparableId = botId === undefined && appId === undefined; // bare subtype flag, no ids
    if (botIsOwnOrUncomparable || appIsOwnOrUncomparable || noComparableId) {
      throw new SlackParseError("slack app/bot-authored messages are not inbound user messages.");
    }
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
   * THIS bridge's own Slack bot/app id — see {@link SlackParseContext.ownBotId}.
   * Passed through to {@link slackEventToBridgeMessage} unchanged. Omit both to
   * keep the safe default (refuse every bot/app-authored message).
   */
  readonly ownBotId?: string;
  /** THIS bridge's own Slack app id — see {@link SlackParseContext.ownAppId}. */
  readonly ownAppId?: string;
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
  /**
   * Optional live reply configuration. Omit it for a read-only adapter; when
   * present, `sendReply` uses Slack `chat.postMessage` with pointer-form metadata.
   */
  readonly reply?: SlackReplySenderOptions;
}

/** Injectable live Slack `chat.postMessage` configuration. */
export interface SlackReplySenderOptions {
  /** Slack bot token (`xoxb-…`) carrying `chat:write`; never logged or persisted. */
  readonly botToken: string;
  /** Injectable fetch for hermetic tests; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Config-injected endpoint for deployment/test wiring. It MUST canonicalise to
   * Slack's exact HTTPS `chat.postMessage` endpoint, preventing token exfiltration.
   */
  readonly apiEndpoint?: string;
  /** Channels advertised in metadata; default `rdf,dpop-sk,a2a` (email is implicit). */
  readonly supportedChannels?: readonly Channel[];
  /** Request timeout in ms (default 10s, maximum 120s). */
  readonly timeoutMs?: number;
  /** Response-body cap in bytes (default 256 KiB, maximum 1 MiB). */
  readonly maxResponseBytes?: number;
}

/** The Slack reply implementation installed on a configured adapter. */
export type SlackReplySender = (
  target: {
    readonly to: string;
    readonly inReplyToId?: string;
  },
  reply: BuiltReply,
) => Promise<void>;

/**
 * The Slack {@link ChannelAdapter}: `parse` is {@link slackEventToBridgeMessage}, so
 * a Slack workspace plugs into the M2.0 `importInbound` pipeline with zero pipeline
 * changes (owner-private write of the byte-exact `.json` anchor + agentic graph +
 * canonical chat message, channel-scoped person URN, deterministic interpretations).
 *
 * Read-only when `options.reply` is omitted. With reply credentials it installs the
 * `chat.postMessage` pointer-form structured carrier without changing parse/pull.
 */
export class SlackChannelAdapter implements ChannelAdapter {
  readonly channel = SLACK_CHANNEL;
  readonly sendReply?: SlackReplySender;
  private readonly teamId: string | undefined;
  private readonly channelId: string | undefined;
  private readonly ownBotId: string | undefined;
  private readonly ownAppId: string | undefined;
  private readonly messages: readonly InboundRawMessage[];
  private readonly pullFn: (() => Promise<readonly InboundRawMessage[]>) | undefined;

  constructor(options: SlackChannelAdapterOptions = {}) {
    this.teamId = options.teamId;
    this.channelId = options.channelId;
    this.ownBotId = options.ownBotId;
    this.ownAppId = options.ownAppId;
    this.messages = options.messages ?? [];
    this.pullFn = options.pull;
    if (options.reply !== undefined) this.sendReply = createSlackReplySender(options.reply);
  }

  parse(item: InboundRawMessage): BridgeMessage {
    return slackEventToBridgeMessage(item.raw, {
      teamId: this.teamId,
      channelId: this.channelId,
      ownBotId: this.ownBotId,
      ownAppId: this.ownAppId,
    });
  }

  pullInbound(): Promise<readonly InboundRawMessage[]> {
    return this.pullFn !== undefined ? this.pullFn() : Promise.resolve(this.messages);
  }
}

/**
 * Create the live Slack reply boundary. The human answer + A2A recommendation ride
 * in top-level plain `text`; the structured carrier uses bounded, invisible message
 * metadata (`event_type: agentic_reply`, `channels` + pod-copy `reply` pointer).
 *
 * The token is attached only after the endpoint, target, thread and body validate.
 * Redirects and response bombs are refused, and Slack's JSON `ok` flag is required.
 */
export function createSlackReplySender(options: SlackReplySenderOptions): SlackReplySender {
  if (typeof options.botToken !== "string" || !SLACK_BOT_TOKEN.test(options.botToken)) {
    throw new Error("Slack reply: botToken must be a header-safe xoxb bot token.");
  }
  const endpoint = slackReplyEndpoint(options.apiEndpoint ?? SLACK_CHAT_POST_MESSAGE_ENDPOINT);
  if (endpoint === undefined) {
    throw new Error("Slack reply: apiEndpoint must be Slack's HTTPS chat.postMessage endpoint.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_REPLY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SLACK_REPLY_TIMEOUT_MS) {
    throw new Error("Slack reply: timeoutMs must be an integer from 1 through 120000.");
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_SLACK_RESPONSE_BYTES;
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_CONFIGURED_SLACK_RESPONSE_BYTES
  ) {
    throw new Error("Slack reply: maxResponseBytes must be an integer from 1 through 1048576.");
  }
  const channels = advertisedChannels(options.supportedChannels);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async (target, reply): Promise<void> => {
    if (!SLACK_CONVERSATION_ID.test(target.to)) {
      throw new Error("Slack reply: target.to must be a Slack conversation id.");
    }
    const threadTs = slackReplyThread(target.to, target.inReplyToId);
    const text = slackReplyText(reply.humanText);
    const replyUrl = slackReplyPointer(reply.headers?.["X-Agentic-Reply"]);

    const eventPayload: Record<string, string> = { channels };
    if (replyUrl !== undefined) eventPayload.reply = replyUrl;
    const body = JSON.stringify({
      channel: target.to,
      text,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      metadata: {
        event_type: SLACK_AGENTIC_METADATA_EVENT_TYPE,
        event_payload: eventPayload,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (cause) {
        throw new Error("Slack reply: chat.postMessage request failed.", { cause });
      }

      if (response.status >= 300 && response.status < 400) {
        throw new Error("Slack reply: refusing to follow a redirect.");
      }
      if (!response.ok) {
        throw new Error(`Slack reply: chat.postMessage returned HTTP ${response.status}.`);
      }
      // Keep the request timeout active through BODY consumption too — a peer that
      // sends headers and then stalls the stream must not pin a worker indefinitely.
      const bytes = await readAllBounded(response.body, maxResponseBytes);
      if (bytes === undefined) throw new Error("Slack reply: response exceeded the size cap.");
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("Slack reply: chat.postMessage returned invalid JSON.");
      }
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        Array.isArray(decoded) ||
        (decoded as Record<string, unknown>).ok !== true
      ) {
        throw new Error("Slack reply: chat.postMessage rejected the message.");
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Exact-origin/path endpoint gate: a config typo can never receive the bot token. */
function slackReplyEndpoint(value: unknown): string | undefined {
  const safe = safeHttpIri(value);
  if (safe === undefined) return undefined;
  const url = new URL(safe);
  if (
    url.origin !== "https://slack.com" ||
    url.pathname !== "/api/chat.postMessage" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  return safe;
}

/** Validate/dedupe the closed channel set and omit the implicit email floor. */
function advertisedChannels(values: readonly Channel[] | undefined): string {
  const out: Channel[] = [];
  for (const raw of values ?? ["rdf", "dpop-sk", "a2a"]) {
    const channel = asChannel(raw);
    if (channel === undefined || channel === "email" || out.includes(channel)) continue;
    out.push(channel);
  }
  if (out.length === 0) throw new Error("Slack reply: at least one upgrade channel is required.");
  return out.join(",");
}

/** Extract a Slack thread ts; a qualified id must agree with the target channel. */
function slackReplyThread(channel: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf(":");
  const ts = separator === -1 ? value : value.slice(separator + 1);
  if (
    (separator !== -1 &&
      (value.indexOf(":", separator + 1) !== -1 || value.slice(0, separator) !== channel)) ||
    !SLACK_TS.test(ts)
  ) {
    throw new Error("Slack reply: inReplyToId must be a matching conversation-qualified Slack ts.");
  }
  return ts;
}

/** Revalidate a public `BuiltReply` before it reaches Slack's plain-text field. */
function slackReplyText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Slack reply: BuiltReply.humanText is required.");
  }
  const clean = sanitizeText(value).trim();
  if (clean === "" || clean.length > MAX_SLACK_REPLY_TEXT_CHARS) {
    throw new Error("Slack reply: humanText must contain 1 through 40000 characters.");
  }
  return clean;
}

/** Pointer-form carrier; an unsafe/oversized direct-construction value is dropped. */
function slackReplyPointer(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SLACK_REPLY_URL_CHARS) return undefined;
  return safeHttpIri(value);
}
