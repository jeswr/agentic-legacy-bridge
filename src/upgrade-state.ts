// AUTHORED-BY Claude Fable 5
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

import { DataFactory, Parser, Store, Writer } from "n3";
import {
  asChannel,
  type Channel,
  decideUpgrade,
  type UpgradeOffer,
  type UpgradeResponse,
} from "./negotiate.js";
import { asUrn, safeHttpIri, sanitizeText } from "./safe-iri.js";
import {
  AGENTIC_AGENT_CARD,
  AGENTIC_COUNTERPARTY,
  AGENTIC_CURRENT_CHANNEL,
  AGENTIC_OFFER_PROTOCOL_HASH,
  AGENTIC_OFFER_PROTOCOL_SOURCE,
  AGENTIC_OFFER_REQUIRED,
  AGENTIC_OFFERED_CHANNEL,
  AGENTIC_RELATIONSHIP,
  AGENTIC_RELATIONSHIP_STATE,
  AGENTIC_STATE_ABORTED,
  AGENTIC_STATE_BRIDGE_DETECTED,
  AGENTIC_STATE_CARD_DISCOVERED,
  AGENTIC_STATE_IDENTITY_VERIFIED,
  AGENTIC_STATE_LEGACY_ONLY,
  AGENTIC_STATE_OFFER_PENDING,
  AGENTIC_STATE_UPGRADED,
  AGENTIC_UPDATED_AT,
  AGENTIC_VERIFIED_WEB_ID,
  DCT,
  PREFIXES,
  RDF_TYPE,
  XSD_BOOLEAN,
  XSD_DATE_TIME,
} from "./vocab.js";

const { namedNode, literal } = DataFactory;
const DCT_DESCRIPTION = `${DCT}description`;

/** The relationship state names (M2-DESIGN.md §4.1). */
export type RelationshipStateName =
  | "legacy-only"
  | "bridge-detected"
  | "identity-verified"
  | "card-discovered"
  | "offer-pending"
  | "upgraded"
  | "aborted";

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
export type RelationshipEvent =
  | {
      /** Inbound shows bridge markers (`detectBridgeCapability.capable`). */
      readonly kind: "bridge-detected";
    }
  | {
      /** The control-of-both verification completed for a WebID (§4.3). */
      readonly kind: "identity-verified";
      readonly webId: string;
    }
  | {
      /** `discoverAgent(webid)` succeeded AND the card↔WebID binding verified. */
      readonly kind: "card-discovered";
      readonly agentCardUrl: string;
    }
  | {
      /** Send an `UpgradeOffer` after a better mutual channel is found. */
      readonly kind: "offer";
      readonly offer: UpgradeOffer;
    }
  | {
      /** The peer response, resolved through `decideUpgrade` fail-closed. */
      readonly kind: "offer-response";
      readonly response: UpgradeResponse;
    }
  | {
      /** A send failed / card was revoked / protocol hash drifted. */
      readonly kind: "transport-failure";
      readonly securityBearing?: boolean;
    }
  | {
      /** The owner revoked the verified WebID. */
      readonly kind: "revoke-verification";
    };

const MAX_PROTOCOL_HASH_LENGTH = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: protocol bindings must reject all controls.
const PROTOCOL_HASH_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** Validate and canonicalise an untrusted offer before it becomes persisted state. */
export function normalizeUpgradeOffer(offer: unknown): UpgradeOffer | undefined {
  if (typeof offer !== "object" || offer === null || Array.isArray(offer)) return undefined;
  const rec = offer as Record<string, unknown>;
  const targetChannel = asChannel(rec.targetChannel);
  if (targetChannel === undefined || targetChannel === "email") return undefined;

  let protocolHash: string | undefined;
  if (rec.protocolHash !== undefined) {
    if (
      typeof rec.protocolHash !== "string" ||
      rec.protocolHash.length === 0 ||
      rec.protocolHash.length > MAX_PROTOCOL_HASH_LENGTH ||
      PROTOCOL_HASH_CONTROL.test(rec.protocolHash)
    ) {
      return undefined;
    }
    protocolHash = rec.protocolHash;
  }

  let protocolSource: string | undefined;
  if (rec.protocolSource !== undefined) {
    protocolSource = safeHttpIri(rec.protocolSource);
    if (protocolSource === undefined) return undefined;
  }

  return {
    targetChannel,
    required: rec.required === true,
    ...(protocolHash !== undefined ? { protocolHash } : {}),
    ...(protocolSource !== undefined ? { protocolSource } : {}),
  };
}

