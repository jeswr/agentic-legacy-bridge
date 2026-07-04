// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Model a legacy message's SENDER as a `schema:Person` / `foaf:Person` /
 * `vcard:Individual` RDF node — reusing standard vocabularies, minting nothing for
 * the person itself.
 *
 * The load-bearing security rule (LEGACY-INTEROP.md §2.1): **an email `From:`
 * authenticates NOTHING.** So the person node is minted pod-local and flagged
 * `agentic:identityStatus "unverified"`; any caller-supplied WebID hint is attached
 * as an `agentic:candidateWebId` (a hint, never `owl:sameAs`) and NEVER as the
 * verified `author`/WebID. Verification only happens later, when a challenge proves
 * control of BOTH the mailbox and the WebID (the onboarding loop, §5.1).
 *
 * Every untrusted string that becomes an IRI goes through `safeHttpIri` /
 * `safeMailtoIri` (RDF-injection-safe); every literal is control-stripped. Triples
 * are built with typed quads into an `n3.Store` — never hand-concatenated.
 */

import { DataFactory, type Store } from "n3";
import type { EmailMessage } from "./email/types.js";
import {
  base64Url,
  mintUrn,
  normalizeEmailAddress,
  safeHttpIri,
  safeMailtoIri,
  sanitizeText,
} from "./safe-iri.js";
import {
  AGENTIC_CANDIDATE_WEB_ID,
  AGENTIC_DKIM_DOMAIN_CLAIM,
  AGENTIC_IDENTITY_STATUS,
  FOAF_MBOX,
  FOAF_NAME,
  FOAF_PERSON,
  RDF_TYPE,
  SCHEMA_EMAIL,
  SCHEMA_NAME,
  SCHEMA_PERSON,
  VCARD_FN,
  VCARD_HAS_EMAIL,
  VCARD_INDIVIDUAL,
} from "./vocab.js";

const { namedNode, literal } = DataFactory;

/** Options for {@link addSenderPerson}. */
export interface SenderOptions {
  /**
   * Caller-supplied CANDIDATE WebIDs for this sender (already discovered elsewhere —
   * a directory hit, a `.well-known` mapping). Each is attached as an UNVERIFIED
   * `agentic:candidateWebId` hint, never as the person's authenticated identity.
   * Non-http(s) / injection-carrying values are dropped.
   */
  readonly candidateWebIds?: readonly string[];
}

/** The result of modelling a sender. */
export interface SenderResult {
  /** The minted, injection-safe pod-local person node IRI (a stable `urn:agentic:person:…`). */
  readonly personIri: string;
}

/**
 * Mint the STABLE person node IRI for a message's sender. Keyed on the normalised
 * from-address when valid (so the same sender always maps to the same node and can
 * be reconciled), else on the raw-message digest (a per-message provisional node).
 * Always injection-safe (a `urn:agentic:person:<base64url>`), by construction.
 */
export function personIriFor(message: EmailMessage): string {
  const norm = normalizeEmailAddress(message.from?.address);
  if (norm !== undefined) return mintUrn("person", norm);
  // No usable address → a provisional per-message node keyed on the raw digest.
  return `urn:agentic:person:anon-${base64Url(message.rawSha256)}`;
}

/**
 * Add the sender's Person triples to `store` and return the person node IRI.
 * `schema:email` / `foaf:mbox` use a `mailto:` IRI ONLY when the address validates;
 * the display name is control-stripped. The node is always flagged unverified.
 */
export function addSenderPerson(
  store: Store,
  message: EmailMessage,
  options: SenderOptions = {},
): SenderResult {
  const personIri = personIriFor(message);
  const person = namedNode(personIri);

  store.addQuad(person, namedNode(RDF_TYPE), namedNode(SCHEMA_PERSON));
  store.addQuad(person, namedNode(RDF_TYPE), namedNode(FOAF_PERSON));
  store.addQuad(person, namedNode(RDF_TYPE), namedNode(VCARD_INDIVIDUAL));

  // Identity is NEVER assumed from the address — always flagged unverified.
  store.addQuad(person, namedNode(AGENTIC_IDENTITY_STATUS), literal("unverified"));

  const mailto = safeMailtoIri(message.from?.address);
  if (mailto !== undefined) {
    store.addQuad(person, namedNode(SCHEMA_EMAIL), namedNode(mailto));
    store.addQuad(person, namedNode(FOAF_MBOX), namedNode(mailto));
    store.addQuad(person, namedNode(VCARD_HAS_EMAIL), namedNode(mailto));
  }

  const displayName = message.from?.displayName;
  if (displayName !== undefined) {
    const clean = sanitizeText(displayName).trim();
    if (clean !== "") {
      store.addQuad(person, namedNode(SCHEMA_NAME), literal(clean));
      store.addQuad(person, namedNode(FOAF_NAME), literal(clean));
      store.addQuad(person, namedNode(VCARD_FN), literal(clean));
    }
  }

  // The CLAIMED (unverified) DKIM signing domain — a low-trust signal only.
  if (message.dkimDomain !== undefined) {
    store.addQuad(person, namedNode(AGENTIC_DKIM_DOMAIN_CLAIM), literal(message.dkimDomain));
  }

  // Candidate WebIDs: hints, never verified identity. Deduped + injection-filtered.
  const seen = new Set<string>();
  for (const raw of options.candidateWebIds ?? []) {
    const safe = safeHttpIri(raw);
    if (safe === undefined || seen.has(safe)) continue;
    seen.add(safe);
    store.addQuad(person, namedNode(AGENTIC_CANDIDATE_WEB_ID), namedNode(safe));
  }

  return { personIri };
}
