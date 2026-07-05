/**
 * The channel-upgrade ORCHESTRATION (M2-DESIGN.md §4) — ties the pure state machine
 * ({@link ./upgrade-state.ts}) to (a) a pod-persisted {@link RelationshipStore} and
 * (b) an injectable {@link UpgradeTransport} for the live probe/offer/accept network
 * steps. Every network-touching seam is injected, so the whole layer is testable with
 * NO live network or credentials; the default transport routes through
 * `@jeswr/guarded-fetch`'s DNS-pinning node fetch (SSRF-safe, https-only,
 * redirect-refusing).
 *
 * ## The two SSRF-critical invariants this layer preserves (M2-DESIGN.md §4.1/§6)
 *
 *  1. **A counterparty-suggested URL is NEVER fetched.** Agent-card discovery is called
 *     ONLY with the counterparty's control-of-both–VERIFIED WebID (state
 *     `identity-verified`), never a candidate URL from a spoofable inbound handle; and
 *     the offer transport targets ONLY the VERIFIED agent-card endpoint recorded at
 *     `card-discovered`, never a payload-derived URL.
 *  2. **All outbound goes through the guard.** The default transport is the DNS-pinned
 *     guarded fetch; a target is re-validated `safeHttpIri` + https-only before the
 *     call, defence-in-depth over the guard itself.
 *
 * State persistence is optimistic-concurrency safe: {@link RelationshipStore.load}
 * returns an opaque `version` (an ETag on the pod store) that `save` echoes as an
 * `If-Match` precondition — a concurrent update fails a `RelationshipConflictError`
 * rather than silently clobbering (a lost-update guard on a state machine that gates
 * security decisions).
 */
import type { Channel, UpgradeOffer, UpgradeResponse } from "./negotiate.js";
import { type RelationshipState, type TransitionResult } from "./upgrade-state.js";
/** A loaded relationship + its opaque concurrency version (an ETag on the pod store). */
export interface LoadedRelationship {
    readonly state: RelationshipState;
    /** Opaque version tag for optimistic concurrency on {@link RelationshipStore.save}. */
    readonly version?: string;
}
/** The pod-persisted relationship state store (M2-DESIGN.md §4.1). */
export interface RelationshipStore {
    /** Load the current relationship for a counterparty, or `undefined` if none yet. */
    load(personIri: string): Promise<LoadedRelationship | undefined>;
    /**
     * Persist a relationship state. `expectedVersion` is the {@link LoadedRelationship.version}
     * from the load that produced this state — a mismatch (a concurrent write) MUST throw
     * {@link RelationshipConflictError} (a lost-update guard), never silently overwrite.
     */
    save(state: RelationshipState, expectedVersion?: string): Promise<void>;
}
/** Thrown by a {@link RelationshipStore.save} whose optimistic precondition failed. */
export declare class RelationshipConflictError extends Error {
    constructor(message: string);
}
/**
 * The CANONICAL storage key for a counterparty — the SAME canonicalisation the state
 * machine applies to `personIri` ({@link initialRelationship} uses `asUrn ?? safeHttpIri`).
 * A store MUST key `load` AND `save` on this, not the raw argument: otherwise a caller
 * that loads with a non-canonical HTTP IRI (e.g. a default-port / uppercase-host form)
 * misses the state saved under the canonical `state.personIri`, and the ratchet is stuck
 * re-creating the initial state (a roborev M2.4 finding). Idempotent (canonical → itself);
 * falls back to the raw string only for a value neither canonicaliser accepts (which the
 * state machine would reject upstream anyway).
 */
export declare function canonicalPersonKey(personIri: string): string;
/** A hermetic in-memory {@link RelationshipStore} (tests + single-process) with CAS. */
export declare class InMemoryRelationshipStore implements RelationshipStore {
    private readonly byPerson;
    load(personIri: string): Promise<LoadedRelationship | undefined>;
    save(state: RelationshipState, expectedVersion?: string): Promise<void>;
}
/** Options for {@link createPodRelationshipStore}. */
export interface PodRelationshipStoreOptions {
    /** The owner-locked pod container the relationship resources live in. */
    readonly container: string;
    /**
     * A Write-capable authed pod `fetch` for the relationship resources. NOTE this is a
     * DIFFERENT (higher) privilege than the webhook service's Append-only write-fetch —
     * relationship state mutates, so it is written by the owner/negotiation identity, not
     * the inbound bridge identity. Not routed through the SSRF guard (own pod origin).
     */
    readonly writeFetch: typeof globalThis.fetch;
    /** The read `fetch` for loads (defaults to `writeFetch`). */
    readonly readFetch?: typeof globalThis.fetch;
}
/**
 * A pod-backed {@link RelationshipStore}: one owner-private Turtle resource per
 * counterparty (`<container>rel-<base64url(personIri)>.ttl`), (de)serialised via the
 * typed {@link serializeRelationship}/{@link parseRelationship}. `save` uses `If-Match`
 * (the loaded ETag) — or `If-None-Match: *` for a brand-new resource — for optimistic
 * concurrency, and refuses redirects on every request. Every resource URL is
 * scope-guarded strictly within the container.
 */