/** The result of a {@link transition}: the next state, or a fail-closed refusal. */
export type TransitionResult =
  | { readonly ok: true; readonly state: RelationshipState }
  | { readonly ok: false; readonly reason: string };

/** Assemble a new immutable state, omitting undefined optionals. */
function assemble(
  personIri: string,
  state: RelationshipStateName,
  currentChannel: Channel,
  iso: string,
  opt: {
    verifiedWebId?: string;
    agentCardUrl?: string;
    pendingOffer?: UpgradeOffer;
    upgradedChannel?: Channel;
    abortReason?: string;
  },
): RelationshipState {
  return {
    personIri,
    state,
    currentChannel,
    updatedAt: iso,
    ...(opt.verifiedWebId !== undefined ? { verifiedWebId: opt.verifiedWebId } : {}),
    ...(opt.agentCardUrl !== undefined ? { agentCardUrl: opt.agentCardUrl } : {}),
    ...(opt.pendingOffer !== undefined ? { pendingOffer: opt.pendingOffer } : {}),
    ...(opt.upgradedChannel !== undefined ? { upgradedChannel: opt.upgradedChannel } : {}),
    ...(opt.abortReason !== undefined ? { abortReason: opt.abortReason } : {}),
  };
}

/**
 * Create the initial relationship for a counterparty — `legacy-only`, floor channel
 * `email` (or a caller-supplied working channel). Fail-closed on an unsafe personIri.
 */
export function initialRelationship(
  personIri: string,
  currentChannel: Channel = "email",
  now: Date = new Date(),
): RelationshipState {
  const safePerson = asUrn(personIri) ?? safeHttpIri(personIri);
  if (safePerson === undefined) {
    throw new Error("initialRelationship: personIri must be a safe urn: or http(s) IRI.");
  }
  if (asChannel(currentChannel) === undefined) {
    throw new Error("initialRelationship: currentChannel is not a known channel.");
  }
  return assemble(safePerson, "legacy-only", currentChannel, now.toISOString(), {});
}

/** `false` for an illegal transition (typed reason). */
function illegal(event: RelationshipEvent, from: RelationshipStateName): TransitionResult {
  return { ok: false, reason: `illegal transition: ${event.kind} from ${from}` };
}

/**
 * Apply an event to a relationship state, fail-closed. An illegal transition (an event
 * not permitted from the current state), or an event carrying an unsafe IRI, returns
 * `{ ok: false }` and leaves the caller's state unchanged — the state machine never
 * moves on bad input. See the module doc for the enforced safety rules.
 */
