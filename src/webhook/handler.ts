// AUTHORED-BY Claude Fable 5
/**
 * The framework-free inbound-webhook HANDLER (M2-DESIGN.md §3) — the deployable core
 * that receives a raw channel event, AUTHENTICATES THE SOURCE before any processing,
 * and writes the message OWNER-PRIVATE into a pod, create-only + idempotent. It is a
 * pure function of a {@link WebhookRequest} plus injected secrets/fetches, so it runs
 * behind any transport (WinterCG `fetch` handler, a Node listener, Socket Mode) and is
 * testable hermetically.
 *
 * ## The order is the security contract (M2-DESIGN.md §3.2)
 *
 *   size cap → verify signature over the RAW bytes → (registration handshake) →
 *   channel transform → create-only pod write → 2xx.
 *
 * Verification runs over the EXACT raw request bytes BEFORE any JSON parse. An
 * unverifiable request is answered `401` (Slack) / `403` (Meta registration) with no
 * body detail and nothing written or logged beyond a counter — a prober gets no oracle.
 * The channel transforms + the create-only writer are separately hardened; this layer
 * adds ONLY the source authentication + dispatch.
 *
 * ## Stateless / pod-as-state
 *
 * No load-bearing in-process state: idempotency is the deterministic slug + create-only
 * write (a retry/redelivery/replay-within-window no-ops), so the handler horizontally
 * scales with no shared cache or sticky instance. The 3-second-ack problem is solved by
 * running only the pure DETERMINISTIC interpreter inline; the LLM pass is decoupled
 * (mark `agentic:Pending` via {@link WebhookHandlerOptions.markPendingInterpretation}).
 */

import type { Interpreter } from "../interpret.js";
import type { BridgeMessage } from "../message.js";
import { canonicalContainer } from "../safe-iri.js";
import { SlackParseError, slackEventToBridgeMessage } from "../slack.js";
import {
  MAX_MESSAGES_PER_DELIVERY,
  parseWhatsAppDelivery,
  WhatsAppParseError,
} from "../whatsapp.js";
import {
  OK,
  PAYLOAD_TOO_LARGE,
  UNAUTHORIZED,
  type WebhookRequest,
  type WebhookResponse,
} from "./request.js";
import { metaVerificationChallenge, verifyMetaSignature } from "./verify-meta.js";
import { verifySlackSignature } from "./verify-slack.js";
import { writeMessageCreateOnly } from "./write.js";

/** The default hard cap on the raw body (mirrors the adapters' per-event cap). */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** Cap on the echoed Slack `url_verification` challenge. */
const MAX_SLACK_CHALLENGE_CHARS = 2048;

/** A 405 — the method is not one this endpoint serves. */
const METHOD_NOT_ALLOWED: WebhookResponse = Object.freeze({ status: 405 });
/** A 403 — a Meta registration `GET` whose verify token did not match. */
const FORBIDDEN: WebhookResponse = Object.freeze({ status: 403 });
/** A 500 — a transient operational failure (e.g. a pod write error); platform retries. */
const INTERNAL_ERROR: WebhookResponse = Object.freeze({ status: 500 });
/**
 * A 422 — a verified delivery whose message fan-out exceeds the per-delivery cap
 * ({@link WebhookHandlerOptions.maxMessagesPerDelivery}). Distinct from the 413 byte
 * cap: the body is within the byte budget and well-formed, but carries an implausible
 * number of messages, so it is refused fail-closed (bounded), never fanned out in an
 * unbounded loop. A genuine WhatsApp delivery is a small handful of messages.
 */
const UNPROCESSABLE_TOO_MANY_MESSAGES: WebhookResponse = Object.freeze({ status: 422 });

/** The Slack channel config: the app Signing Secret (from the service env). */
export interface SlackWebhookConfig {
  readonly channel: "slack";
  /** The Slack app Signing Secret — never logged, never in a URL or a pod resource. */
  readonly signingSecret: string;
}

