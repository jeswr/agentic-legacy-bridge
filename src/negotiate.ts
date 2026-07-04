// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Rung 4 (LEGACY-INTEROP.md §5.2) — the channel-upgrade NEGOTIATION logic.
 *
 * M1 ships the pure, hermetic decision logic + the wire protocol (documented in
 * `PROTOCOL.md`): detect a bridge-capable counterparty from an inbound message,
 * rank the highest mutually-supported channel from a fixed preference order, and
 * decide an upgrade fail-closed (a security-bearing `required` step that is declined
 * ABORTS rather than silently continuing in unsigned prose; a protocol-hash mismatch
 * ABORTS). The LIVE transport — fetching a peer's agent card over the network via
 * `@jeswr/solid-agent-card` + `@jeswr/solid-a2a`'s upgrade codec, through
 * `@jeswr/guarded-fetch` — is the M2 adapter; M1 has no untrusted network surface.
 */

import { safeHttpIri } from "./safe-iri.js";

/** The channels the bridge can negotiate, most-preferred first. */
export type Channel = "rdf" | "dpop-sk" | "a2a" | "email";

/** The preference order (LEGACY-INTEROP.md §5.2): RDF-native ≻ dpop-sk ≻ A2A ≻ email. */
export const CHANNEL_PREFERENCE: readonly Channel[] = ["rdf", "dpop-sk", "a2a", "email"];

/** The A2A agent-card extension URI advertised for each upgradeable channel. */
export const CHANNEL_EXTENSION_URI: Readonly<Record<Channel, string>> = {
  rdf: "https://w3id.org/jeswr/a2a-rdf/v1",
  "dpop-sk": "https://w3id.org/jeswr/dpop-sk/v1",
  a2a: "https://a2a-protocol.org/",
  email: "urn:agentic:channel:email",
};

/** The header a bridge sets to advertise its supported channels (comma-separated). */
export const CHANNELS_HEADER = "X-Agentic-Channels";
/** The header pointing at the authoritative pod copy of a structured reply. */
export const REPLY_HEADER = "X-Agentic-Reply";

const CHANNEL_SET = new Set<string>(CHANNEL_PREFERENCE);

/** Narrow an untrusted string to a known {@link Channel}, else undefined. */
export function asChannel(value: unknown): Channel | undefined {
  return typeof value === "string" && CHANNEL_SET.has(value) ? (value as Channel) : undefined;
}

/** Input to {@link detectBridgeCapability}: an inbound message's headers + parsed JSON-LD. */
export interface InboundSignals {
  /** Inbound header map (case-insensitive lookup applied internally). */
  readonly headers?: Readonly<Record<string, string>>;
  /** A parsed inline JSON-LD block from the inbound body, if any. */
  readonly jsonLd?: unknown;
}

/** The detected capability of an inbound counterparty. */
export interface BridgeCapability {
  /** True if the counterparty shows any bridge marker (an `X-Agentic-*` header / an AgenticReply). */
  readonly capable: boolean;
  /** The channels the counterparty advertises (from `X-Agentic-Channels`); always includes `email`. */
  readonly channels: readonly Channel[];
  /** The authoritative pod-copy URL from `X-Agentic-Reply`, when present + safe. */
  readonly podCopyUrl?: string;
}

/**
 * Detect whether an inbound message came from a bridge-capable counterparty, and
 * what channels it advertises. Pure — no network. Full capability discovery (the
 * peer's agent card) is M2; this reads only what an inbound message already carries.
 */
export function detectBridgeCapability(input: InboundSignals): BridgeCapability {
  const headers = normalizeHeaders(input.headers);
  const replyPointer = headers[REPLY_HEADER.toLowerCase()];
  const podCopyUrl = safeHttpIri(replyPointer);
  const channelHeader = headers[CHANNELS_HEADER.toLowerCase()];

  const channels = new Set<Channel>(["email"]); // email is always the floor
  if (channelHeader !== undefined) {
    for (const part of channelHeader.split(",").slice(0, 16)) {
      const ch = asChannel(part.trim());
      if (ch !== undefined) channels.add(ch);
    }
  }

  const jsonLdMarker = isAgenticReply(input.jsonLd);
  const capable = podCopyUrl !== undefined || channelHeader !== undefined || jsonLdMarker;

  return {
    capable,
    channels: orderChannels(channels),
    ...(podCopyUrl !== undefined ? { podCopyUrl } : {}),
  };
}

