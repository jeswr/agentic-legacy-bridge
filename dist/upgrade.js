// AUTHORED-BY Claude Fable 5
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
import { createNodeGuardedFetch } from "@jeswr/guarded-fetch/node";
import { assertNoRedirect, assertWritableUrl } from "./import.js";
import { asUrn, base64Url, canonicalContainer, safeHttpIri } from "./safe-iri.js";
import { readAllBounded } from "./stream-limit.js";
import { initialRelationship, normalizeUpgradeOffer, parseRelationship, serializeRelationship, transition, } from "./upgrade-state.js";
/** Thrown by a {@link RelationshipStore.save} whose optimistic precondition failed. */
export class RelationshipConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "RelationshipConflictError";
    }
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
export function canonicalPersonKey(personIri) {
    return asUrn(personIri) ?? safeHttpIri(personIri) ?? personIri;
}
/** A hermetic in-memory {@link RelationshipStore} (tests + single-process) with CAS. */
export class InMemoryRelationshipStore {
    byPerson = new Map();
    load(personIri) {
        const entry = this.byPerson.get(canonicalPersonKey(personIri));
        return Promise.resolve(entry === undefined ? undefined : { state: entry.state, version: String(entry.version) });
    }
    save(state, expectedVersion) {
        const key = canonicalPersonKey(state.personIri);
        const entry = this.byPerson.get(key);
        const currentVersion = entry === undefined ? undefined : String(entry.version);
        if (currentVersion !== expectedVersion) {
            return Promise.reject(new RelationshipConflictError(`relationship save conflict for ${state.personIri} (expected ${expectedVersion ?? "<new>"}, have ${currentVersion ?? "<new>"}).`));
        }
        const nextVersion = (entry?.version ?? 0) + 1;
        this.byPerson.set(key, { state, version: nextVersion });
        return Promise.resolve();
    }
}
const DEFAULT_MAX_STATE_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
/**
 * A pod-backed {@link RelationshipStore}: one owner-private Turtle resource per
 * counterparty (`<container>rel-<base64url(personIri)>.ttl`), (de)serialised via the
 * typed {@link serializeRelationship}/{@link parseRelationship}. `save` uses `If-Match`
 * (the loaded ETag) — or `If-None-Match: *` for a brand-new resource — for optimistic
 * concurrency, and refuses redirects on every request. Every resource URL is
 * scope-guarded strictly within the container.
 */
export function createPodRelationshipStore(options) {
    const container = canonicalContainer(options.container);
    if (container === undefined) {
        throw new Error("relationship store: container must be a safe canonical container IRI.");
    }
    const writeFetch = options.writeFetch;
    const readFetch = options.readFetch ?? options.writeFetch;
    const maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
    if (!Number.isInteger(maxStateBytes) || maxStateBytes < 1 || maxStateBytes > MAX_STATE_BYTES) {
        throw new Error(`relationship store: maxStateBytes must be an integer from 1 to ${MAX_STATE_BYTES}.`);
    }
    // Canonicalise the personIri to the SAME key the state machine uses, so `load` and
    // `save` (which is keyed on the canonical `state.personIri`) always resolve to the
    // SAME resource URL (a roborev M2.4 finding — see canonicalPersonKey).
    const urlFor = (personIri) => assertWritableUrl(`${container}rel-${base64Url(canonicalPersonKey(personIri))}.ttl`, container);
    return {
        async load(personIri) {
            const url = urlFor(personIri);
            const res = await readFetch(url, { method: "GET", redirect: "manual" });
            assertNoRedirect(res, "GET", url);
            if (res.status === 404)
                return undefined;
            if (!res.ok) {
                throw new Error(`relationship load failed: GET ${url} -> ${res.status} ${res.statusText}`);
            }
            const bytes = await readAllBounded(res.body, maxStateBytes);
            if (bytes === undefined) {
                throw new Error("relationship load failed: state resource exceeded the size cap.");
            }
            const turtle = new TextDecoder().decode(bytes);
            const state = parseRelationship(turtle, url);
            if (state === undefined)
                return undefined; // unparseable → treat as no state (fail-closed)
            const etag = res.headers.get("etag");
            if (etag === null || etag.length === 0) {
                throw new Error("relationship load failed: existing state has no ETag for safe CAS.");
            }
            return { state, version: etag };
        },
        async save(state, expectedVersion) {
            const url = urlFor(state.personIri);
            const turtle = await serializeRelationship(state, url);
            const headers = { "content-type": "text/turtle" };
            if (expectedVersion !== undefined)
                headers["if-match"] = expectedVersion;
            else
                headers["if-none-match"] = "*"; // a brand-new resource must not already exist
            const res = await writeFetch(url, {
                method: "PUT",
                headers,
                body: turtle,
                redirect: "manual",
            });
            assertNoRedirect(res, "PUT", url);
            // The precondition-failed status for If-Match / If-None-Match is 412; treat ONLY
            // 412 as an optimistic-concurrency conflict. A 409 is an ambiguous real failure →
            // the generic error path, not a silent conflict.
            if (res.status === 412) {
                throw new RelationshipConflictError(`relationship save conflict for ${state.personIri} (precondition failed on PUT ${url}).`);
            }
            if (!res.ok) {
                throw new Error(`relationship save failed: PUT ${url} -> ${res.status} ${res.statusText}`);
            }
        },
    };
}
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * The default SSRF-safe upgrade transport: POST the JSON payload to the VERIFIED target
 * through `@jeswr/guarded-fetch`'s DNS-pinning node fetch. The target is re-validated
 * `safeHttpIri` + **https-only** before the call, redirects are refused, and the
 * response is size-capped. A counterparty-supplied URL can never reach here — the
 * orchestration only ever passes a verified endpoint.
 */