/** The WhatsApp/Meta channel config: the App Secret + the registration verify token. */
export interface WhatsAppWebhookConfig {
  readonly channel: "whatsapp";
  /** The Meta App Secret used for the `X-Hub-Signature-256` HMAC — never logged. */
  readonly appSecret: string;
  /** The registration verify token echoed against on the `GET` handshake — never logged. */
  readonly verifyToken: string;
}

/** The per-channel secret configuration (the injected signature secret seam). */
export type WebhookChannelConfig = SlackWebhookConfig | WhatsAppWebhookConfig;

/** A privacy-safe audit/counter event (NO payloads, NO secrets, NO message content). */
export type WebhookAuditEvent =
  | { readonly kind: "method-not-allowed"; readonly channel: string }
  | { readonly kind: "oversize"; readonly channel: string }
  | { readonly kind: "verify-failed"; readonly channel: string; readonly reason: string }
  | { readonly kind: "registration-ok"; readonly channel: string }
  | { readonly kind: "registration-refused"; readonly channel: string }
  | { readonly kind: "url-verification"; readonly channel: string }
  | { readonly kind: "skipped"; readonly channel: string }
  | { readonly kind: "written"; readonly channel: string; readonly created: boolean }
  /** A verified delivery refused because its message count exceeded the fan-out cap. */
  | { readonly kind: "over-message-cap"; readonly channel: string; readonly count: number }
  | { readonly kind: "error"; readonly channel: string };

/** Options for {@link createWebhookHandler}. */
export interface WebhookHandlerOptions {
  /** The channel + its injected signature secret(s). */
  readonly channel: WebhookChannelConfig;
  /** The owner-locked pod container to write into (validated at construction). */
  readonly container: string;
  /**
   * The bridge agent's authed pod `fetch` (Append-only on the container). Injectable —
   * the handler is fully testable with a fake fetch (no live pod, no credentials).
   */
  readonly writeFetch: typeof globalThis.fetch;
  /**
   * The inline interpreter (default: the hermetic deterministic reference). Kept
   * synchronous so the 2xx ack stays inside Slack's 3-second window; the LLM pass is
   * decoupled (M2-DESIGN.md §3.6).
   */
  readonly interpreter?: Interpreter;
  /** Mark imports `agentic:Pending` for a later decoupled LLM sweep (default false). */
  readonly markPendingInterpretation?: boolean;
  /** The interpreting agent's WebID (`prov:wasAssociatedWith`). */
  readonly interpretingAgentWebId?: string;
  /** The ODRL mandate the interpreting agent acts under (`prov:hadPlan`). */
  readonly mandateIri?: string;
  /** Supply UNVERIFIED candidate WebIDs for a sender (discovered elsewhere, offline). */
  readonly candidateWebIdsFor?: (message: BridgeMessage) => readonly string[] | undefined;
  /** The hard cap on the raw body (default {@link DEFAULT_MAX_BODY_BYTES}). */
  readonly maxBodyBytes?: number;
  /**
   * The hard cap on the number of messages fanned out from ONE WhatsApp delivery
   * (default {@link MAX_MESSAGES_PER_DELIVERY}). A verified delivery whose message
   * count exceeds it is refused fail-closed (`422`), never processed as an unbounded
   * loop — the fan-out amplification bound. WhatsApp only; Slack delivers one message
   * per POST. Must be a positive integer if supplied (validated at construction).
   */
  readonly maxMessagesPerDelivery?: number;
  /** Injectable clock in epoch ms (default `Date.now`) — drives the Slack replay window. */
  readonly now?: () => number;
  /** A privacy-safe audit sink (counters only — never payloads/secrets). */
  readonly onEvent?: (event: WebhookAuditEvent) => void;
}

/** A ready-to-mount webhook handler: a pure `(request) => Promise<response>`. */
export type WebhookHandler = (request: WebhookRequest) => Promise<WebhookResponse>;

/**
 * Build a stateless webhook handler for one channel. Validates the config fail-closed
 * at CONSTRUCTION (a blank secret, verify token, or container is a deployment bug that
 * must surface loudly — never a silent verify-open), then returns the handler.
 *
 * @throws if the container is not a safe canonical container IRI, or a required secret
 *   / verify token is empty.
 */
