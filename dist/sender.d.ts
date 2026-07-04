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
import { type Store } from "n3";
import type { EmailMessage } from "./email/types.js";
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
export declare function personIriFor(message: EmailMessage): string;
/**
 * Add the sender's Person triples to `store` and return the person node IRI.
 * `schema:email` / `foaf:mbox` use a `mailto:` IRI ONLY when the address validates;
 * the display name is control-stripped. The node is always flagged unverified.
 */
export declare function addSenderPerson(store: Store, message: EmailMessage, options?: SenderOptions): SenderResult;
//# sourceMappingURL=sender.d.ts.map