export function createGuardedUpgradeTransport(options = {}) {
    const fetchImpl = options.fetch ?? createNodeGuardedFetch();
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(maxResponseBytes) ||
        maxResponseBytes < 1 ||
        maxResponseBytes > MAX_RESPONSE_BYTES) {
        throw new Error(`upgrade transport: maxResponseBytes must be an integer from 1 to ${MAX_RESPONSE_BYTES}.`);
    }
    return async ({ target, payload }) => {
        const safe = safeHttpIri(target);
        if (safe === undefined || new URL(safe).protocol !== "https:") {
            throw new Error("upgrade transport: target must be a safe https IRI.");
        }
        const res = await fetchImpl(safe, {
            method: "POST",
            headers: { "content-type": "application/json", ...options.headers },
            body: JSON.stringify(payload),
            redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
            throw new Error("upgrade transport: refusing to follow a redirect.");
        }
        if (!res.ok) {
            throw new Error(`upgrade transport failed: ${res.status} ${res.statusText}`);
        }
        // Read the response BOUNDED — abort once it exceeds the cap, so a peer cannot force
        // full buffering (the guarded fetch also caps, this is defence-in-depth).
        const bytes = await readAllBounded(res.body, maxResponseBytes);
        if (bytes === undefined) {
            throw new Error("upgrade transport: response exceeded the size cap.");
        }
        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        }
        catch {
            return undefined; // an unparseable response decodes fail-closed to a decline
        }
    };
}
/** The wire shape of an upgrade offer (mirrors `@jeswr/solid-a2a`'s `encodeUpgradeOffer`). */
export function encodeUpgradeOffer(offer) {
    return {
        type: "agentic-upgrade-offer",
        targetChannel: offer.targetChannel,
        required: offer.required === true,
        ...(offer.protocolHash !== undefined ? { protocolHash: offer.protocolHash } : {}),
        ...(offer.protocolSource !== undefined ? { protocolSource: offer.protocolSource } : {}),
    };
}
/**
 * Decode an UNTRUSTED peer response into an {@link UpgradeResponse}, fail-closed: only a
 * strict boolean `accept: true` is an acceptance (anything else — missing, wrong type, a
 * malformed body — is a DECLINE, which `decideUpgrade` then resolves to abort-if-required
 * / stay-if-optional). A `protocolHash` is carried only when it is a string.
 */
export function decodeUpgradeResponse(raw) {
    if (typeof raw !== "object" || raw === null)
        return { accept: false };
    const rec = raw;
    const accept = rec.accept === true;
    const protocolHash = typeof rec.protocolHash === "string" &&
        rec.protocolHash.length > 0 &&
        rec.protocolHash.length <= 256 &&
        sanitizePeerHash(rec.protocolHash) === rec.protocolHash
        ? rec.protocolHash
        : undefined;
    return { accept, ...(protocolHash !== undefined ? { protocolHash } : {}) };
}
/** Reject controls without silently changing the protocol binding echoed by a peer. */
function sanitizePeerHash(value) {
    // JSON strings may contain terminal/log controls; hashes never need them.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting every control is intentional.
    return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}
