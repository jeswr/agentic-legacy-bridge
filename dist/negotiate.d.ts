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
/** The channels the bridge can negotiate, most-preferred first. */
export type Channel = "rdf" | "dpop-sk" | "a2a" | "email";
/** The preference order (LEGACY-INTEROP.md §5.2): RDF-native ≻ dpop-sk ≻ A2A ≻ email. */
export declare const CHANNEL_PREFERENCE: readonly Channel[];
/** The A2A agent-card extension URI advertised for each upgradeable channel.
 * `a2a` is the `nl2rdf-upgrade-spec` baseline-A2A mode identifier `#a2a-json` (not the bare
 * `https://a2a-protocol.org/` project URL) — aligning with that spec's mode table so a peer
 * checking capability declarations against the minted mode identifiers matches this bridge's
 * advertised value. */
export declare const CHANNEL_EXTENSION_URI: Readonly<Record<Channel, string>>;
/** The header a bridge sets to advertise its supported channels (comma-separated). */
export declare const CHANNELS_HEADER = "X-Agentic-Channels";
/** The header pointing at the authoritative pod copy of a structured reply. */
export declare const REPLY_HEADER = "X-Agentic-Reply";
/** Narrow an untrusted string to a known {@link Channel}, else undefined. */
export declare function asChannel(value: unknown): Channel | undefined;
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
export declare function detectBridgeCapability(input: InboundSignals): BridgeCapability;
/**
 * The highest channel BOTH sides support, per {@link CHANNEL_PREFERENCE}. Falls back
 * to `email` (the floor is always a channel that already works). `email` is implicitly
 * supported by every party (it is how the first contact arrived).
 */
export declare function highestMutualChannel(local: readonly Channel[], peer: readonly Channel[]): Channel;
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
export type UpgradeDecision = {
    readonly kind: "upgrade";
    readonly channel: Channel;
} | {
    readonly kind: "stay";
    readonly channel: Channel;
} | {
    readonly kind: "abort";
    readonly reason: string;
};
/**
 * Decide the outcome of an upgrade handshake, fail-closed (LEGACY-INTEROP.md §5.2):
 *  - **accept + hash matches (or no hash was set)** → `upgrade` to the target;
 *  - **accept but hash MISMATCH** → `abort` (a tampered/ambiguous protocol binding);
 *  - **decline + `required`** → `abort` (a security-bearing step must NOT proceed in
 *    unsigned prose);
 *  - **decline + not required** → `stay` at the current channel (the floor still works).
 */
export declare function decideUpgrade(offer: UpgradeOffer, response: UpgradeResponse, currentChannel: Channel): UpgradeDecision;
//# sourceMappingURL=negotiate.d.ts.map