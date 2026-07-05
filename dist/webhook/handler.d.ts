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
import { type WebhookRequest, type WebhookResponse } from "./request.js";
/** The default hard cap on the raw body (mirrors the adapters' per-event cap). */
export declare const DEFAULT_MAX_BODY_BYTES: number;
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
export type WebhookAuditEvent = {
    readonly kind: "method-not-allowed";
    readonly channel: string;
} | {
    readonly kind: "oversize";
    readonly channel: string;
} | {
    readonly kind: "verify-failed";
    readonly channel: string;
    readonly reason: string;
} | {
    readonly kind: "registration-ok";
    readonly channel: string;
} | {
    readonly kind: "registration-refused";
    readonly channel: string;
} | {
    readonly kind: "url-verification";
    readonly channel: string;
} | {
    readonly kind: "skipped";
    readonly channel: string;
} | {
    readonly kind: "written";
    readonly channel: string;
    readonly created: boolean;
} | {
    readonly kind: "error";
    readonly channel: string;
};
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
export declare function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler;
//# sourceMappingURL=handler.d.ts.map