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
/** The stable pattern-IRI home (under the existing minted `agentic` w3id namespace). */
export declare const AGENTIC_PATTERNS = "https://w3id.org/jeswr/agentic/patterns/";
/** The `sent-at` message-envelope pattern IRI (Rule 2's flagship "sent at <time>"). */
export declare const SENT_AT_PATTERN_IRI = "https://w3id.org/jeswr/agentic/patterns/sent-at";
/** The `propose-times` pattern IRI (the §5.4 worked example's outbound shape). */
export declare const PROPOSE_TIMES_PATTERN_IRI = "https://w3id.org/jeswr/agentic/patterns/propose-times";
/**
 * The `sent-at` pattern document: the machine-readable envelope every outbound
 * action/reply carries — WHEN it was sent (`schema:dateSent`, an exact UTC
 * `xsd:dateTime`), WHO sent it (`schema:sender`, an IRI) and, for replies, WHAT it
 * answers (`agentic:inReplyTo`, the raw-message anchor). A peer applies the shape to
 * the node that declares `dct:conformsTo` (explicit focus node — the shape carries no
 * target so it composes with any action type).
 */
export declare const SENT_AT_PATTERN_TURTLE = "@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n@prefix dct: <http://purl.org/dc/terms/> .\n@prefix agentic: <https://w3id.org/jeswr/agentic#> .\n\n<https://w3id.org/jeswr/agentic/patterns/sent-at>\n  a sh:NodeShape ;\n  dct:title \"sent-at\" ;\n  dct:description \"The message-envelope pattern: schema:dateSent (exactly one xsd:dateTime, UTC), an optional schema:sender IRI, and an optional agentic:inReplyTo raw-message anchor. Apply to the node declaring dct:conformsTo.\" ;\n  sh:property [\n    sh:path schema:dateSent ;\n    sh:datatype xsd:dateTime ;\n    sh:minCount 1 ;\n    sh:maxCount 1\n  ] ;\n  sh:property [\n    sh:path schema:sender ;\n    sh:nodeKind sh:IRI ;\n    sh:maxCount 1\n  ] ;\n  sh:property [\n    sh:path agentic:inReplyTo ;\n    sh:nodeKind sh:IRI ;\n    sh:maxCount 1\n  ] .\n";
/**
 * The `propose-times` pattern document (the §5.4 worked example): a
 * `schema:ProposeAction` whose `schema:object` is one or more `schema:Event`s, each
 * with exactly one exact `schema:startTime`, an optional `schema:endTime` and an
 * optional `schema:name`.
 */
export declare const PROPOSE_TIMES_PATTERN_TURTLE = "@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n@prefix dct: <http://purl.org/dc/terms/> .\n\n<https://w3id.org/jeswr/agentic/patterns/propose-times>\n  a sh:NodeShape ;\n  dct:title \"propose-times\" ;\n  dct:description \"A schema:ProposeAction offering one or more schema:Event candidate times, each with exactly one xsd:dateTime schema:startTime (UTC), an optional schema:endTime and an optional schema:name. Apply to the node declaring dct:conformsTo.\" ;\n  sh:class schema:ProposeAction ;\n  sh:property [\n    sh:path schema:object ;\n    sh:minCount 1 ;\n    sh:node [\n      a sh:NodeShape ;\n      sh:class schema:Event ;\n      sh:property [\n        sh:path schema:startTime ;\n        sh:datatype xsd:dateTime ;\n        sh:minCount 1 ;\n        sh:maxCount 1\n      ] ;\n      sh:property [\n        sh:path schema:endTime ;\n        sh:datatype xsd:dateTime ;\n        sh:maxCount 1\n      ] ;\n      sh:property [\n        sh:path schema:name ;\n        sh:datatype xsd:string ;\n        sh:maxCount 1\n      ]\n    ]\n  ] .\n";
/**
 * The pre-computed `sha256:` content-address of {@link SENT_AT_PATTERN_TURTLE}
 * (RDFC-1.0 canonical N-Quads → SHA-256). A unit test recomputes this from the
 * shape text via {@link hashPatternDocument}, so the constant cannot drift.
 */
export declare const SENT_AT_PATTERN_HASH = "sha256:1e0271727a8bb1d3f9ccd4cd4553c36c2490b70e31cc1aac193a3a440d27e45e";
/** The pre-computed `sha256:` content-address of {@link PROPOSE_TIMES_PATTERN_TURTLE}. */
export declare const PROPOSE_TIMES_PATTERN_HASH = "sha256:34f2e9a3395d6732adab7ea62c266fa5e03025b71ab1c685f3266d22f90be489";
/** The pre-cached `(pattern IRI → sha256 content-address)` table this package ships. */
export declare const KNOWN_PATTERN_HASHES: ReadonlyMap<string, string>;
/** The pre-cached hash for a pattern IRI this package ships, else `undefined`. */
export declare function knownPatternHash(iri: string): string | undefined;
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
export declare function hashPatternDocument(turtle: string): Promise<string>;
/**
 * Fail-closed verification of a FETCHED pattern document against its pinned
 * content-address: `true` iff the document parses and its RDFC-1.0 hash equals
 * `expectedHash`. NEVER throws — a malformed document, a malformed hash, or any
 * internal error returns `false` (the §5.3 rule: verify the hash before trusting or
 * caching a pattern document; on mismatch, fail closed).
 */
export declare function verifyPatternDocument(turtle: string, expectedHash: string): Promise<boolean>;
//# sourceMappingURL=patterns.d.ts.map