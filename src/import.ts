// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * `importInbound` — the (thin) orchestration that pulls inbound messages from a
 * {@link ChannelAdapter}, parses + interprets each, and writes them OWNER-PRIVATE
 * into a Solid pod (LEGACY-INTEROP.md §7 `importInbound`).
 *
 * Per message it writes three resources under an owner-locked container:
 *  - `<slug>.eml`      — the byte-exact raw bytes (the provenance anchor; the
 *                        extension follows the channel's `rawMediaType` — `.eml`
 *                        for `message/rfc822`, `.json` for event payloads);
 *  - `<slug>.ttl`      — the agentic graph (raw anchor + sender Person + the §3b
 *                        reliability-tagged interpretations);
 *  - `<slug>.chat.ttl` — the `@jeswr/solid-chat-interop` CanonicalMessage (for /chat).
 *
 * M2.0: the pipeline is CHANNEL-NEUTRAL — each raw message is parsed by the
 * adapter's own hardened `parse` into a `BridgeMessage` (email is the first
 * adapter, behaving exactly as M1's hard-coded `parseEmail` did).
 *
 * The owner-only ACL is written FIRST (the container is locked BEFORE any content
 * lands in it — the fail-closed precedent). Every write goes through the caller's
 * INJECTABLE authed `fetch` (the pod is the user's own trusted origin), sets
 * `redirect: "manual"` and refuses a 3xx, and is scope-guarded strictly within the
 * configured container. A malformed message is SKIPPED (never aborts the batch); a
 * write failure THROWS (never silently loses data).
 */

import { buildOwnerOnlyAclTurtle } from "./acl.js";
import { serializeCanonical } from "./canonical.js";
import type { ChannelAdapter, InboundRawMessage } from "./channel.js";
import { ChannelParseError } from "./errors.js";
import { buildAgenticGraph } from "./graph.js";
import { deterministicInterpreter, type Interpreter } from "./interpret.js";
import type { BridgeMessage } from "./message.js";
import {
  base64Url,
  base64UrlDecode,
  canonicalContainer,
  isWithinBase,
  mintUrn,
  safeHttpIri,
  safeMediaType,
} from "./safe-iri.js";

/** Options for {@link importInbound}. */
export interface ImportInboundOptions {
  /** The channel adapter to pull inbound messages from. */
  readonly adapter: ChannelAdapter;
  /**
   * An authenticated Solid `fetch` for the POD writes (DPoP/Bearer). Injectable so
   * the importer is unit-testable without a live server; the caller owns its auth.
   * NOT routed through the SSRF guard — the pod is the user's own trusted origin.
   */
  readonly writeFetch: typeof globalThis.fetch;
  /** The owner-locked pod container to write into (must end with `/`, no query/fragment). */
  readonly container: string;
  /** The owner WebID granted full control by the default owner-only ACL. */
  readonly ownerWebId: string;
  /** The interpreter to use (defaults to the hermetic deterministic reference). */
  readonly interpreter?: Interpreter;
  /** The interpreting agent's WebID (`prov:wasAssociatedWith` on each interpretation). */
  readonly interpretingAgentWebId?: string;
  /** The ODRL mandate the interpreting agent acts under (`prov:hadPlan`). */
  readonly mandateIri?: string;
  /** Supply UNVERIFIED candidate WebIDs for a sender (already discovered elsewhere). */
  readonly candidateWebIdsFor?: (message: BridgeMessage) => readonly string[] | undefined;
  /** Write the owner-only ACL first (default `true`). */
  readonly writeAcl?: boolean;
  /** "Now" for the interpreter's relative-date resolution (deterministic tests). */
  readonly now?: Date;
  /** Override the base (extension-less) in-pod URL for a message id. */
  readonly baseUrlFor?: (id: string) => string;
}

/** The outcome of an {@link importInbound} run. */
export interface ImportInboundResult {
  /** Number of messages fully written. */
  readonly written: number;
  /** Total interpretation nodes written across all messages. */
  readonly interpretations: number;
  /** Number of messages skipped (unparseable / unsafe slug). */
  readonly skipped: number;
}

/**
 * Fail CLOSED on any HTTP redirect on a trust-bearing write. Call BEFORE `res.ok`.
 * Exported so the M2.4 webhook create-only write path (`src/webhook`) enforces the
 * IDENTICAL redirect-refusal on every pod write (no divergent copy of the guard).
 */
export function assertNoRedirect(res: Response, method: string, url: string): void {
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    const safe = safeHttpIri(url) ?? "<unsafe-url>";
    throw new Error(`refusing to follow a redirect on ${method} ${safe} (status ${res.status}).`);
  }
}

