// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
// M2.0 channel-neutral generalisation AUTHORED-BY Claude Fable 5.
/**
 * Model a legacy message's SENDER as a `schema:Person` / `foaf:Person` /
 * `vcard:Individual` RDF node — reusing standard vocabularies, minting nothing for
 * the person itself.
 *
 * The load-bearing security rule (LEGACY-INTEROP.md §2.1): **a channel handle
 * (an email `From:`, a Slack user id, a `wa_id`) authenticates NOTHING.** So the
 * person node is minted pod-local and flagged `agentic:identityStatus
 * "unverified"`; any caller-supplied WebID hint is attached as an
 * `agentic:candidateWebId` (a hint, never `owl:sameAs`) and NEVER as the verified
 * `author`/WebID. Verification only happens later, when a challenge proves
 * control of BOTH the channel handle and the WebID (the onboarding loop, §5.1).
 *
 * Person-node KEYING is channel-scoped (M2-DESIGN.md §1.4): email KEEPS its M1 key
 * (`urn:agentic:person:<base64url(normalised-address)>` — back-compatible with
 * already-written pods); every other channel mints
 * `urn:agentic:person:<channel>:<base64url(handle)>` so keys can never collide
 * across channel namespaces. Cross-channel identity is only ever a CANDIDATE edge
 * (`agentic:candidatePerson`), never a merged node.
 *
 * Every untrusted string that becomes an IRI goes through `safeHttpIri` /
 * `safeMailtoIri` (RDF-injection-safe); every literal is control-stripped. Triples
 * are built with typed quads into an `n3.Store` — never hand-concatenated.
 */

import { DataFactory, type Store } from "n3";
import type { EmailMessage } from "./email/types.js";
import { asBridgeMessage, type BridgeMessage } from "./message.js";
import {
  asUrn,
  base64Url,
  mintUrn,
  normalizeEmailAddress,
  safeHttpIri,
  safeMailtoIri,
  sanitizeText,
} from "./safe-iri.js";
import {
  AGENTIC_CANDIDATE_PERSON,
  AGENTIC_CANDIDATE_WEB_ID,
  AGENTIC_DKIM_DOMAIN_CLAIM,
  AGENTIC_IDENTITY_STATUS,
  FOAF_MBOX,
  FOAF_NAME,
  FOAF_PERSON,
  RDF_TYPE,
  SCHEMA_EMAIL,
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
  SCHEMA_PERSON,
  VCARD_FN,
  VCARD_HAS_EMAIL,
  VCARD_INDIVIDUAL,
} from "./vocab.js";

const { namedNode, literal } = DataFactory;

/**
 * The channel token admitted into a channel-scoped person URN. Deliberately tight
 * (lower-case LDH, short): the token lands VERBATIM in an IRI, so anything outside
 * this shape falls back to the provisional anon node (fail-closed, never injected).
 * `[a-z0-9-]` is injection-free by construction and cannot collide with the
 * base64url alphabet's `_`, so a scoped key can never alias an email key.
 */
const CHANNEL_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

/** Cap on a channel handle folded into an identity key (over-cap → provisional anon node). */
const MAX_HANDLE_CHARS = 1024;

/** Options for {@link addSenderPerson}. */
export interface SenderOptions {
  /**
   * Caller-supplied CANDIDATE WebIDs for this sender (already discovered elsewhere —
   * a directory hit, a `.well-known` mapping). Each is attached as an UNVERIFIED
   * `agentic:candidateWebId` hint, never as the person's authenticated identity.
   * Non-http(s) / injection-carrying values are dropped.
   */
  readonly candidateWebIds?: readonly string[];
  /**
   * Caller-supplied CANDIDATE person-node IRIs this sender MAY be the same person
   * as (M2-DESIGN.md §1.4 — e.g. the email-keyed person URN when Slack discloses a
   * member email). Attached as `agentic:candidatePerson` HINT edges — candidates,
   * never merges. Values must be this package's `urn:agentic:person:…` URNs or
   * safe http(s) IRIs; anything else is dropped (fail-closed).
   */
  readonly candidatePersonIris?: readonly string[];
}

/** The result of modelling a sender. */
export interface SenderResult {
  /** The minted, injection-safe pod-local person node IRI (a stable `urn:agentic:person:…`). */
  readonly personIri: string;
}

/**
 * Mint the STABLE person node IRI for a message's sender, channel-scoped
 * (M2-DESIGN.md §1.4):
 *
 *  - **email** keeps its M1 key — `urn:agentic:person:<base64url>` from the
 *    normalised from-address (back-compatible with already-written pods);
 *  - **every other channel** mints `urn:agentic:person:<channel>:<base64url(handle)>`
 *    so the same handle string on two channels can never collide into one identity;
 *  - **no usable handle** (or an out-of-shape channel token / over-cap handle) →
 *    a provisional per-message node keyed on the raw digest (fail-closed — never a
 *    truncated key that could merge two distinct senders).
 *
 * Always injection-safe (a `urn:agentic:person:…`), by construction.
 */
