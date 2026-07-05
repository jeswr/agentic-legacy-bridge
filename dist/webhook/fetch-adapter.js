// AUTHORED-BY Claude Fable 5
/**
 * A thin WinterCG `fetch`-handler adapter (M2-DESIGN.md §3.1) — wraps the framework-
 * free {@link createWebhookHandler} core as a `(Request) => Promise<Response>` for
 * Vercel / Node / Cloudflare-worker deployment. It does ONE job: capture the request
 * faithfully (the EXACT raw body bytes for signature verification, the headers, the
 * `hub.*` query for the Meta handshake) and map the core's response back. No security
 * logic lives here — it is all in the verified core.
 */
import { readAllBounded } from "../stream-limit.js";
import { createWebhookHandler, DEFAULT_MAX_BODY_BYTES, } from "./handler.js";
/**
 * Build a WinterCG `fetch` handler from the same {@link WebhookHandlerOptions}. The
 * body is read verbatim (so signature verification runs over the EXACT bytes the
 * channel signed — never a re-serialised JSON round-trip) but BOUNDED: an advertised
 * `Content-Length` over the cap is rejected `413` before reading, and the stream read
 * aborts the moment it exceeds the cap — an oversized unauthenticated request can never
 * force full body buffering (defence BEFORE the handler's own size gate). Header/query
 * maps are built null-prototype-safe (a hostile `__proto__` header name becomes an
 * ordinary own property, never touches the prototype chain).
 */
export function createFetchWebhookHandler(options) {
    const handler = createWebhookHandler(options);
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return async (request) => {
        // Reject an over-cap Content-Length before reading a single byte.
        const declaredLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
            return new Response(null, { status: 413 });
        }
        // Read the body bounded — abort (413) the moment it exceeds the cap.
        const rawBody = await readAllBounded(request.body, maxBodyBytes);
        if (rawBody === undefined) {
            return new Response(null, { status: 413 });
        }
        const headers = Object.create(null);
        request.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });
        const query = Object.create(null);
        for (const [key, value] of new URL(request.url).searchParams) {
            query[key] = value;
        }
        const response = await handler({
            method: request.method,
            headers,
            rawBody,
            query,
        });
        return new Response(response.body ?? null, {
            status: response.status,
            ...(response.headers !== undefined ? { headers: { ...response.headers } } : {}),
        });
    };
}
//# sourceMappingURL=fetch-adapter.js.map