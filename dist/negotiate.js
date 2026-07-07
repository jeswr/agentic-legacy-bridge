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
/** The preference order (LEGACY-INTEROP.md §5.2): RDF-native ≻ dpop-sk ≻ A2A ≻ email. */
export const CHANNEL_PREFERENCE = ["rdf", "dpop-sk", "a2a", "email"];
/** The A2A agent-card extension URI advertised for each upgradeable channel.
 * `a2a` is the `nl2rdf-upgrade-spec` baseline-A2A mode identifier `#a2a-json` (not the bare
 * `https://a2a-protocol.org/` project URL) — aligning with that spec's mode table so a peer
 * checking capability declarations against the minted mode identifiers matches this bridge's
 * advertised value. */
export const CHANNEL_EXTENSION_URI = {
    rdf: "https://w3id.org/jeswr/a2a-rdf/v1",
    "dpop-sk": "https://w3id.org/jeswr/dpop-sk/v1",
    a2a: "https://w3id.org/jeswr/nl2rdf-upgrade/v1#a2a-json",
    email: "urn:agentic:channel:email",
};
/** The header a bridge sets to advertise its supported channels (comma-separated). */
export const CHANNELS_HEADER = "X-Agentic-Channels";
/** The header pointing at the authoritative pod copy of a structured reply. */
export const REPLY_HEADER = "X-Agentic-Reply";
const CHANNEL_SET = new Set(CHANNEL_PREFERENCE);
/** Narrow an untrusted string to a known {@link Channel}, else undefined. */
export function asChannel(value) {
    return typeof value === "string" && CHANNEL_SET.has(value) ? value : undefined;
}
/**
 * Detect whether an inbound message came from a bridge-capable counterparty, and
 * what channels it advertises. Pure — no network. Full capability discovery (the
 * peer's agent card) is M2; this reads only what an inbound message already carries.
 */
export function detectBridgeCapability(input) {
    const headers = normalizeHeaders(input.headers);
    const replyPointer = headers[REPLY_HEADER.toLowerCase()];
    const podCopyUrl = safeHttpIri(replyPointer);
    const channelHeader = headers[CHANNELS_HEADER.toLowerCase()];
    const channels = new Set(["email"]); // email is always the floor
    if (channelHeader !== undefined) {
        for (const part of channelHeader.split(",").slice(0, 16)) {
            const ch = asChannel(part.trim());
            if (ch !== undefined)
                channels.add(ch);
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
function isAgenticReply(jsonLd) {
    if (jsonLd === null || typeof jsonLd !== "object")
        return false;
    const type = jsonLd.type ?? jsonLd["@type"];
    if (type === "AgenticReply")
        return true;
    if (Array.isArray(type))
        return type.includes("AgenticReply");
    return false;
}
/** Case-insensitive header map (lower-cased keys). */
function normalizeHeaders(headers) {
    const out = {};
    if (headers === undefined)
        return out;
    for (const [k, v] of Object.entries(headers))
        out[k.toLowerCase()] = v;
    return out;
}
/** Sort a channel set into the preference order (most-preferred first). */
function orderChannels(set) {
    return CHANNEL_PREFERENCE.filter((c) => set.has(c));
}
/**
 * The highest channel BOTH sides support, per {@link CHANNEL_PREFERENCE}. Falls back
 * to `email` (the floor is always a channel that already works). `email` is implicitly
 * supported by every party (it is how the first contact arrived).
 */
export function highestMutualChannel(local, peer) {
    const localSet = new Set([...local, "email"]);
    const peerSet = new Set([...peer, "email"]);
    for (const c of CHANNEL_PREFERENCE) {
        if (localSet.has(c) && peerSet.has(c))
            return c;
    }
    return "email";
}
/**
 * Decide the outcome of an upgrade handshake, fail-closed (LEGACY-INTEROP.md §5.2):
 *  - **accept + hash matches (or no hash was set)** → `upgrade` to the target;
 *  - **accept but hash MISMATCH** → `abort` (a tampered/ambiguous protocol binding);
 *  - **decline + `required`** → `abort` (a security-bearing step must NOT proceed in
 *    unsigned prose);
 *  - **decline + not required** → `stay` at the current channel (the floor still works).
 */
export function decideUpgrade(offer, response, currentChannel) {
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
//# sourceMappingURL=negotiate.js.map