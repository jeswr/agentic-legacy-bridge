/**
 * The channel-UPGRADE relationship state machine (M2-DESIGN.md §4.1) — the pure,
 * pod-persistable data + transition model that tracks how far a conversation has moved
 * from a legacy channel toward an accountable A2A path. ONE `agentic:Relationship` per
 * counterparty, owner-private in the pod. This module has NO network surface: the live
 * probe/offer/accept transport is injected at the orchestration layer
 * ({@link ./upgrade.ts}); here it is only states, legal transitions, the safety
 * invariant, and the RDF (de)serialisation.
 *
 * ## The safety rules the transition function ENFORCES (fail-closed)
 *
 *  1. **Discovery is gated on verification.** `card-discovered` is reachable ONLY from
 *     `identity-verified` (which requires a control-of-both–verified WebID, §4.3) — a
 *     spoofable inbound handle can never drive an agent-card fetch (that is both an
 *     SSRF and an identity-confusion vector).
 *  2. **A required (security-bearing) step never silently downgrades.** An offer
 *     declined-while-required, or a security-bearing message that fails on the upgraded
 *     channel, transitions to `aborted` (surface to the owner) — never a silent
 *     fallback (the transport expression of `decideUpgrade`'s fail-closed table).
 *  3. **The floor always works; every non-abort transition is additive.** `email` is a
 *     working channel in every state; upgrading ADDS a channel, a fallback returns to
 *     the floor, and an abort terminates an EXCHANGE, never the relationship
 *     ({@link assertRelationshipInvariant}).
 *
 * Every IRI is re-validated (`safeHttpIri`/`asUrn`) before it is trusted or written, so
 * an untrusted WebID / card URL can never inject a triple into the state resource.
 */
import { type Channel, type UpgradeOffer, type UpgradeResponse } from "./negotiate.js";
/** The relationship state names (M2-DESIGN.md §4.1). */
export type RelationshipStateName = "legacy-only" | "bridge-detected" | "identity-verified" | "card-discovered" | "offer-pending" | "upgraded" | "aborted";
/** One counterparty's upgrade relationship — the pod-persisted state (M2-DESIGN.md §4.1). */
export interface RelationshipState {
    /** The counterparty person node (a `urn:agentic:person:…` or a WebID). */
    readonly personIri: string;
    /** The current state. */
    readonly state: RelationshipStateName;
    /** The channel messages currently flow on. `email` is the always-available floor. */
    readonly currentChannel: Channel;
    /** The control-of-both–verified WebID (present from `identity-verified` onward). */
    readonly verifiedWebId?: string;
    /** The verified agent-card URL (present from `card-discovered` onward). */
    readonly agentCardUrl?: string;
    /** The pending upgrade offer (present only in `offer-pending`). */
    readonly pendingOffer?: UpgradeOffer;
    /** The channel upgraded to (present only in `upgraded`; equals `currentChannel`). */
    readonly upgradedChannel?: Channel;
    /** Why the current exchange aborted (present only in `aborted`). */
    readonly abortReason?: string;
    /** The last-transition time (ISO-8601). */
    readonly updatedAt?: string;
}
/** An event driving a {@link transition}. */
export type RelationshipEvent = {
    /** Inbound shows bridge markers (`detectBridgeCapability.capable`). */
    readonly kind: "bridge-detected";
} | {
    /** The control-of-both verification completed for a WebID (§4.3). */
    readonly kind: "identity-verified";
    readonly webId: string;
} | {
    /** `discoverAgent(webid)` succeeded AND the card↔WebID binding verified. */
    readonly kind: "card-discovered";
    readonly agentCardUrl: string;
} | {
    /** Send an `UpgradeOffer` after a better mutual channel is found. */
    readonly kind: "offer";
    readonly offer: UpgradeOffer;
} | {
    /** The peer response, resolved through `decideUpgrade` fail-closed. */
    readonly kind: "offer-response";
    readonly response: UpgradeResponse;
} | {
    /** A send failed / card was revoked / protocol hash drifted. */
    readonly kind: "transport-failure";
    readonly securityBearing?: boolean;
} | {
    /** The owner revoked the verified WebID. */
    readonly kind: "revoke-verification";
};
/** Validate and canonicalise an untrusted offer before it becomes persisted state. */
export declare function normalizeUpgradeOffer(offer: unknown): UpgradeOffer | undefined;
/** The result of a {@link transition}: the next state, or a fail-closed refusal. */
export type TransitionResult = {
    readonly ok: true;
    readonly state: RelationshipState;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * Create the initial relationship for a counterparty — `legacy-only`, floor channel
 * `email` (or a caller-supplied working channel). Fail-closed on an unsafe personIri.
 */
export declare function initialRelationship(personIri: string, currentChannel?: Channel, now?: Date): RelationshipState;
/**
 * Apply an event to a relationship state, fail-closed. An illegal transition (an event
 * not permitted from the current state), or an event carrying an unsafe IRI, returns
 * `{ ok: false }` and leaves the caller's state unchanged — the state machine never
 * moves on bad input. See the module doc for the enforced safety rules.
 */
export declare function transition(state: RelationshipState, event: RelationshipEvent, now?: Date): TransitionResult;
/**
 * The load-bearing invariant (M2-DESIGN.md §4.1) — throws if a state violates it. Used
 * by the property tests: (a) `email` (the floor) is always a working channel; (b) the
 * `currentChannel` is a known channel; (c) post-verification states carry a verified
 * WebID, and card-having states carry a card; (d) an `offer-pending` carries a pending
 * offer whose target is a real upgrade.
 */
export declare function assertRelationshipInvariant(state: RelationshipState): void;
/**
 * Serialise a relationship state as an owner-private Turtle resource at `resourceUrl`
 * (subject `<resourceUrl>#it`), via `n3.Writer` (never hand-built triples). Every IRI
 * is re-validated before it becomes a `namedNode()`. Fail-closed on an unsafe
 * `resourceUrl` / `personIri`.
 */
export declare function serializeRelationship(state: RelationshipState, resourceUrl: string): Promise<string>;
/**
 * Parse a relationship state back from its owner-private Turtle resource (the pod-store
 * load side). Uses the `n3.Parser` library (never a bespoke parser); every IRI/value is
 * validated on read. Returns `undefined` when the document does not describe a
 * well-formed relationship for `<resourceUrl>#it` (a missing/unknown state, a
 * malformed channel, or an unsafe counterparty) — fail-closed, never a partial state.
 */
export declare function parseRelationship(turtle: string, resourceUrl: string): RelationshipState | undefined;
//# sourceMappingURL=upgrade-state.d.ts.map