/**
 * Fold a channel message id into a safe, collision-free, stable resource slug. The
 * base64url fold is total + reversible + injection-free, so a hostile id can never
 * carry an IRIREF-forbidden char into the resource URL. Exported so the M2.4 webhook
 * service (`src/webhook`) keys its create-only writes on the IDENTICAL slug — a
 * message imported by both the batch backfill and the webhook maps to the same URL.
 */
export function messageSlug(id: string): string {
  return `alb-${base64Url(id)}`;
}

/** The fixed `messageSlug` prefix (the `alb-` marker that scopes the base64url fold). */
const SLUG_PREFIX = "alb-";

/**
 * The FAIL-CLOSED inverse of {@link messageSlug}: recover the original channel message
 * id from a resource slug, or `undefined` if the slug is not the CANONICAL encoding of
 * any id. Used by the decoupled M2.5a sweep to key a Pending resource's raw-anchor
 * re-parse back onto its channel message (§1.3). Because {@link base64UrlDecode} is
 * exact (it rejects any non-canonical segment), this satisfies the round-trip identity
 * `slugToMessageId(messageSlug(id)) === id` for every id, AND
 * `messageSlug(slugToMessageId(slug)) === slug` for every slug it accepts — so a
 * tampered / un-reversible slug decodes to `undefined` and the sweep skips it rather
 * than mis-attributing a re-parse to the wrong message.
 */
export function slugToMessageId(slug: unknown): string | undefined {
  if (typeof slug !== "string" || !slug.startsWith(SLUG_PREFIX)) return undefined;
  const decoded = base64UrlDecode(slug.slice(SLUG_PREFIX.length));
  if (decoded === undefined) return undefined;
  // Defence in depth: re-derive the slug from the decode and require exact equality, so
  // `slugToMessageId` can NEVER return an id whose own `messageSlug` differs from the
  // input (the property the sweep's mis-attribution guard leans on).
  return messageSlug(decoded) === slug ? decoded : undefined;
}

/**
 * Resolve + validate a pod write URL strictly within the container (fail-closed).
 * Exported so the webhook create-only writer shares the ONE within-container scope
 * guard (a write can never escape the configured container).
 */
export function assertWritableUrl(url: string, container: string): string {
  const safe = safeHttpIri(url);
  if (safe === undefined || !isWithinBase(safe, container)) {
    throw new Error("refusing a pod write to a resource outside the configured container base.");
  }
  return safe;
}

/** PUT a resource via the injectable authed fetch; throw on redirect / non-2xx. */
async function put(
  writeFetch: typeof globalThis.fetch,
  url: string,
  contentType: string,
  body: string | Uint8Array,
): Promise<void> {
  const res = await writeFetch(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
    redirect: "manual",
  });
  assertNoRedirect(res, "PUT", url);
  if (!res.ok) {
    throw new Error(`pod write failed: PUT ${url} -> ${res.status} ${res.statusText}`);
  }
}

/**
 * Import a channel's inbound messages into a Solid pod (owner-private). Returns a
 * count summary. See the module doc for the write layout + fail-closed posture.
 *
 * @throws if `container` is not a safe container IRI, `writeAcl` is set without an
 *   `ownerWebId`, the adapter does not implement the M2.0 `parse` method, or any
 *   pod write fails (redirect / non-2xx).
 */