/** True if a parsed JSON-LD object declares the `AgenticReply` type. */
function isAgenticReply(jsonLd: unknown): boolean {
  if (jsonLd === null || typeof jsonLd !== "object") return false;
  const type =
    (jsonLd as Record<string, unknown>).type ?? (jsonLd as Record<string, unknown>)["@type"];
  if (type === "AgenticReply") return true;
  if (Array.isArray(type)) return type.includes("AgenticReply");
  return false;
}

/** Case-insensitive header map (lower-cased keys). */
function normalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Sort a channel set into the preference order (most-preferred first). */
function orderChannels(set: ReadonlySet<Channel>): Channel[] {
  return CHANNEL_PREFERENCE.filter((c) => set.has(c));
}

/**
 * The highest channel BOTH sides support, per {@link CHANNEL_PREFERENCE}. Falls back
 * to `email` (the floor is always a channel that already works). `email` is implicitly
 * supported by every party (it is how the first contact arrived).
 */
export function highestMutualChannel(local: readonly Channel[], peer: readonly Channel[]): Channel {
  const localSet = new Set<Channel>([...local, "email"]);
  const peerSet = new Set<Channel>([...peer, "email"]);
  for (const c of CHANNEL_PREFERENCE) {
    if (localSet.has(c) && peerSet.has(c)) return c;
  }
  return "email";
}

/** An upgrade offer (mirrors `@jeswr/solid-a2a`'s `encodeUpgradeOffer` fields). */
export interface UpgradeOffer {
  /** The channel being offered. */
  readonly targetChannel: Channel;
  /** A hash of the target protocol document (fail-closed binding), when applicable. */
  readonly protocolHash?: string;
  /** The IRI naming the target protocol document. */
  readonly protocolSource?: string;
  /** True if this upgrade is security-bearing — a decline ABORTS rather than downgrades. */
  readonly required: boolean;
}

/** A peer's response to an {@link UpgradeOffer}. */
export interface UpgradeResponse {
  /** Whether the peer accepts the offered channel. */
  readonly accept: boolean;
  /** The peer's echo of the protocol hash (must match the offer's, when the offer set one). */
  readonly protocolHash?: string;
}

/** The outcome of {@link decideUpgrade}. */
export type UpgradeDecision =
  | { readonly kind: "upgrade"; readonly channel: Channel }
  | { readonly kind: "stay"; readonly channel: Channel }
  | { readonly kind: "abort"; readonly reason: string };

/**
 * Decide the outcome of an upgrade handshake, fail-closed (LEGACY-INTEROP.md §5.2):
 *  - **accept + hash matches (or no hash was set)** → `upgrade` to the target;
 *  - **accept but hash MISMATCH** → `abort` (a tampered/ambiguous protocol binding);
 *  - **decline + `required`** → `abort` (a security-bearing step must NOT proceed in
 *    unsigned prose);
 *  - **decline + not required** → `stay` at the current channel (the floor still works).
 */
export function decideUpgrade(
  offer: UpgradeOffer,
  response: UpgradeResponse,
  currentChannel: Channel,
): UpgradeDecision {
  if (response.accept) {
    if (offer.protocolHash !== undefined && offer.protocolHash !== response.protocolHash) {
      return { kind: "abort", reason: "protocol-hash mismatch on an accepted upgrade" };
    }
    return { kind: "upgrade", channel: offer.targetChannel };
  }
  if (offer.required) {
    return { kind: "abort", reason: "a required (security-bearing) upgrade was declined" };
  }
  return { kind: "stay", channel: currentChannel };
}
