// AUTHORED-BY Claude Fable 5
/**
 * A thin WinterCG `fetch`-handler adapter (M2-DESIGN.md §3.1) — wraps the framework-
 * free {@link createWebhookHandler} core as a `(Request) => Promise<Response>` for
 * Vercel / Node / Cloudflare-worker deployment. It does ONE job: capture the request
 * faithfully (the EXACT raw body bytes for signature verification, the headers, the
 * `hub.*` query for the Meta handshake) and map the core's response back. No security
 * logic lives here — it is all in the verified core.
 */
import { createWebhookHandler } from "./handler.js";
/**
 * Build a WinterCG `fetch` handler from the same {@link WebhookHandlerOptions}. The
 * body is read verbatim via `request.arrayBuffer()` (so signature verification runs
 * over the EXACT bytes the channel signed — never a re-serialised JSON round-trip),
 * and header/query maps are built null-prototype-safe (a hostile `__proto__` header
 * name becomes an ordinary own property, never touches the prototype chain).
 */
export function createFetchWebhookHandler(options) {
    const handler = createWebhookHandler(options);
    return async (request) => {
        const rawBody = new Uint8Array(await request.arrayBuffer());
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