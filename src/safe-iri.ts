// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
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

import { isWithinPodScope } from "@jeswr/guarded-fetch";

/**
 * IRIREF-forbidden characters per the Turtle grammar: the `#x00-#x20` control +
 * space range, plus `<` `>` `"` `{` `}` `|` `^` backtick and backslash. Used as a
 * fail-closed final guard after canonicalisation/encoding.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the IRIREF-forbidden C0 range is the point.
const IRIREF_FORBIDDEN = /[\u0000-\u0020<>"{}|\\^`]/;

/** Percent-encoded path-delimiter characters (`%2F` = `/`, `%5C` = `\`), case-insensitive. */
const ENCODED_PATH_DELIMITER = /%2f|%5c/i;

/**
 * Return an injection-safe, canonical absolute http(s) IRI for an UNTRUSTED value,
 * or `undefined` if the value is not a usable http(s) IRI. NEVER returns the raw
 * input — always the canonicalised, fully-escaped form. Use this (not a boolean
 * `isHttpIri`) at every site where an untrusted string becomes a `namedNode()`.
 */
export function safeHttpIri(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let href: string;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    href = u.href;
  } catch {
    return undefined;
  }
  // The WHATWG URL parser percent-encodes the breakout chars (`<` `>` `"` space,
  // C0 controls) but leaves `|`, `^` and backtick un-encoded — all three are
  // IRIREF-forbidden, so encode them explicitly.
  const encoded = href.replace(/\|/g, "%7C").replace(/\^/g, "%5E").replace(/`/g, "%60");
  if (IRIREF_FORBIDDEN.test(encoded)) return undefined;
  return encoded;
}

/**
 * Canonicalise + validate a SOLID CONTAINER IRI, or `undefined` if it is not a
 * usable owner-lockable container. A container is the ACL anchor, so it must be
 * UNAMBIGUOUS: an injection-safe absolute http(s) IRI whose PATH ends in `/` and
 * that carries NO query (`?`) or fragment (`#`) and no encoded delimiter. The
 * returned value is the ONE canonical container string every caller must use for
 * BOTH the ACL URL and every scope check — no downstream code may re-derive from
 * the raw input.
 */
export function canonicalContainer(container: unknown): string | undefined {
  const safe = safeHttpIri(container);
  if (safe === undefined) return undefined;
  const u = new URL(safe);
  if (u.search !== "" || u.hash !== "") return undefined;
  if (!u.pathname.endsWith("/")) return undefined;
  if (ENCODED_PATH_DELIMITER.test(u.pathname)) return undefined;
  return `${u.origin}${u.pathname}`;
}

/**
 * True when `resourceUrl` is an http(s) IRI STRICTLY within the `base` container —
 * same origin AND a path strictly under the container's path. Both inputs are
 * canonicalised through {@link safeHttpIri} FIRST (RDF-injection-safety), then the
 * origin/segment-boundary/traversal/encoded-delimiter checks are DELEGATED to
 * `@jeswr/guarded-fetch`'s consolidated pod-scope primitive. Fail-closed.
 *
 * NOTE the argument order: `(resourceUrl, base)` here, `(base, url)` on the delegate.
 */
export function isWithinBase(resourceUrl: string, base: string): boolean {
  const safeResource = safeHttpIri(resourceUrl);
  const safeBase = safeHttpIri(base);
  if (safeResource === undefined || safeBase === undefined) return false;
  return isWithinPodScope(safeBase, safeResource, { allowRoot: false });
}

/**
 * C0/C1 control characters that must NOT be persisted into a pod literal. TAB, LF
 * and CR are DELIBERATELY kept (legitimate in a message body, safely escaped by the
 * Turtle writer). NUL and the rest (BEL, ESC, backspace, the C1 block, DEL, …) are
 * stripped so an untrusted message cannot smuggle a terminal-escape / display-
 * spoofing / log-injection control sequence into a stored literal.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
const STRIP_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Strip non-whitespace control characters from an untrusted text body/literal. */
export function sanitizeText(value: string): string {
  return value.replace(STRIP_CONTROL, "");
}

/**
 * A conservative addr-spec: `local@domain`, no whitespace/control/angle chars,
 * exactly one `@`, a plausible dotless-or-dotted domain. Deliberately STRICTER than
 * RFC 5322 (it rejects quoted local-parts and domain-literals) — we would rather
 * drop an exotic-but-valid address than mint an ambiguous identity key from it. The
 * local-part class is the RFC 5322 dot-atom set; the domain is LDH labels.
 */
const ADDR_SPEC =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * True for a conservatively-valid email addr-spec (`local@domain`). Used as the
 * gate before an address becomes an identity key, a `mailto:` IRI, or a DKIM domain.
 */
export function isValidEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && ADDR_SPEC.test(value);
}

