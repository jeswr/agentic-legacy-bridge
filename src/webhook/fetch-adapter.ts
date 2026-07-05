// AUTHORED-BY Claude Fable 5
/**
 * A thin WinterCG `fetch`-handler adapter (M2-DESIGN.md §3.1) — wraps the framework-
 * free {@link createWebhookHandler} core as a `(Request) => Promise<Response>` for
 * Vercel / Node / Cloudflare-worker deployment. It does ONE job: capture the request
 * faithfully (the EXACT raw body bytes for signature verification, the headers, the
 * `hub.*` query for the Meta handshake) and map the core's response back. No security
 * logic lives here — it is all in the verified core.
 */

import { createWebhookHandler, type WebhookHandlerOptions } from "./handler.js";
import type { WebhookResponse } from "./request.js";

/**
 * Build a WinterCG `fetch` handler from the same {@link WebhookHandlerOptions}. The
 * body is read verbatim via `request.arrayBuffer()` (so signature verification runs
 * over the EXACT bytes the channel signed — never a re-serialised JSON round-trip),
 * and header/query maps are built null-prototype-safe (a hostile `__proto__` header
 * name becomes an ordinary own property, never touches the prototype chain).
 */
export function createFetchWebhookHandler(
  options: WebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  const handler = createWebhookHandler(options);
  return async (request: Request): Promise<Response> => {
    const rawBody = new Uint8Array(await request.arrayBuffer());

    const headers: Record<string, string> = Object.create(null);
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const query: Record<string, string> = Object.create(null);
    for (const [key, value] of new URL(request.url).searchParams) {
      query[key] = value;
    }

    const response: WebhookResponse = await handler({
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
