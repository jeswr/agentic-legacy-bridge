/**
 * A thin WinterCG `fetch`-handler adapter (M2-DESIGN.md §3.1) — wraps the framework-
 * free {@link createWebhookHandler} core as a `(Request) => Promise<Response>` for
 * Vercel / Node / Cloudflare-worker deployment. It does ONE job: capture the request
 * faithfully (the EXACT raw body bytes for signature verification, the headers, the
 * `hub.*` query for the Meta handshake) and map the core's response back. No security
 * logic lives here — it is all in the verified core.
 */
import { type WebhookHandlerOptions } from "./handler.js";
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
export declare function createFetchWebhookHandler(options: WebhookHandlerOptions): (request: Request) => Promise<Response>;
//# sourceMappingURL=fetch-adapter.d.ts.map