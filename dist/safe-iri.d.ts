/**
 * Untrusted-IRI hardening for the n3.Writer / RDF write path — the single home for
 * "an untrusted string is about to become a `namedNode()`".
 *
 * `n3.Writer` (and any serializer that emits `<...>` IRIREFs) does NOT escape the
 * IRI it is given — it writes the string between the angle brackets verbatim. So a
 * value reaching `namedNode()` carrying a `>` (or a newline, or any other
 * IRIREF-forbidden char) BREAKS OUT of the `<...>` and injects arbitrary triples.
 * In this package the injected document could be a `.acl` — turning an owner-private
 * container PUBLIC — so a bare "is it an http(s) URL?" boolean is NOT sufficient.
 *
 * Ported from `@jeswr/matrix-chat-to-pod` (the sibling legacy→pod bridge) plus two
 * bridge-specific minting helpers ({@link safeMailtoIri}, {@link mintUrn}) for the
 * `mailto:`/`urn:` values this package produces for legacy senders and raw messages.
 */
/**
 * Return an injection-safe, canonical absolute http(s) IRI for an UNTRUSTED value,
 * or `undefined` if the value is not a usable http(s) IRI. NEVER returns the raw
 * input — always the canonicalised, fully-escaped form. Use this (not a boolean
 * `isHttpIri`) at every site where an untrusted string becomes a `namedNode()`.
 */
export declare function safeHttpIri(value: unknown): string | undefined;
/**
 * Canonicalise + validate a SOLID CONTAINER IRI, or `undefined` if it is not a
 * usable owner-lockable container. A container is the ACL anchor, so it must be
 * UNAMBIGUOUS: an injection-safe absolute http(s) IRI whose PATH ends in `/` and
 * that carries NO query (`?`) or fragment (`#`) and no encoded delimiter. The
 * returned value is the ONE canonical container string every caller must use for
 * BOTH the ACL URL and every scope check — no downstream code may re-derive from
 * the raw input.
 */
export declare function canonicalContainer(container: unknown): string | undefined;
/**
 * True when `resourceUrl` is an http(s) IRI STRICTLY within the `base` container —
 * same origin AND a path strictly under the container's path. Both inputs are
 * canonicalised through {@link safeHttpIri} FIRST (RDF-injection-safety), then the
 * origin/segment-boundary/traversal/encoded-delimiter checks are DELEGATED to
 * `@jeswr/guarded-fetch`'s consolidated pod-scope primitive. Fail-closed.
 *
 * NOTE the argument order: `(resourceUrl, base)` here, `(base, url)` on the delegate.
 */
export declare function isWithinBase(resourceUrl: string, base: string): boolean;
/** Strip non-whitespace control characters from an untrusted text body/literal. */
export declare function sanitizeText(value: string): string;
/**
 * True for a conservatively-valid email addr-spec (`local@domain`). Used as the
 * gate before an address becomes an identity key, a `mailto:` IRI, or a DKIM domain.
 */
export declare function isValidEmailAddress(value: unknown): value is string;
/**
 * Lower-case the DOMAIN half of a valid addr-spec (case-insensitive per RFC 5321)
 * while preserving the local-part case (formally case-sensitive). Returns the
 * normalised address, or `undefined` if the input is not a valid addr-spec.
 * This is the ONE canonicalisation used for identity keys so `A@Ex.COM` and
 * `A@ex.com` map to the same person node.
 */
export declare function normalizeEmailAddress(value: unknown): string | undefined;
/**
 * Build an injection-safe `mailto:` IRI (RFC 6068) for a VALIDATED addr-spec, or
 * `undefined` if the address is not usable. The local-part and domain are each
 * percent-encoded (so IRIREF-forbidden chars valid in an email local-part — `` ` ``
 * `|` `{` `}` `^` — cannot break out of a Turtle `<...>`), then a fail-closed
 * IRIREF check runs on the result. NEVER pass a raw address to `namedNode`.
 */
export declare function safeMailtoIri(address: unknown): string | undefined;
/**
 * base64url-encode arbitrary bytes/string into the `[A-Za-z0-9_-]` alphabet (no
 * padding). Total + reversible + collision-free — the safe way to fold an untrusted
 * identifier into an IRI path segment that can never carry an injection char.
 */
export declare function base64Url(input: string): string;
/**
 * Injection-safe passthrough for the INTERNAL anchor IRIs this package mints — an
 * absolute `urn:agentic:*` (and similar `urn:<nid>:<nss>`) carrying no
 * IRIREF-forbidden char. Unlike {@link mintUrn} it does not re-encode; it VALIDATES
 * an already-minted urn (`safeHttpIri(x) ?? asUrn(x)` is the pair used at every site
 * where an anchor IRI — http(s) OR our own urn — becomes a `namedNode()`). Returns
 * the value unchanged when it matches the tight `urn:` shape, else `undefined`
 * (fail-closed — a `urn:` carrying `>`/space/etc. is rejected, never injected).
 */
export declare function asUrn(value: unknown): string | undefined;
/**
 * Mint a deterministic, injection-safe `urn:agentic:<kind>:<b64url(key)>` IRI. All
 * of `kind` and the encoded `key` land in the `[A-Za-z0-9_-]`/fixed-literal space,
 * so the result carries no IRIREF-forbidden char by construction. Used for the
 * provisional Person node and the raw-message anchor — pod-local, stable, and
 * reconcilable (the SAME key always mints the SAME urn).
 */
export declare function mintUrn(kind: "person" | "raw" | "interp", key: string): string;
//# sourceMappingURL=safe-iri.d.ts.map