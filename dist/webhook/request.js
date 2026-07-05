// AUTHORED-BY Claude Fable 5
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
/**
 * Case-insensitive header lookup. Returns the FIRST value whose lower-cased key
 * matches `name` (already lower-case by convention), or `undefined`. A non-string
 * value (a defensively-typed transport) yields `undefined`.
 */
export function headerValue(headers, name) {
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === wanted) {
            const v = headers[key];
            return typeof v === "string" ? v : undefined;
        }
    }
    return undefined;
}
/** A 401 with no body detail — the fail-closed answer to an UNVERIFIABLE request. */
export const UNAUTHORIZED = Object.freeze({ status: 401 });
/** A 413 — the request body exceeds the hard cap (a pre-verification DoS guard). */
export const PAYLOAD_TOO_LARGE = Object.freeze({ status: 413 });
/** A bare 200 ack (verified + handled; nothing to echo). */
export const OK = Object.freeze({ status: 200 });
//# sourceMappingURL=request.js.map