export function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
  const container = canonicalContainer(options.container);
  if (container === undefined) {
    throw new Error(
      "webhook: container must be a safe http(s) container IRI ending in '/' with no query or fragment.",
    );
  }
  const config = options.channel;
  if (config.channel === "slack") {
    if (typeof config.signingSecret !== "string" || config.signingSecret.length === 0) {
      throw new Error("webhook(slack): signingSecret is required and must be non-empty.");
    }
  } else {
    if (typeof config.appSecret !== "string" || config.appSecret.length === 0) {
      throw new Error("webhook(whatsapp): appSecret is required and must be non-empty.");
    }
    if (typeof config.verifyToken !== "string" || config.verifyToken.length === 0) {
      throw new Error("webhook(whatsapp): verifyToken is required and must be non-empty.");
    }
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    options.maxMessagesPerDelivery !== undefined &&
    (!Number.isInteger(options.maxMessagesPerDelivery) || options.maxMessagesPerDelivery <= 0)
  ) {
    throw new Error("webhook: maxMessagesPerDelivery must be a positive integer when supplied.");
  }
  const maxMessagesPerDelivery = options.maxMessagesPerDelivery ?? MAX_MESSAGES_PER_DELIVERY;
  const now = options.now ?? Date.now;
  const emit = (event: WebhookAuditEvent): void => {
    options.onEvent?.(event);
  };

  return async (request: WebhookRequest): Promise<WebhookResponse> => {
    const method = String(request.method ?? "").toUpperCase();

    // GET → the Meta registration handshake ONLY (Slack has no GET registration).
    if (method === "GET") {
      if (config.channel !== "whatsapp") {
        emit({ kind: "method-not-allowed", channel: config.channel });
        return METHOD_NOT_ALLOWED;
      }
      const challenge = metaVerificationChallenge(request.query, config.verifyToken);
      if (!challenge.ok) {
        emit({ kind: "registration-refused", channel: config.channel });
        return FORBIDDEN;
      }
      emit({ kind: "registration-ok", channel: config.channel });
      return {
        status: 200,
        body: challenge.challenge,
        headers: { "content-type": "text/plain; charset=utf-8" },
      };
    }

    if (method !== "POST") {
      emit({ kind: "method-not-allowed", channel: config.channel });
      return METHOD_NOT_ALLOWED;
    }

    // Size cap BEFORE any HMAC / parse (a pre-verification DoS guard).
    const rawBody = request.rawBody ?? new Uint8Array(0);
    if (rawBody.length > maxBodyBytes) {
      emit({ kind: "oversize", channel: config.channel });
      return PAYLOAD_TOO_LARGE;
    }

    // Verify the SOURCE over the RAW bytes, before any JSON parse.
    const headers = request.headers ?? {};
    if (config.channel === "slack") {
      const v = verifySlackSignature(headers, rawBody, config.signingSecret, now());
      if (!v.ok) {
        emit({ kind: "verify-failed", channel: config.channel, reason: v.reason });
        return UNAUTHORIZED;
      }
    } else {
      const v = verifyMetaSignature(headers, rawBody, config.appSecret);
      if (!v.ok) {
        emit({ kind: "verify-failed", channel: config.channel, reason: v.reason });
        return UNAUTHORIZED;
      }
    }

    // A pod-write failure is a TRANSIENT operational error, not a bad request. Return
    // 500 (no detail) so the platform RETRIES — and the create-only writes make the
    // retry heal a partial delivery. The handler never rejects; it answers a status.
    try {
      return config.channel === "slack"
        ? await handleSlackDelivery(rawBody, options, container, emit)
        : await handleWhatsAppDelivery(rawBody, options, container, emit, maxMessagesPerDelivery);
    } catch {
      emit({ kind: "error", channel: config.channel });
      return INTERNAL_ERROR;
    }
  };
}

