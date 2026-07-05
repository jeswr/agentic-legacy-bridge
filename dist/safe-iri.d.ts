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
 * The FAIL-CLOSED inverse of {@link base64Url}: decode an unpadded base64url segment
 * back to its original UTF-8 string, or `undefined` if the segment is not the CANONICAL
 * encoding of any string. Node's base64 decoder is lenient (it accepts padding,
 * non-canonical trailing bits, and `+`/`/` aliases), so a bare decode is NOT injective —
 * a tampered/aliased segment could decode to a value whose re-encoding differs. This
 * helper therefore RE-ENCODES the decode and rejects any input that is not byte-identical
 * to `base64Url(decoded)`. That makes {@link base64UrlDecode}(x) defined ⟺
 * `base64Url(base64UrlDecode(x)) === x`, so the round-trip is exact and a hostile
 * resource-slug segment cannot be mis-decoded into a DIFFERENT identifier (M2.5a §1.3 —
 * the reversible-slug integrity guard the decoupled sweep relies on to avoid
 * mis-attribution).
 */
export declare function base64UrlDecode(segment: unknown): string | undefined;
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
/**
 * Build an injection-safe `tel:` IRI (RFC 3966 global-number form) for an
 * UNTRUSTED phone-number handle, or `undefined` if it is not strict E.164
 * (M2-DESIGN.md §1.2 — the `safeMailtoIri` sibling for phone-keyed channels like
 * WhatsApp). The accepted alphabet is `+` and digits only, so the result carries
 * no IRIREF-forbidden char by construction. NEVER pass a raw number to `namedNode`.
 */
export declare function safeTelIri(value: unknown): string | undefined;
/**
 * Accept only a plausible lower-cased `type/subtype` media type (RFC 6838 token
 * shape, length-capped) from an UNTRUSTED value; else `undefined`. Used before a
 * media type becomes a stored-literal or an HTTP `content-type` — a malformed
 * value falls back to the caller's safe default, never travels verbatim.
 */
export declare function safeMediaType(value: unknown): string | undefined;
//# sourceMappingURL=safe-iri.d.ts.map