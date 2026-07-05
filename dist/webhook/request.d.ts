/**
 * The framework-free request/response shapes for the M2.4 inbound-webhook service
 * (M2-DESIGN.md §3.1). The handler core ({@link ./handler.ts}) is a pure function of
 * a {@link WebhookRequest} (+ injected secrets/fetches) → {@link WebhookResponse}, so
 * it is testable hermetically (a fixture request → the expected pod writes against a
 * fake fetch) and runnable behind any transport — a Vercel/Node/worker WinterCG
 * `fetch` handler ({@link ./fetch-adapter.ts}), a plain Node listener, or a Slack
 * Socket-Mode loop. No framework types leak into the core.
 *
 * SECURITY: signature verification runs over the EXACT RAW request bytes
 * ({@link WebhookRequest.rawBody}) BEFORE any JSON parse (M2-DESIGN.md §3.2), so the
 * raw bytes MUST be captured verbatim by the transport adapter — never a re-serialised
 * JSON round-trip (which would change the bytes and break the HMAC).
 */
/** A framework-free inbound HTTP request as the webhook handler sees it. */
export interface WebhookRequest {
    /** The HTTP method (`"GET"` | `"POST"` | …), case-insensitive. */
    readonly method: string;
    /**
     * The request headers. Looked up case-insensitively by the handler
     * ({@link headerValue}); a transport MAY pass mixed-case keys.
     */
    readonly headers: Readonly<Record<string, string>>;
    /**
     * The EXACT raw request body bytes — the bytes the channel signed. Signature
     * verification runs over these verbatim (never a re-encoded JSON round-trip).
     * Empty for a GET (e.g. the Meta registration handshake).
     */
    readonly rawBody: Uint8Array;
    /**
     * The parsed URL query parameters (for the Meta `GET` `hub.*` registration
     * handshake). Absent/empty for a signed `POST` delivery.
     */
    readonly query?: Readonly<Record<string, string>>;
}
/** A framework-free HTTP response the webhook handler returns. */
export interface WebhookResponse {
    /** The HTTP status code. */
    readonly status: number;
    /**
     * The response body. A bare string only — the challenge echo (registration) or an
     * empty ack. NEVER reflects any unverified request content beyond a validated
     * challenge token.
     */
    readonly body?: string;
    /** Response headers (e.g. `content-type: text/plain` for a challenge echo). */
    readonly headers?: Readonly<Record<string, string>>;
}
/**
 * Case-insensitive header lookup. Returns the FIRST value whose lower-cased key
 * matches `name` (already lower-case by convention), or `undefined`. A non-string
 * value (a defensively-typed transport) yields `undefined`.
 */
export declare function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined;
/** A 401 with no body detail — the fail-closed answer to an UNVERIFIABLE request. */
export declare const UNAUTHORIZED: WebhookResponse;
/** A 413 — the request body exceeds the hard cap (a pre-verification DoS guard). */
export declare const PAYLOAD_TOO_LARGE: WebhookResponse;
/** A bare 200 ack (verified + handled; nothing to echo). */
export declare const OK: WebhookResponse;
//# sourceMappingURL=request.d.ts.map