// AUTHORED-BY Claude Fable 5
/**
 * The NAMED, CONTENT-ADDRESSED exchange patterns (metadata-protocol Rule 3 —
 * `NOW-PERSONAL-AGENT.md` §5.3): each recurring exchange shape is published as a
 * SHACL shape at a stable IRI under the existing `w3id.org/jeswr/agentic` home and
 * referenced from every instance with `dct:conformsTo` — reusing Dublin Core, minting
 * no new term. Each pattern document is additionally identified by its **SHA-256 over
 * the RDFC-1.0 canonical N-Quads** — exactly the `jeswr/a2a-rdf-extension`
 * protocol-document mechanism (`sha256:` + lowercase hex; a breaking change to either
 * the canonicalization or the digest is a breaking change to the extension) — so two
 * agents agree on PRECISELY which pattern, fail-closed on mismatch, with no trust in
 * the hosting URL.
 *
 * A peer meeting a pattern for the first time may use its own LLM ONCE to bind the
 * shape to its local model, then caches `(pattern hash → handler)`; every subsequent
 * instance is verify → match → SHACL-validate → run the cached handler —
 * deterministic, zero model inference, on both sides, forever after. The
 * {@link KNOWN_PATTERN_HASHES} table is this package's own pre-cached copy ("ship the
 * common shapes pre-cached"), and {@link verifyPatternDocument} is the fail-closed
 * check a consumer runs on a FETCHED pattern document before trusting it (pattern
 * IRIs are never auto-dereferenced from untrusted input — fetch through
 * `@jeswr/guarded-fetch`, verify the hash, cache).
 *
 * The shape TEXT constants below are the normative source in this package; comments
 * are Turtle comments (stripped by the parse), so the hash pins the GRAPH, not the
 * prose. Publishing them at their `w3id.org` IRIs is a `needs:user` redirect follow-up
 * (same as the `agentic:` namespace itself).
 */
import { createHash } from "node:crypto";
import { parseRdf } from "@jeswr/fetch-rdf";
import canonize from "rdf-canonize";
/** The stable pattern-IRI home (under the existing minted `agentic` w3id namespace). */
export const AGENTIC_PATTERNS = "https://w3id.org/jeswr/agentic/patterns/";
/** The `sent-at` message-envelope pattern IRI (Rule 2's flagship "sent at <time>"). */
export const SENT_AT_PATTERN_IRI = `${AGENTIC_PATTERNS}sent-at`;
/** The `propose-times` pattern IRI (the §5.4 worked example's outbound shape). */
export const PROPOSE_TIMES_PATTERN_IRI = `${AGENTIC_PATTERNS}propose-times`;
/**
 * The `sent-at` pattern document: the machine-readable envelope every outbound
 * action/reply carries — WHEN it was sent (`schema:dateSent`, an exact UTC
 * `xsd:dateTime`), WHO sent it (`schema:sender`, an IRI) and, for replies, WHAT it
 * answers (`agentic:inReplyTo`, the raw-message anchor). A peer applies the shape to
 * the node that declares `dct:conformsTo` (explicit focus node — the shape carries no
 * target so it composes with any action type).
 */
export const SENT_AT_PATTERN_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix schema: <https://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix agentic: <https://w3id.org/jeswr/agentic#> .

<https://w3id.org/jeswr/agentic/patterns/sent-at>
  a sh:NodeShape ;
  dct:title "sent-at" ;
  dct:description "The message-envelope pattern: schema:dateSent (exactly one xsd:dateTime, UTC), an optional schema:sender IRI, and an optional agentic:inReplyTo raw-message anchor. Apply to the node declaring dct:conformsTo." ;
  sh:property [
    sh:path schema:dateSent ;
    sh:datatype xsd:dateTime ;
    sh:minCount 1 ;
    sh:maxCount 1
  ] ;
  sh:property [
    sh:path schema:sender ;
    sh:nodeKind sh:IRI ;
    sh:maxCount 1
  ] ;
  sh:property [
    sh:path agentic:inReplyTo ;
    sh:nodeKind sh:IRI ;
    sh:maxCount 1
  ] .