export function transition(
  state: RelationshipState,
  event: RelationshipEvent,
  now: Date = new Date(),
): TransitionResult {
  const iso = now.toISOString();
  const from = state.state;
  const person = state.personIri;

  switch (event.kind) {
    case "bridge-detected": {
      if (from !== "legacy-only") return illegal(event, from);
      return {
        ok: true,
        state: assemble(person, "bridge-detected", state.currentChannel, iso, {}),
      };
    }

    case "identity-verified": {
      if (from !== "bridge-detected") return illegal(event, from);
      const webId = safeHttpIri(event.webId);
      if (webId === undefined) {
        return { ok: false, reason: "identity-verified: webId is not a safe http(s) IRI." };
      }
      return {
        ok: true,
        state: assemble(person, "identity-verified", state.currentChannel, iso, {
          verifiedWebId: webId,
        }),
      };
    }

    case "card-discovered": {
      // Discovery is GATED on verification — reachable ONLY from identity-verified.
      if (from !== "identity-verified") return illegal(event, from);
      if (state.verifiedWebId === undefined) {
        return { ok: false, reason: "card-discovered without a verified WebID." };
      }
      const cardUrl = safeHttpIri(event.agentCardUrl);
      if (cardUrl === undefined) {
        return { ok: false, reason: "card-discovered: agentCardUrl is not a safe http(s) IRI." };
      }
      return {
        ok: true,
        state: assemble(person, "card-discovered", state.currentChannel, iso, {
          verifiedWebId: state.verifiedWebId,
          agentCardUrl: cardUrl,
        }),
      };
    }

    case "offer": {
      // An offer is allowed from card-discovered (first exchange) or aborted (retry).
      if (from !== "card-discovered" && from !== "aborted") return illegal(event, from);
      if (state.verifiedWebId === undefined || state.agentCardUrl === undefined) {
        return { ok: false, reason: "offer before a verified card discovery." };
      }
      const offer = normalizeUpgradeOffer(event.offer);
      if (offer === undefined) return { ok: false, reason: "offer is malformed or unsafe." };
      return {
        ok: true,
        state: assemble(person, "offer-pending", state.currentChannel, iso, {
          verifiedWebId: state.verifiedWebId,
          agentCardUrl: state.agentCardUrl,
          pendingOffer: offer,
        }),
      };
    }

    case "offer-response": {
      if (from !== "offer-pending" || state.pendingOffer === undefined) return illegal(event, from);
      const decision = decideUpgrade(state.pendingOffer, event.response, state.currentChannel);
      if (decision.kind === "upgrade") {
        return {
          ok: true,
          state: assemble(person, "upgraded", decision.channel, iso, {
            verifiedWebId: state.verifiedWebId,
            agentCardUrl: state.agentCardUrl,
            upgradedChannel: decision.channel,
          }),
        };
      }
      if (decision.kind === "stay") {
        return {
          ok: true,
          state: assemble(person, "card-discovered", state.currentChannel, iso, {
            verifiedWebId: state.verifiedWebId,
            agentCardUrl: state.agentCardUrl,
          }),
        };
      }
      return {
        ok: true,
        state: assemble(person, "aborted", state.currentChannel, iso, {
          verifiedWebId: state.verifiedWebId,
          agentCardUrl: state.agentCardUrl,
          abortReason: decision.reason,
        }),
      };
    }

    case "transport-failure": {
      if (from !== "upgraded") return illegal(event, from);
      if (event.securityBearing === true) {
        // A security-bearing message NEVER silently falls back — abort + surface.
        return {
          ok: true,
          state: assemble(person, "aborted", "email", iso, {
            verifiedWebId: state.verifiedWebId,
            agentCardUrl: state.agentCardUrl,
            abortReason: "a security-bearing message failed on the upgraded channel.",
          }),
        };
      }
      // Non-security: fall back to the working floor and notify (handled by the caller).
      return {
        ok: true,
        state: assemble(person, "card-discovered", "email", iso, {
          verifiedWebId: state.verifiedWebId,
          agentCardUrl: state.agentCardUrl,
        }),
      };
    }

    case "revoke-verification": {
      // The owner can revoke from any post-verification state; drop to bridge-detected.
      if (from === "legacy-only" || from === "bridge-detected") return illegal(event, from);
      return {
        ok: true,
        state: assemble(person, "bridge-detected", "email", iso, {}),
      };
    }

    default: {
      // Exhaustiveness guard — an unknown event kind is refused, never applied.
      return { ok: false, reason: "unknown relationship event." };
    }
  }
}

/**
 * The load-bearing invariant (M2-DESIGN.md §4.1) — throws if a state violates it. Used
 * by the property tests: (a) `email` (the floor) is always a working channel; (b) the
 * `currentChannel` is a known channel; (c) post-verification states carry a verified
 * WebID, and card-having states carry a card; (d) an `offer-pending` carries a pending
 * offer whose target is a real upgrade.
 */
export function assertRelationshipInvariant(state: RelationshipState): void {
  if (asChannel(state.currentChannel) === undefined) {
    throw new Error(`invariant: currentChannel ${state.currentChannel} is not a known channel.`);
  }
  // The floor is ALWAYS available — email is a working channel in every state.
  const floorAvailable =
    state.currentChannel === "email" || CHANNEL_ABOVE_FLOOR.has(state.currentChannel);
  if (!floorAvailable) {
    throw new Error("invariant: the email floor is not available.");
  }
  const needsVerified: ReadonlySet<RelationshipStateName> = new Set([
    "identity-verified",
    "card-discovered",
    "offer-pending",
    "upgraded",
    "aborted",
  ]);
  if (needsVerified.has(state.state) && state.verifiedWebId === undefined) {
    throw new Error(`invariant: state ${state.state} requires a verified WebID.`);
  }
  const needsCard: ReadonlySet<RelationshipStateName> = new Set([
    "card-discovered",
    "offer-pending",
    "upgraded",
    "aborted",
  ]);
  if (needsCard.has(state.state) && state.agentCardUrl === undefined) {
    throw new Error(`invariant: state ${state.state} requires a discovered card.`);
  }
  if (state.state === "offer-pending") {
    if (state.pendingOffer === undefined) {
      throw new Error("invariant: offer-pending requires a pending offer.");
    }
    if (state.pendingOffer.targetChannel === "email") {
      throw new Error("invariant: a pending offer must target an upgrade above the floor.");
    }
    if (normalizeUpgradeOffer(state.pendingOffer) === undefined) {
      throw new Error("invariant: pending offer is malformed or unsafe.");
    }
  }
  if (state.state === "upgraded" && state.upgradedChannel !== state.currentChannel) {
    throw new Error("invariant: upgraded state must have upgradedChannel === currentChannel.");
  }
}