/**
 * Lower-case the DOMAIN half of a valid addr-spec (case-insensitive per RFC 5321)
 * while preserving the local-part case (formally case-sensitive). Returns the
 * normalised address, or `undefined` if the input is not a valid addr-spec.
 * This is the ONE canonicalisation used for identity keys so `A@Ex.COM` and
 * `A@ex.com` map to the same person node.
 */
export function normalizeEmailAddress(value: unknown): string | undefined {
  if (!isValidEmailAddress(value)) return undefined;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  return `${local}@${domain}`;
}

/**
 * Build an injection-safe `mailto:` IRI (RFC 6068) for a VALIDATED addr-spec, or
 * `undefined` if the address is not usable. The local-part and domain are each
 * percent-encoded (so IRIREF-forbidden chars valid in an email local-part — `` ` ``
 * `|` `{` `}` `^` — cannot break out of a Turtle `<...>`), then a fail-closed
 * IRIREF check runs on the result. NEVER pass a raw address to `namedNode`.
 */
export function safeMailtoIri(address: unknown): string | undefined {
  const norm = normalizeEmailAddress(address);
  if (norm === undefined) return undefined;
  const at = norm.lastIndexOf("@");
  const local = encodeURIComponent(norm.slice(0, at));
  const domain = encodeURIComponent(norm.slice(at + 1));
  const iri = `mailto:${local}@${domain}`;
  if (IRIREF_FORBIDDEN.test(iri)) return undefined;
  return iri;
}

/**
 * base64url-encode arbitrary bytes/string into the `[A-Za-z0-9_-]` alphabet (no
 * padding). Total + reversible + collision-free — the safe way to fold an untrusted
 * identifier into an IRI path segment that can never carry an injection char.
 */
export function base64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Injection-safe passthrough for the INTERNAL anchor IRIs this package mints — an
 * absolute `urn:agentic:*` (and similar `urn:<nid>:<nss>`) carrying no
 * IRIREF-forbidden char. Unlike {@link mintUrn} it does not re-encode; it VALIDATES
 * an already-minted urn (`safeHttpIri(x) ?? asUrn(x)` is the pair used at every site
 * where an anchor IRI — http(s) OR our own urn — becomes a `namedNode()`). Returns
 * the value unchanged when it matches the tight `urn:` shape, else `undefined`
 * (fail-closed — a `urn:` carrying `>`/space/etc. is rejected, never injected).
 */
export function asUrn(value: unknown): string | undefined {
  // We only mint `urn:agentic:*` anchors ourselves (safe by construction). Accept an
  // absolute `urn:` with no IRIREF-forbidden char; reject anything else.
  if (typeof value === "string" && /^urn:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9._~%:-]+$/.test(value)) {
    return value;
  }
  return undefined;
}

/**
 * Mint a deterministic, injection-safe `urn:agentic:<kind>:<b64url(key)>` IRI. All
 * of `kind` and the encoded `key` land in the `[A-Za-z0-9_-]`/fixed-literal space,
 * so the result carries no IRIREF-forbidden char by construction. Used for the
 * provisional Person node and the raw-message anchor — pod-local, stable, and
 * reconcilable (the SAME key always mints the SAME urn).
 */
export function mintUrn(kind: "person" | "raw" | "interp", key: string): string {
  return `urn:agentic:${kind}:${base64Url(key)}`;
}
