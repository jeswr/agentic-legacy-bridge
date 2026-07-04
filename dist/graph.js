// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Assemble the AGENTIC RDF graph for one inbound message: the raw-message anchor
 * (`prov:Entity` + `schema:Message` + `agentic:RawInboundMessage`, LEGACY-INTEROP.md
 * §2.2), the sender {@link addSenderPerson Person}, and the reliability-tagged
 * {@link addInterpretation interpretations} (§3b) — one owner-private Turtle doc,
 * serialised with `n3.Writer` (never hand-built triples).
 *
 * The raw BYTES themselves are stored separately as a byte-exact sibling resource
 * (so the provenance anchor is real + auditable); this graph carries their SHA-256
 * digest and, when known, a `schema:url` link to that resource.
 */
import { DataFactory, Store, Writer } from "n3";
import { addInterpretation } from "./reliability.js";
import { asUrn, safeHttpIri, sanitizeText } from "./safe-iri.js";
import { addSenderPerson } from "./sender.js";
import { AGENTIC_CHANNEL, AGENTIC_RAW_DIGEST, AGENTIC_RAW_INBOUND_MESSAGE, AGENTIC_RAW_MEDIA_TYPE, PREFIXES, PROV_ENTITY, RDF_TYPE, SCHEMA_DATE_RECEIVED, SCHEMA_DATE_SENT, SCHEMA_MESSAGE, SCHEMA_SENDER, SCHEMA_URL, XSD, } from "./vocab.js";
const { namedNode, literal } = DataFactory;
/** Build the agentic Turtle graph for one inbound message. */
export async function buildAgenticGraph(options) {
    const store = new Store();
    // Re-validate the raw-message anchor before it becomes a `namedNode()`. Although
    // this IRI is normally minted internally (a `urn:agentic:raw:…`, safe by
    // construction), `buildAgenticGraph` is a public API — an untrusted or malformed
    // value carrying an IRIREF-forbidden char (`>`, newline, …) would break out of the
    // Turtle `<...>` and inject arbitrary triples (potentially into a `.acl`). Route it
    // through `safeHttpIri ?? asUrn` (the same guard `addInterpretation` uses) and fail
    // closed if neither accepts it — there is no safe anchor to build the graph on.
    const rawMessageIri = safeHttpIri(options.rawMessageIri) ?? asUrn(options.rawMessageIri);
    if (rawMessageIri === undefined) {
        throw new TypeError("buildAgenticGraph: rawMessageIri must be a safe absolute http(s) or urn: IRI");
    }
    const raw = namedNode(rawMessageIri);
    // --- raw-message anchor ---
    store.addQuad(raw, namedNode(RDF_TYPE), namedNode(PROV_ENTITY));
    store.addQuad(raw, namedNode(RDF_TYPE), namedNode(SCHEMA_MESSAGE));
    store.addQuad(raw, namedNode(RDF_TYPE), namedNode(AGENTIC_RAW_INBOUND_MESSAGE));
    store.addQuad(raw, namedNode(AGENTIC_CHANNEL), literal(sanitizeText(options.channel).slice(0, 64)));
    store.addQuad(raw, namedNode(AGENTIC_RAW_MEDIA_TYPE), literal(sanitizeMediaType(options.rawMediaType) ?? "message/rfc822"));
    store.addQuad(raw, namedNode(AGENTIC_RAW_DIGEST), literal(`sha256:${options.message.rawSha256}`));
    const receivedAt = isoOrNow(options.receivedAt);
    store.addQuad(raw, namedNode(SCHEMA_DATE_RECEIVED), literal(receivedAt, namedNode(`${XSD}dateTime`)));
    if (options.message.date !== undefined) {
        store.addQuad(raw, namedNode(SCHEMA_DATE_SENT), literal(options.message.date, namedNode(`${XSD}dateTime`)));
    }
    const rawResource = safeHttpIri(options.rawResourceIri);
    if (rawResource !== undefined) {
        store.addQuad(raw, namedNode(SCHEMA_URL), namedNode(rawResource));
    }
    // --- sender ---
    const { personIri } = addSenderPerson(store, options.message, {
        ...(options.candidateWebIds !== undefined ? { candidateWebIds: options.candidateWebIds } : {}),
    });
    store.addQuad(raw, namedNode(SCHEMA_SENDER), namedNode(personIri));
    // --- interpretations ---
    const interpretationIris = [];
    const interps = options.interpretations ?? [];
    for (let i = 0; i < interps.length; i++) {
        const iri = addInterpretation(store, interps[i], i + 1, {
            docIri: options.docIri,
            rawMessageIri,
            ...(options.interpretingAgentWebId !== undefined
                ? { interpretingAgentWebId: options.interpretingAgentWebId }
                : {}),
            ...(options.mandateIri !== undefined ? { mandateIri: options.mandateIri } : {}),
            endedAtTime: receivedAt,
        });
        if (iri !== undefined)
            interpretationIris.push(iri);
    }
    const turtle = await serialize(store);
    return { turtle, personIri, interpretationIris };
}
/** Serialise a store to Turtle with the package prefix map. */
function serialize(store) {
    const writer = new Writer({ format: "text/turtle", prefixes: { ...PREFIXES } });
    writer.addQuads([...store]);
    return new Promise((resolve, reject) => {
        writer.end((error, result) => (error ? reject(error) : resolve(result)));
    });
}
/** Accept only a plausible `type/subtype` media type; else undefined (→ default). */
function sanitizeMediaType(value) {
    if (value === undefined)
        return undefined;
    const v = sanitizeText(value).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(v)
        ? v
        : undefined;
}
/** Return `iso` if valid, else now. */
function isoOrNow(iso) {
    if (iso !== undefined) {
        const ms = Date.parse(iso);
        if (!Number.isNaN(ms))
            return new Date(ms).toISOString();
    }
    return new Date().toISOString();
}
//# sourceMappingURL=graph.js.map