`;
/**
 * The `propose-times` pattern document (the §5.4 worked example): a
 * `schema:ProposeAction` whose `schema:object` is one or more `schema:Event`s, each
 * with exactly one exact `schema:startTime`, an optional `schema:endTime` and an
 * optional `schema:name`.
 */
export const PROPOSE_TIMES_PATTERN_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix schema: <https://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .

<https://w3id.org/jeswr/agentic/patterns/propose-times>
  a sh:NodeShape ;
  dct:title "propose-times" ;
  dct:description "A schema:ProposeAction offering one or more schema:Event candidate times, each with exactly one xsd:dateTime schema:startTime (UTC), an optional schema:endTime and an optional schema:name. Apply to the node declaring dct:conformsTo." ;
  sh:class schema:ProposeAction ;
  sh:property [
    sh:path schema:object ;
    sh:minCount 1 ;
    sh:node [
      a sh:NodeShape ;
      sh:class schema:Event ;
      sh:property [
        sh:path schema:startTime ;
        sh:datatype xsd:dateTime ;
        sh:minCount 1 ;
        sh:maxCount 1
      ] ;
      sh:property [
        sh:path schema:endTime ;
        sh:datatype xsd:dateTime ;
        sh:maxCount 1
      ] ;
      sh:property [
        sh:path schema:name ;
        sh:datatype xsd:string ;
        sh:maxCount 1
      ]
    ]
  ] .
`;
/**
 * The pre-computed `sha256:` content-address of {@link SENT_AT_PATTERN_TURTLE}
 * (RDFC-1.0 canonical N-Quads → SHA-256). A unit test recomputes this from the
 * shape text via {@link hashPatternDocument}, so the constant cannot drift.
 */
export const SENT_AT_PATTERN_HASH = "sha256:1e0271727a8bb1d3f9ccd4cd4553c36c2490b70e31cc1aac193a3a440d27e45e";
/** The pre-computed `sha256:` content-address of {@link PROPOSE_TIMES_PATTERN_TURTLE}. */
export const PROPOSE_TIMES_PATTERN_HASH = "sha256:34f2e9a3395d6732adab7ea62c266fa5e03025b71ab1c685f3266d22f90be489";
/** The pre-cached `(pattern IRI → sha256 content-address)` table this package ships. */
export const KNOWN_PATTERN_HASHES = new Map([
    [SENT_AT_PATTERN_IRI, SENT_AT_PATTERN_HASH],
    [PROPOSE_TIMES_PATTERN_IRI, PROPOSE_TIMES_PATTERN_HASH],
]);
/** The pre-cached hash for a pattern IRI this package ships, else `undefined`. */
export function knownPatternHash(iri) {
    return KNOWN_PATTERN_HASHES.get(iri);
}
/**
 * Content-address a pattern document: parse the Turtle with the sanctioned
 * `@jeswr/fetch-rdf` parser (Turtle path only — never the remote-`@context` JSON-LD
 * path), canonicalize with **RDFC-1.0** (the W3C Recommendation, via `rdf-canonize`,
 * the reference implementation) and return `sha256:` + the lowercase hex SHA-256 of
 * the canonical N-Quads' UTF-8 bytes — byte-compatible with `jeswr/a2a-rdf-extension`
 * / `@jeswr/solid-a2a`'s `hashQuads`. Throws on unparseable Turtle (this hashes OUR
 * OWN or an explicitly-fetched document — a malformed one is a caller error, and
 * {@link verifyPatternDocument} is the never-throwing untrusted-input wrapper).
 */
export async function hashPatternDocument(turtle) {
    const dataset = await parseRdf(turtle, "text/turtle");
    const canonical = await canonize.canonize([...dataset], { algorithm: "RDFC-1.0" });
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    return `sha256:${digest}`;
}
/**
 * Fail-closed verification of a FETCHED pattern document against its pinned
 * content-address: `true` iff the document parses and its RDFC-1.0 hash equals
 * `expectedHash`. NEVER throws — a malformed document, a malformed hash, or any
 * internal error returns `false` (the §5.3 rule: verify the hash before trusting or
 * caching a pattern document; on mismatch, fail closed).
 */
export async function verifyPatternDocument(turtle, expectedHash) {
    if (typeof turtle !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedHash))
        return false;
    try {
        return (await hashPatternDocument(turtle)) === expectedHash;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=patterns.js.map