export async function importInbound(options: ImportInboundOptions): Promise<ImportInboundResult> {
  const container = canonicalContainer(options.container);
  if (container === undefined) {
    throw new Error(
      "container must be a safe http(s) container IRI ending in '/' with no query or fragment.",
    );
  }
  // Fail FAST (before any pod write) on a pre-M2.0 adapter shape, with a targeted
  // error — a stale JS consumer must not fail mid-batch with "parse is not a function".
  if (typeof options.adapter.parse !== "function") {
    throw new Error(
      "adapter must implement parse(item) -> BridgeMessage (the M2.0 ChannelAdapter seam; " +
        "for email, use parseEmailInbound / InMemoryChannelAdapter's default).",
    );
  }
  const writeAcl = options.writeAcl ?? true;
  if (
    writeAcl &&
    (options.ownerWebId === undefined || safeHttpIri(options.ownerWebId) === undefined)
  ) {
    throw new Error("writeAcl is enabled but ownerWebId is missing or not a safe http(s) IRI.");
  }

  const interpreter = options.interpreter ?? deterministicInterpreter;
  const baseUrlFor = options.baseUrlFor ?? ((id: string) => `${container}${messageSlug(id)}`);

  // Lock the container BEFORE any content lands in it.
  if (writeAcl) {
    const aclUrl = `${container}.acl`;
    const aclTurtle = await buildOwnerOnlyAclTurtle(container, options.ownerWebId);
    await put(options.writeFetch, aclUrl, "text/turtle", aclTurtle);
  }

  const inbound = await options.adapter.pullInbound();
  let written = 0;
  let interpretations = 0;
  let skipped = 0;

  for (const item of inbound) {
    const outcome = await importOne(item, {
      ...options,
      container,
      baseUrlFor,
      interpreter,
    });
    if (outcome === undefined) {
      skipped++;
      continue;
    }
    written++;
    interpretations += outcome.interpretations;
  }

  return { written, interpretations, skipped };
}

interface ImportOneCtx extends ImportInboundOptions {
  readonly container: string;
  readonly baseUrlFor: (id: string) => string;
  readonly interpreter: Interpreter;
}

/**
 * The stored raw-anchor extension for a (validated) raw media type. Exported so the
 * webhook writer names the raw anchor IDENTICALLY to the batch importer.
 */
export function rawExtensionFor(mediaType: string): string {
  switch (mediaType) {
    case "message/rfc822":
      return ".eml";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    default:
      return ".raw";
  }
}

/** Import one message; returns undefined (skipped) or a per-message summary. */
async function importOne(
  item: InboundRawMessage,
  ctx: ImportOneCtx,
): Promise<{ interpretations: number } | undefined> {
  let message: BridgeMessage;
  try {
    message = ctx.adapter.parse(item);
  } catch (err) {
    if (err instanceof ChannelParseError) return undefined; // skip an over-cap / unparseable message
    throw err;
  }

  // The adapter is caller-supplied code, but validate its media type anyway
  // (defence in depth): a malformed value falls back to octet-stream, and the raw
  // anchor's extension is derived ONLY from the validated type, never the input.
  const rawMediaType = safeMediaType(message.rawMediaType) ?? "application/octet-stream";

  const base = ctx.baseUrlFor(item.id);
  const rawUrl = assertWritableUrl(`${base}${rawExtensionFor(rawMediaType)}`, ctx.container);
  const docUrl = assertWritableUrl(`${base}.ttl`, ctx.container);
  const chatUrl = assertWritableUrl(`${base}.chat.ttl`, ctx.container);

  const rawMessageIri = mintUrn("raw", message.rawSha256);
  const interps = ctx.interpreter.interpret(message, {
    docIri: docUrl,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });

  const graph = await buildAgenticGraph({
    message,
    channel: message.channel,
    docIri: docUrl,
    rawMessageIri,
    rawResourceIri: rawUrl,
    rawMediaType,
    interpretations: interps,
    ...(ctx.candidateWebIdsFor !== undefined
      ? { candidateWebIds: ctx.candidateWebIdsFor(message) ?? [] }
      : {}),
    ...(ctx.interpretingAgentWebId !== undefined
      ? { interpretingAgentWebId: ctx.interpretingAgentWebId }
      : {}),
    ...(ctx.mandateIri !== undefined ? { mandateIri: ctx.mandateIri } : {}),
  });
  const chatTurtle = await serializeCanonical(message, chatUrl);

  // Raw bytes first (the anchor), then the graph, then the canonical chat resource.
  await put(ctx.writeFetch, rawUrl, rawMediaType, item.raw);
  await put(ctx.writeFetch, docUrl, "text/turtle", graph.turtle);
  await put(ctx.writeFetch, chatUrl, "text/turtle", chatTurtle);

  return { interpretations: graph.interpretationIris.length };
}
