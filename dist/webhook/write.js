// AUTHORED-BY Claude Fable 5
/**
 * The M2.4 webhook CREATE-ONLY pod write (M2-DESIGN.md §3.3/§3.4) — the persistence
 * half of the stateless webhook service. Where the batch {@link importInbound} writes
 * with a plain `PUT` (overwrite), the webhook service writes every resource
 * create-only with `If-None-Match: *` and treats a `412 Precondition Failed` as
 * "already imported". That single discipline gives the service its two load-bearing
 * properties for free:
 *
 *  - **Idempotency / replay-safety.** A Slack retry (same `event_id`/`ts`), a Meta
 *    36-hour redelivery (same wamid), or an attacker-replayed still-valid-window
 *    request all map — via the deterministic {@link messageSlug} keyed on the STABLE
 *    message id — to the SAME URLs, and the create-only write no-ops (412) instead of
 *    double-writing. No dedupe table, no shared cache, no sticky instance.
 *  - **Least privilege.** The bridge's pod identity needs only `acl:Append`
 *    (create-inside), never `Write`/`Control`: it can ADD an inbox item but cannot
 *    modify or delete anything already there (tamper-evidence by construction). This
 *    writer NEVER writes an ACL at runtime — the owner provisions the container ACL
 *    ONCE (via {@link buildOwnerOnlyAclTurtle}); see {@link WriteMessageOptions.writeAcl}
 *    is absent by design here.
 *
 * Partial-write recovery: because each of the three resources is written create-only
 * INDEPENDENTLY, a delivery that failed after writing only the raw anchor is HEALED on
 * the platform's retry — the already-written raw 412s (skipped) and the missing graph/
 * chat resources are created. The batch importer's redirect-refusal + within-container
 * scope guard are reused verbatim (no divergent copy).
 */
import { serializeCanonical } from "../canonical.js";
import { buildAgenticGraph } from "../graph.js";
import { assertNoRedirect, assertWritableUrl, messageSlug, rawExtensionFor } from "../import.js";
import { deterministicInterpreter } from "../interpret.js";
import { mintUrn, safeMediaType } from "../safe-iri.js";
/**
 * PUT a resource create-only (`If-None-Match: *`) via the injectable authed fetch.
 * Refuses a redirect (fail-closed), treats only `412` (precondition failed on an
 * existing resource) as `"exists"`, and throws on any other non-2xx. The redirect
 * guard runs BEFORE the status inspection.
 */
async function putCreateOnly(writeFetch, url, contentType, body) {
    const res = await writeFetch(url, {
        method: "PUT",
        headers: { "content-type": contentType, "if-none-match": "*" },
        body,
        redirect: "manual",
    });
    assertNoRedirect(res, "PUT", url);
    // A failed `If-None-Match: *` precondition (the resource already exists) is the
    // idempotent replay path — NOT an error. The spec status for a failed precondition
    // is 412 (Solid/CSS); we treat ONLY 412 as already-imported. A 409 Conflict can be a
    // REAL write failure (a container conflict), so it must NOT be silently swallowed as
    // "exists" (that would drop a message with a 200) — it falls through to throw, so the
    // handler answers 500 and the platform retries.
    if (res.status === 412)
        return "exists";
    if (!res.ok) {
        throw new Error(`pod write failed: PUT ${url} -> ${res.status} ${res.statusText}`);
    }
    return "created";
}
/**
 * Write ONE inbound message into the pod OWNER-PRIVATE, create-only + idempotent.
 * Builds the same three resources as {@link importInbound} (byte-exact raw anchor +
 * agentic graph + canonical chat message) through the SAME hardened builders, then
 * writes each create-only. Returns a per-message summary.
 *
 * The idempotency slug is keyed on the parsed STABLE message id
 * ({@link BridgeMessage.messageId} — a Slack conversation-qualified ts / a WhatsApp
 * wamid), falling back to the raw-bytes digest only if a (non-standard) adapter omits
 * it — so a retried/replayed delivery, and a later backfill of the same message, both
 * resolve to the same URLs.
 *
 * @throws if a pod write fails (redirect / non-2xx other than the 412 exists path)
 *   or a resource URL escapes the configured container.
 */
export async function writeMessageCreateOnly(options) {
    const message = options.message;
    const slugKey = message.messageId !== undefined && message.messageId.length > 0
        ? message.messageId
        : message.rawSha256;
    const slug = messageSlug(slugKey);
    const baseUrlFor = options.baseUrlFor ?? ((key) => `${options.container}${messageSlug(key)}`);
    const base = baseUrlFor(slugKey);
    const rawMediaType = safeMediaType(message.rawMediaType) ?? "application/octet-stream";
    const rawUrl = assertWritableUrl(`${base}${rawExtensionFor(rawMediaType)}`, options.container);
    const docUrl = assertWritableUrl(`${base}.ttl`, options.container);
    const chatUrl = assertWritableUrl(`${base}.chat.ttl`, options.container);
    const interpreter = options.interpreter ?? deterministicInterpreter;
    const interps = interpreter.interpret(message, {
        docIri: docUrl,
        ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const rawMessageIri = mintUrn("raw", message.rawSha256);
    const interpretationStatus = options.markPendingInterpretation
        ? "pending"
        : undefined;
    const graph = await buildAgenticGraph({
        message,
        channel: message.channel,
        docIri: docUrl,
        rawMessageIri,
        rawResourceIri: rawUrl,
        rawMediaType,
        interpretations: interps,
        ...(interpretationStatus !== undefined ? { interpretationStatus } : {}),
        ...(options.candidateWebIds !== undefined ? { candidateWebIds: options.candidateWebIds } : {}),
        ...(options.interpretingAgentWebId !== undefined
            ? { interpretingAgentWebId: options.interpretingAgentWebId }
            : {}),
        ...(options.mandateIri !== undefined ? { mandateIri: options.mandateIri } : {}),
    });
    const chatTurtle = await serializeCanonical(message, chatUrl);
    // Raw bytes first (the anchor), then the graph, then the canonical chat resource —
    // each create-only + independently idempotent (so a partial delivery heals on retry).
    const rawOutcome = await putCreateOnly(options.writeFetch, rawUrl, rawMediaType, options.raw);
    const docOutcome = await putCreateOnly(options.writeFetch, docUrl, "text/turtle", graph.turtle);
    const chatOutcome = await putCreateOnly(options.writeFetch, chatUrl, "text/turtle", chatTurtle);
    const created = rawOutcome === "created" || docOutcome === "created" || chatOutcome === "created";
    return { slug, created, interpretations: graph.interpretationIris.length };
}
//# sourceMappingURL=write.js.map