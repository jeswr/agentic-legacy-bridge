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
import { type Store } from "n3";
import type { EmailMessage } from "./email/types.js";
import { type BridgeMessage } from "./message.js";
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
export declare function personIriFor(message: BridgeMessage | EmailMessage): string;
/**
 * Add the sender's Person triples to `store` and return the person node IRI.
 * On email, `schema:email` / `foaf:mbox` use a `mailto:` IRI ONLY when the address
 * validates; on any other channel the handle is recorded as a `schema:identifier`
 * LITERAL (channel-scoped, per LEGACY-INTEROP.md §2.1 — an IRI form like `tel:` is
 * the adapter's call via `safeTelIri`). The display name is control-stripped. The
 * node is always flagged unverified.
 */
export declare function addSenderPerson(store: Store, message: BridgeMessage | EmailMessage, options?: SenderOptions): SenderResult;
//# sourceMappingURL=sender.d.ts.map