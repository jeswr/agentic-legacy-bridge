// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Rung 3 (LEGACY-INTEROP.md §4) — build the STRUCTURED, machine-readable carrier
 * embedded alongside the human prose in an outbound reply.
 *
 * The design's endorsed carrier (recorded in `docs/DECISIONS.md`): an **inline
 * JSON-LD** block (Gmail's own markup path — survives forwarding), signed as a
 * `@jeswr/solid-vc` Verifiable Credential **over the canonicalised graph** (so the
 * proof holds even if a mail client re-flows the HTML), plus a `multipart/alternative`
 * `application/ld+json` fallback part and an `X-Agentic-Reply` header pointing at the
 * authoritative pod copy. The onboarding link (§5) is the ratchet's teeth.
 *
 * M1 builds the carrier + wires an INJECTABLE `sign` seam (so tests are hermetic and
 * no crypto dependency is pulled in); the concrete `solid-vc` Data-Integrity signer
 * is the M2 adapter. Without a signer the payload is an honest UNSIGNED reply (it does
 * NOT claim the `VerifiableCredential` type). Every URL is injection-validated; the
 * inline JSON is HTML-escaped so it cannot break out of the `<script>` element.
 */
import { safeHttpIri, sanitizeText } from "./safe-iri.js";
import { AGENTIC } from "./vocab.js";
const MAX_NAME_CHARS = 200;
const MAX_OFFERS = 32;
/** The self-contained JSON-LD context (every term defined → deterministic RDFC-1.0). */
const INLINE_CONTEXT = [
    "https://www.w3.org/ns/credentials/v2",
    {
        agentic: AGENTIC,
        schema: "https://schema.org/",
        xsd: "http://www.w3.org/2001/XMLSchema#",
        AgenticReply: "agentic:AgenticReply",
        ProposeAction: "schema:ProposeAction",
        Event: "schema:Event",
        name: "schema:name",
        startTime: { "@id": "schema:startTime", "@type": "xsd:dateTime" },
        endTime: { "@id": "schema:endTime", "@type": "xsd:dateTime" },
        object: { "@id": "schema:object", "@container": "@set" },
        inReplyTo: "agentic:inReplyTo",
        onboarding: "agentic:onboarding",
    },
];
/**
 * Build the structured reply carrier. Pure + hermetic (the only async is an optional
 * injected signer). Invalid offered times are dropped; unsafe URLs are omitted.
 */
export async function buildReply(options) {
    const events = (options.offeredTimes ?? []).slice(0, MAX_OFFERS).flatMap((o) => {
        const start = isoOrUndefined(o.startTime);
        if (start === undefined)
            return [];
        const end = isoOrUndefined(o.endTime);
        const name = o.name === undefined ? undefined : sanitizeText(o.name).trim().slice(0, MAX_NAME_CHARS);
        const ev = { type: "Event", startTime: start };
        if (name !== undefined && name !== "")
            ev.name = name;
        if (end !== undefined)
            ev.endTime = end;
        return [ev];
    });
    const subject = { type: "ProposeAction" };
    const inReplyTo = safeUrn(options.inReplyTo);
    if (inReplyTo !== undefined)
        subject.inReplyTo = inReplyTo;
    const onboarding = safeHttpIri(options.onboardingUrl);
    if (onboarding !== undefined)
        subject.onboarding = onboarding;
    if (events.length > 0)
        subject.object = events;
    const issuer = safeHttpIri(options.issuer);
    const base = {
        "@context": INLINE_CONTEXT,
        type: ["AgenticReply"],
        ...(issuer !== undefined ? { issuer } : {}),
        credentialSubject: subject,
    };
    let credential = base;
    let signed = false;
    if (options.sign !== undefined) {
        // A signer is present → this IS a verifiable credential; claim the type, then sign.
        const toSign = {
            ...base,
            type: ["VerifiableCredential", "AgenticReply"],
        };
        const result = await options.sign(toSign);
        // Honest: only treat as signed if the signer actually attached a proof.
        if (result !== null && typeof result === "object" && "proof" in result) {
            credential = result;
            signed = true;
        }
        else {
            credential = base;
            signed = false;
        }
    }
    const json = JSON.stringify(credential, null, 2);
    const mimePart = { contentType: "application/ld+json", body: json };
    const inlineHtml = `<script type="application/ld+json">\n${htmlSafeJson(json)}\n</script>`;
    const headers = {};
    const podCopy = safeHttpIri(options.podCopyUrl);
    if (podCopy !== undefined)
        headers["X-Agentic-Reply"] = podCopy;
    const result = {
        credential,
        signed,
        inlineHtml,
        mimePart,
        headers,
        ...(onboarding !== undefined ? { onboardingBlock: onboardingBlockFor(onboarding) } : {}),
    };
    return result;
}
/**
 * Produce a `<script>`-safe form of a JSON string. Valid JSON escapes for `<`, `>`,
 * `&` and the JS line separators keep the JSON well-formed while making it impossible
 * to close the `<script>` element or open a comment/CDATA sequence — the canonical
 * JSON-in-HTML-script XSS guard.
 */
export function htmlSafeJson(json) {
    return json
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}
/** The human-readable onboarding block (§5) — one unobtrusive link (per DECISIONS.md Q3). */
function onboardingBlockFor(url) {
    return [
        "---",
        "This message includes a machine-readable version an AI assistant can act on.",
        `Want your own assistant to read it (and reply in kind)? Set one up: ${url}`,
    ].join("\n");
}
/** Validate an ISO-8601 datetime → canonical UTC ISO, or undefined. */
function isoOrUndefined(value) {
    if (value === undefined)
        return undefined;
    const ms = Date.parse(value);
    if (Number.isNaN(ms))
        return undefined;
    return new Date(ms).toISOString();
}
/** Accept only a safe `urn:agentic:*` anchor (no IRIREF-forbidden char); else undefined. */
function safeUrn(value) {
    if (value === undefined)
        return undefined;
    return /^urn:agentic:[a-z]+:[A-Za-z0-9._~%:-]+$/.test(value) ? value : undefined;
}
//# sourceMappingURL=reply.js.map