/** The channels strictly above the `email` floor (all imply email still works). */
const CHANNEL_ABOVE_FLOOR: ReadonlySet<Channel> = new Set<Channel>(["rdf", "dpop-sk", "a2a"]);

// --- RDF (de)serialisation (pod persistence) ---------------------------------

/** Map a state name to its minted state IRI (the closed set). */
function stateNameToIri(name: RelationshipStateName): string {
  switch (name) {
    case "legacy-only":
      return AGENTIC_STATE_LEGACY_ONLY;
    case "bridge-detected":
      return AGENTIC_STATE_BRIDGE_DETECTED;
    case "identity-verified":
      return AGENTIC_STATE_IDENTITY_VERIFIED;
    case "card-discovered":
      return AGENTIC_STATE_CARD_DISCOVERED;
    case "offer-pending":
      return AGENTIC_STATE_OFFER_PENDING;
    case "upgraded":
      return AGENTIC_STATE_UPGRADED;
    case "aborted":
      return AGENTIC_STATE_ABORTED;
  }
}

/** Map a state IRI back to a name, or undefined for an unknown IRI (closed set). */
function stateIriToName(iri: string): RelationshipStateName | undefined {
  switch (iri) {
    case AGENTIC_STATE_LEGACY_ONLY:
      return "legacy-only";
    case AGENTIC_STATE_BRIDGE_DETECTED:
      return "bridge-detected";
    case AGENTIC_STATE_IDENTITY_VERIFIED:
      return "identity-verified";
    case AGENTIC_STATE_CARD_DISCOVERED:
      return "card-discovered";
    case AGENTIC_STATE_OFFER_PENDING:
      return "offer-pending";
    case AGENTIC_STATE_UPGRADED:
      return "upgraded";
    case AGENTIC_STATE_ABORTED:
      return "aborted";
    default:
      return undefined;
  }
}

/**
 * Serialise a relationship state as an owner-private Turtle resource at `resourceUrl`
 * (subject `<resourceUrl>#it`), via `n3.Writer` (never hand-built triples). Every IRI
 * is re-validated before it becomes a `namedNode()`. Fail-closed on an unsafe
 * `resourceUrl` / `personIri`.
 */