export function personIriFor(message: BridgeMessage | EmailMessage): string {
  const m = asBridgeMessage(message);
  if (m.channel === "email") {
    const norm = normalizeEmailAddress(m.sender?.handle);
    if (norm !== undefined) return mintUrn("person", norm);
  } else {
    const handle = m.sender?.handle;
    if (
      handle !== undefined &&
      handle !== "" &&
      handle.length <= MAX_HANDLE_CHARS &&
      CHANNEL_TOKEN.test(m.channel)
    ) {
      return `urn:agentic:person:${m.channel}:${base64Url(handle)}`;
    }
  }
  // No usable handle → a provisional per-message node keyed on the raw digest.
  return `urn:agentic:person:anon-${base64Url(m.rawSha256)}`;
}

/**
 * Add the sender's Person triples to `store` and return the person node IRI.
 * On email, `schema:email` / `foaf:mbox` use a `mailto:` IRI ONLY when the address
 * validates; on any other channel the handle is recorded as a `schema:identifier`
 * LITERAL (channel-scoped, per LEGACY-INTEROP.md §2.1 — an IRI form like `tel:` is
 * the adapter's call via `safeTelIri`). The display name is control-stripped. The
 * node is always flagged unverified.
 */
export function addSenderPerson(
  store: Store,
  message: BridgeMessage | EmailMessage,
  options: SenderOptions = {},
): SenderResult {
  const m = asBridgeMessage(message);
  const personIri = personIriFor(m);
  const person = namedNode(personIri);

  store.addQuad(person, namedNode(RDF_TYPE), namedNode(SCHEMA_PERSON));
  store.addQuad(person, namedNode(RDF_TYPE), namedNode(FOAF_PERSON));
  store.addQuad(person, namedNode(RDF_TYPE), namedNode(VCARD_INDIVIDUAL));

  // Identity is NEVER assumed from the handle — always flagged unverified.
  store.addQuad(person, namedNode(AGENTIC_IDENTITY_STATUS), literal("unverified"));

  if (m.channel === "email") {
    const mailto = safeMailtoIri(m.sender?.handle);
    if (mailto !== undefined) {
      store.addQuad(person, namedNode(SCHEMA_EMAIL), namedNode(mailto));
      store.addQuad(person, namedNode(FOAF_MBOX), namedNode(mailto));
      store.addQuad(person, namedNode(VCARD_HAS_EMAIL), namedNode(mailto));
    }
  } else if (m.sender?.handle !== undefined) {
    // A channel-scoped, UNTRUSTED opaque handle: a control-stripped, capped LITERAL
    // (never an IRI here — `safeTelIri`/adapter-level mapping decides IRI forms).
    const handle = sanitizeText(m.sender.handle).trim().slice(0, 512);
    if (handle !== "") {
      store.addQuad(person, namedNode(SCHEMA_IDENTIFIER), literal(handle));
    }
  }

  const displayName = m.sender?.displayName;
  if (displayName !== undefined) {
    const clean = sanitizeText(displayName).trim();
    if (clean !== "") {
      store.addQuad(person, namedNode(SCHEMA_NAME), literal(clean));
      store.addQuad(person, namedNode(FOAF_NAME), literal(clean));
      store.addQuad(person, namedNode(VCARD_FN), literal(clean));
    }
  }

  // The CLAIMED (unverified) transport-auth domain (email DKIM) — a low-trust signal
  // only. `BridgeMessage` is a public type, so the value may come from an arbitrary
  // adapter, not just the hardened email parser: control-strip + cap like every
  // other untrusted sender literal (253 = the DNS name length ceiling).
  if (m.dkimDomainClaim !== undefined) {
    const claim = sanitizeText(m.dkimDomainClaim).trim().slice(0, 253);
    if (claim !== "") {
      store.addQuad(person, namedNode(AGENTIC_DKIM_DOMAIN_CLAIM), literal(claim));
    }
  }

  // Candidate WebIDs: hints, never verified identity. Deduped + injection-filtered.
  const seenWebIds = new Set<string>();
  for (const raw of options.candidateWebIds ?? []) {
    const safe = safeHttpIri(raw);
    if (safe === undefined || seenWebIds.has(safe)) continue;
    seenWebIds.add(safe);
    store.addQuad(person, namedNode(AGENTIC_CANDIDATE_WEB_ID), namedNode(safe));
  }

  // Candidate person-node edges: cross-channel HINTS, never merges. Fail-closed —
  // only this package's `urn:agentic:person:…` namespace (not just any urn:) or a
  // safe http(s) IRI survives.
  const seenPersons = new Set<string>();
  for (const raw of options.candidatePersonIris ?? []) {
    const safe = asCandidatePersonIri(raw);
    if (safe === undefined || safe === personIri || seenPersons.has(safe)) continue;
    seenPersons.add(safe);
    store.addQuad(person, namedNode(AGENTIC_CANDIDATE_PERSON), namedNode(safe));
  }

  return { personIri };
}

/**
 * Validate a candidate-person edge target: this package's `urn:agentic:person:…`
 * shape (via `asUrn`, which rejects any IRIREF-forbidden char), or a safe http(s)
 * IRI. Any other urn namespace is rejected — an `urn:evil:…` must never be
 * persisted as an `agentic:candidatePerson`.
 */
function asCandidatePersonIri(raw: string): string | undefined {
  const urn = asUrn(raw);
  if (urn !== undefined) {
    return urn.startsWith("urn:agentic:person:") ? urn : undefined;
  }
  return safeHttpIri(raw);
}