/** Load-transition-save a relationship, creating the initial state if none exists. */
async function advance(store, personIri, event, now) {
    const loaded = await store.load(personIri);
    const current = loaded?.state ?? initialRelationship(personIri, "email", now);
    const result = transition(current, event, now);
    if (!result.ok)
        return result;
    await store.save(result.state, loaded?.version);
    return result;
}
/** Record that an inbound message showed bridge markers (legacy-only → bridge-detected). */
export function recordBridgeDetected(store, personIri, now) {
    return advance(store, personIri, { kind: "bridge-detected" }, now);
}
/** Record a completed control-of-both identity verification (§4.3). */
export function recordIdentityVerified(store, personIri, webId, now) {
    return advance(store, personIri, { kind: "identity-verified", webId }, now);
}
/**
 * Discover + bind the counterparty's agent card — GATED on `identity-verified`. The
 * SSRF-critical `discover` seam is invoked ONLY with the VERIFIED WebID (never a
 * candidate/payload URL). On success, advances to `card-discovered`.
 */
export async function discoverCard(store, personIri, discover, now) {
    const loaded = await store.load(personIri);
    if (loaded === undefined)
        return { ok: false, reason: "no relationship for counterparty." };
    const current = loaded.state;
    if (current.state !== "identity-verified" || current.verifiedWebId === undefined) {
        return { ok: false, reason: "discovery is gated on a verified identity." };
    }
    const found = await discover(current.verifiedWebId);
    if (found === undefined)
        return { ok: false, reason: "no bindable agent card discovered." };
    const result = transition(current, { kind: "card-discovered", agentCardUrl: found.agentCardUrl }, now);
    if (!result.ok)
        return result;
    await store.save(result.state, loaded.version);
    return result;
}
/**
 * Send an {@link UpgradeOffer} to the verified card endpoint via the injectable
 * transport, then resolve the peer's response through `decideUpgrade` fail-closed. The
 * transport target is the VERIFIED `agentCardUrl` only. The intermediate `offer-pending`
 * state is persisted BEFORE transport. If delivery fails, that durable state is retained
 * and an identical retry resumes it; a different offer is refused. The resolved state
 * (upgraded / stay / aborted) is then saved with optimistic concurrency.
 */
export async function offerAndNegotiate(store, personIri, offer, transport, now) {
    const loaded = await store.load(personIri);
    if (loaded === undefined)
        return { ok: false, reason: "no relationship for counterparty." };
    const normalized = normalizeUpgradeOffer(offer);
    if (normalized === undefined)
        return { ok: false, reason: "offer is malformed or unsafe." };
    let pending;
    if (loaded.state.state === "offer-pending") {
        if (!sameOffer(loaded.state.pendingOffer, normalized)) {
            return { ok: false, reason: "a different upgrade offer is already pending." };
        }
        pending = loaded;
    }
    else {
        const offered = transition(loaded.state, { kind: "offer", offer: normalized }, now);
        if (!offered.ok)
            return offered;
        await store.save(offered.state, loaded.version);
        const persisted = await store.load(personIri);
        if (persisted === undefined ||
            persisted.state.state !== "offer-pending" ||
            !sameOffer(persisted.state.pendingOffer, normalized)) {
            return { ok: false, reason: "persisted offer-pending state could not be confirmed." };
        }
        pending = persisted;
    }
    const target = pending.state.agentCardUrl;
    if (target === undefined)
        return { ok: false, reason: "no verified card endpoint to offer to." };
    const raw = await transport({ target, payload: encodeUpgradeOffer(normalized) });
    const response = decodeUpgradeResponse(raw);
    const resolved = transition(pending.state, { kind: "offer-response", response }, now);
    if (!resolved.ok)
        return resolved;
    await store.save(resolved.state, pending.version);
    return resolved;
}
function sameOffer(left, right) {
    return (left !== undefined &&
        left.targetChannel === right.targetChannel &&
        left.required === right.required &&
        left.protocolHash === right.protocolHash &&
        left.protocolSource === right.protocolSource);
}
/**
 * Record a send failure on the upgraded channel. A NON-security message falls back to
 * the legacy floor (`card-discovered`, notify the owner); a `securityBearing` failure
 * NEVER silently falls back — it aborts + surfaces.
 */
export function recordTransportFailure(store, personIri, securityBearing, now) {
    return advance(store, personIri, { kind: "transport-failure", securityBearing }, now);
}
/** The owner revokes a verified WebID → the relationship drops to `bridge-detected`. */
export function revokeVerification(store, personIri, now) {
    return advance(store, personIri, { kind: "revoke-verification" }, now);
}
//# sourceMappingURL=upgrade.js.map