export declare function createPodRelationshipStore(options: PodRelationshipStoreOptions): RelationshipStore;
/** The injectable live transport for an upgrade probe/offer (SSRF-critical). */
export type UpgradeTransport = (input: {
    /** The VERIFIED target endpoint (an agent-card / A2A URL) — never a payload URL. */
    readonly target: string;
    /** The offer payload to deliver. */
    readonly payload: unknown;
}) => Promise<unknown>;
/** Options for {@link createGuardedUpgradeTransport}. */
export interface GuardedUpgradeTransportOptions {
    /** Override the underlying fetch (defaults to the DNS-pinning node guarded fetch). */
    readonly fetch?: typeof globalThis.fetch;
    /** Extra request headers (e.g. a DPoP-bound Authorization — the M2.5 authed-send seam). */
    readonly headers?: Readonly<Record<string, string>>;
    /** Cap on the bytes read from the response (default 256 KiB). */
    readonly maxResponseBytes?: number;
}
/**
 * The default SSRF-safe upgrade transport: POST the JSON payload to the VERIFIED target
 * through `@jeswr/guarded-fetch`'s DNS-pinning node fetch. The target is re-validated
 * `safeHttpIri` + **https-only** before the call, redirects are refused, and the
 * response is size-capped. A counterparty-supplied URL can never reach here — the
 * orchestration only ever passes a verified endpoint.
 */
export declare function createGuardedUpgradeTransport(options?: GuardedUpgradeTransportOptions): UpgradeTransport;
/** The wire shape of an upgrade offer (mirrors `@jeswr/solid-a2a`'s `encodeUpgradeOffer`). */
export declare function encodeUpgradeOffer(offer: UpgradeOffer): Record<string, unknown>;
/**
 * Decode an UNTRUSTED peer response into an {@link UpgradeResponse}, fail-closed: only a
 * strict boolean `accept: true` is an acceptance (anything else — missing, wrong type, a
 * malformed body — is a DECLINE, which `decideUpgrade` then resolves to abort-if-required
 * / stay-if-optional). A `protocolHash` is carried only when it is a string.
 */
export declare function decodeUpgradeResponse(raw: unknown): UpgradeResponse;
/**
 * The injectable agent-card discovery seam (SSRF-critical) — called ONLY with a
 * VERIFIED WebID. A concrete implementation fetches + verifies the card via
 * `@jeswr/solid-agent-card` through `@jeswr/guarded-fetch` (the M2.5 live discovery);
 * tests inject a fake. Returns the verified agent-card endpoint, or `undefined` when no
 * bindable card is found.
 */
export type CardDiscovery = (verifiedWebId: string) => Promise<{
    readonly agentCardUrl: string;
} | undefined>;
/** Record that an inbound message showed bridge markers (legacy-only → bridge-detected). */
export declare function recordBridgeDetected(store: RelationshipStore, personIri: string, now?: Date): Promise<TransitionResult>;
/** Record a completed control-of-both identity verification (§4.3). */
export declare function recordIdentityVerified(store: RelationshipStore, personIri: string, webId: string, now?: Date): Promise<TransitionResult>;
/**
 * Discover + bind the counterparty's agent card — GATED on `identity-verified`. The
 * SSRF-critical `discover` seam is invoked ONLY with the VERIFIED WebID (never a
 * candidate/payload URL). On success, advances to `card-discovered`.
 */
export declare function discoverCard(store: RelationshipStore, personIri: string, discover: CardDiscovery, now?: Date): Promise<TransitionResult>;
/**
 * Send an {@link UpgradeOffer} to the verified card endpoint via the injectable
 * transport, then resolve the peer's response through `decideUpgrade` fail-closed. The
 * transport target is the VERIFIED `agentCardUrl` only. The intermediate `offer-pending`
 * is transient (not persisted): a transport failure leaves the relationship at
 * `card-discovered` (retryable). The RESOLVED state (upgraded / stay / aborted) is
 * persisted with the loaded version (optimistic concurrency).
 */
export declare function offerAndNegotiate(store: RelationshipStore, personIri: string, offer: UpgradeOffer, transport: UpgradeTransport, now?: Date): Promise<TransitionResult>;
/**
 * Record a send failure on the upgraded channel. A NON-security message falls back to
 * the legacy floor (`card-discovered`, notify the owner); a `securityBearing` failure
 * NEVER silently falls back — it aborts + surfaces.
 */
export declare function recordTransportFailure(store: RelationshipStore, personIri: string, securityBearing: boolean, now?: Date): Promise<TransitionResult>;
/** The owner revokes a verified WebID → the relationship drops to `bridge-detected`. */
export declare function revokeVerification(store: RelationshipStore, personIri: string, now?: Date): Promise<TransitionResult>;
export type { Channel };
//# sourceMappingURL=upgrade.d.ts.map