export async function serializeRelationship(
  state: RelationshipState,
  resourceUrl: string,
): Promise<string> {
  assertRelationshipInvariant(state);
  const safeResource = safeHttpIri(resourceUrl);
  if (safeResource === undefined) {
    throw new Error("serializeRelationship: resourceUrl must be a safe http(s) IRI.");
  }
  const person = asUrn(state.personIri) ?? safeHttpIri(state.personIri);
  if (person === undefined) {
    throw new Error("serializeRelationship: personIri must be a safe urn: or http(s) IRI.");
  }
  const subject = namedNode(`${safeResource}#it`);
  const store = new Store();
  store.addQuad(subject, namedNode(RDF_TYPE), namedNode(AGENTIC_RELATIONSHIP));
  store.addQuad(subject, namedNode(AGENTIC_COUNTERPARTY), namedNode(person));
  store.addQuad(
    subject,
    namedNode(AGENTIC_RELATIONSHIP_STATE),
    namedNode(stateNameToIri(state.state)),
  );
  // The channel is from the CLOSED Channel set, so it is a safe literal.
  store.addQuad(subject, namedNode(AGENTIC_CURRENT_CHANNEL), literal(state.currentChannel));
  if (state.verifiedWebId !== undefined) {
    const w = safeHttpIri(state.verifiedWebId);
    if (w !== undefined) store.addQuad(subject, namedNode(AGENTIC_VERIFIED_WEB_ID), namedNode(w));
  }
  if (state.agentCardUrl !== undefined) {
    const c = safeHttpIri(state.agentCardUrl);
    if (c !== undefined) store.addQuad(subject, namedNode(AGENTIC_AGENT_CARD), namedNode(c));
  }
  if (state.pendingOffer !== undefined) {
    store.addQuad(
      subject,
      namedNode(AGENTIC_OFFERED_CHANNEL),
      literal(state.pendingOffer.targetChannel),
    );
    store.addQuad(
      subject,
      namedNode(AGENTIC_OFFER_REQUIRED),
      literal(String(state.pendingOffer.required === true), namedNode(XSD_BOOLEAN)),
    );
    if (state.pendingOffer.protocolHash !== undefined) {
      store.addQuad(
        subject,
        namedNode(AGENTIC_OFFER_PROTOCOL_HASH),
        literal(sanitizeText(state.pendingOffer.protocolHash).slice(0, 256)),
      );
    }
    if (state.pendingOffer.protocolSource !== undefined) {
      const source = safeHttpIri(state.pendingOffer.protocolSource);
      if (source === undefined) {
        throw new Error("serializeRelationship: pending protocolSource is unsafe.");
      }
      store.addQuad(subject, namedNode(AGENTIC_OFFER_PROTOCOL_SOURCE), namedNode(source));
    }
  }
  if (state.abortReason !== undefined) {
    store.addQuad(
      subject,
      namedNode(DCT_DESCRIPTION),
      literal(sanitizeText(state.abortReason).slice(0, 512)),
    );
  }
  if (state.updatedAt !== undefined) {
    store.addQuad(
      subject,
      namedNode(AGENTIC_UPDATED_AT),
      literal(state.updatedAt, namedNode(XSD_DATE_TIME)),
    );
  }
  const writer = new Writer({ format: "text/turtle", prefixes: { ...PREFIXES, dct: DCT } });
  writer.addQuads([...store]);
  return await new Promise<string>((resolve, reject) => {
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}

/**
 * Parse a relationship state back from its owner-private Turtle resource (the pod-store
 * load side). Uses the `n3.Parser` library (never a bespoke parser); every IRI/value is
 * validated on read. Returns `undefined` when the document does not describe a
 * well-formed relationship for `<resourceUrl>#it` (a missing/unknown state, a
 * malformed channel, or an unsafe counterparty) — fail-closed, never a partial state.
 */
export function parseRelationship(
  turtle: string,
  resourceUrl: string,
): RelationshipState | undefined {
  const safeResource = safeHttpIri(resourceUrl);
  if (safeResource === undefined) return undefined;
  const subject = `${safeResource}#it`;

  let store: Store;
  try {
    store = new Store(new Parser({ format: "text/turtle" }).parse(turtle));
  } catch {
    return undefined;
  }

  const one = (predicate: string): string | undefined => {
    const objs = store.getObjects(namedNode(subject), namedNode(predicate), null);
    return objs.length === 1 ? objs[0]?.value : undefined;
  };

  const stateIri = one(AGENTIC_RELATIONSHIP_STATE);
  const stateName = stateIri !== undefined ? stateIriToName(stateIri) : undefined;
  if (stateName === undefined) return undefined;

  const personRaw = one(AGENTIC_COUNTERPARTY);
  const person = personRaw !== undefined ? (asUrn(personRaw) ?? safeHttpIri(personRaw)) : undefined;
  if (person === undefined) return undefined;

  const channel = asChannel(one(AGENTIC_CURRENT_CHANNEL));
  if (channel === undefined) return undefined;

  const verifiedWebId = safeHttpIri(one(AGENTIC_VERIFIED_WEB_ID));
  const agentCardUrl = safeHttpIri(one(AGENTIC_AGENT_CARD));
  const abortReason = one(DCT_DESCRIPTION);
  const updatedAt = one(AGENTIC_UPDATED_AT);

  let pendingOffer: UpgradeOffer | undefined;
  const offeredChannel = asChannel(one(AGENTIC_OFFERED_CHANNEL));
  if (offeredChannel !== undefined) {
    const hash = one(AGENTIC_OFFER_PROTOCOL_HASH);
    const sourceRaw = one(AGENTIC_OFFER_PROTOCOL_SOURCE);
    const source = safeHttpIri(sourceRaw);
    if (sourceRaw !== undefined && source === undefined) return undefined;
    const candidate: UpgradeOffer = {
      targetChannel: offeredChannel,
      required: one(AGENTIC_OFFER_REQUIRED) === "true",
      ...(hash !== undefined ? { protocolHash: hash } : {}),
      ...(source !== undefined ? { protocolSource: source } : {}),
    };
    pendingOffer = normalizeUpgradeOffer(candidate);
    if (pendingOffer === undefined) return undefined;
  }

  const rebuilt = assemble(person, stateName, channel, updatedAt ?? new Date(0).toISOString(), {
    ...(verifiedWebId !== undefined ? { verifiedWebId } : {}),
    ...(agentCardUrl !== undefined ? { agentCardUrl } : {}),
    ...(pendingOffer !== undefined ? { pendingOffer } : {}),
    // `upgraded` state's upgradedChannel is definitionally the currentChannel.
    ...(stateName === "upgraded" ? { upgradedChannel: channel } : {}),
    ...(abortReason !== undefined && stateName === "aborted" ? { abortReason } : {}),
  });

  // Reject a document that decodes to a structurally-invalid state (fail-closed).
  try {
    assertRelationshipInvariant(rebuilt);
  } catch {
    return undefined;
  }
  return rebuilt;
}