/** Decode + parse a bounded JSON body; `undefined` on non-JSON. */
function parseJsonObject(rawBody: Uint8Array): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** The shared write-args a delivery handler forwards to the create-only writer. */
function writeArgs(
  options: WebhookHandlerOptions,
  container: string,
  message: BridgeMessage,
  rawBody: Uint8Array,
) {
  const candidateWebIds = options.candidateWebIdsFor?.(message);
  const nowMs = (options.now ?? Date.now)();
  return {
    message,
    raw: rawBody,
    container,
    writeFetch: options.writeFetch,
    ...(options.interpreter !== undefined ? { interpreter: options.interpreter } : {}),
    ...(options.markPendingInterpretation !== undefined
      ? { markPendingInterpretation: options.markPendingInterpretation }
      : {}),
    ...(options.interpretingAgentWebId !== undefined
      ? { interpretingAgentWebId: options.interpretingAgentWebId }
      : {}),
    ...(options.mandateIri !== undefined ? { mandateIri: options.mandateIri } : {}),
    ...(candidateWebIds !== undefined ? { candidateWebIds } : {}),
    now: new Date(nowMs),
  };
}

/** Handle a verified Slack POST: url_verification echo, or one-message import. */
async function handleSlackDelivery(
  rawBody: Uint8Array,
  options: WebhookHandlerOptions,
  container: string,
  emit: (event: WebhookAuditEvent) => void,
): Promise<WebhookResponse> {
  const envelope = parseJsonObject(rawBody);

  // The endpoint-registration handshake — echo the challenge (already signature-verified).
  if (envelope !== undefined && envelope.type === "url_verification") {
    const challenge = envelope.challenge;
    emit({ kind: "url-verification", channel: "slack" });
    if (typeof challenge === "string" && challenge.length > 0) {
      return {
        status: 200,
        body: challenge.slice(0, MAX_SLACK_CHALLENGE_CHARS),
        headers: { "content-type": "text/plain; charset=utf-8" },
      };
    }
    return OK;
  }

  let message: BridgeMessage;
  try {
    message = slackEventToBridgeMessage(rawBody);
  } catch (err) {
    if (err instanceof SlackParseError) {
      emit({ kind: "skipped", channel: "slack" }); // unsupported type/subtype/etc → ack, don't retry
      return OK;
    }
    throw err;
  }
  const result = await writeMessageCreateOnly(writeArgs(options, container, message, rawBody));
  emit({ kind: "written", channel: "slack", created: result.created });
  return OK;
}

/** Handle a verified WhatsApp POST: fan out every message in the delivery, import each. */
async function handleWhatsAppDelivery(
  rawBody: Uint8Array,
  options: WebhookHandlerOptions,
  container: string,
  emit: (event: WebhookAuditEvent) => void,
  maxMessagesPerDelivery: number,
): Promise<WebhookResponse> {
  // Parse the delivery body ONCE, then fan out by indexing into the already-parsed
  // records (delivery.messageAt) — NOT by re-parsing the whole body per message. This
  // is the fix for the authenticated O(messages × body-size) amplification: a ~0.9 MB
  // signed delivery could encode hundreds of thousands of message objects, and the old
  // per-index re-parse turned that into hundreds of thousands of full-body parses.
  const delivery = parseWhatsAppDelivery(rawBody, maxMessagesPerDelivery);

  // An implausibly large fan-out is refused fail-closed with a bounded 422 — never an
  // unbounded loop. Surfaced (NOT silently dropped) via a distinct audit counter so an
  // over-cap delivery is visible to operators.
  if (delivery.capped) {
    emit({ kind: "over-message-cap", channel: "whatsapp", count: delivery.total });
    return UNPROCESSABLE_TOO_MANY_MESSAGES;
  }

  if (delivery.total === 0) {
    emit({ kind: "skipped", channel: "whatsapp" }); // status/receipt change, no messages → ack
    return OK;
  }

  for (let i = 0; i < delivery.total; i++) {
    let message: BridgeMessage;
    try {
      message = delivery.messageAt(i); // parse-once: index into the resolved records
    } catch (err) {
      if (err instanceof WhatsAppParseError) {
        emit({ kind: "skipped", channel: "whatsapp" }); // non-text / bad entry → skip this one
        continue;
      }
      throw err;
    }
    const result = await writeMessageCreateOnly(writeArgs(options, container, message, rawBody));
    emit({ kind: "written", channel: "whatsapp", created: result.created });
  }
  return OK;
}
