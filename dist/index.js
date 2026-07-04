// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * `@jeswr/agentic-legacy-bridge` — the path FROM today's channels (email first) TO
 * the accountable web of agents.
 *
 * A four-rung ratchet ("meet legacy where it is, then pull it up"), composing the
 * suite's hardened packages rather than rebuilding them:
 *
 *  1. **Represent** a legacy sender as a `schema:Person`/agent + the message as a
 *     PROV-anchored raw-message event ({@link parseEmail}, {@link addSenderPerson},
 *     {@link buildAgenticGraph}) — a candidate-vs-verified WebID that never collapses
 *     on an unauthenticated address.
 *  2. **Interpret** with reliability, not laundering: a per-datum
 *     {@link Interpretation} (confidence + calibration provenance) via an injectable
 *     {@link Interpreter} (hermetic {@link DeterministicInterpreter} in M1), gated by
 *     {@link classifyReliability} (threshold / human-confirm / always-human-confirm
 *     for the security tail).
 *  3. **Reply** with a structured, signable carrier ({@link buildReply}) — inline
 *     JSON-LD (signable as a VC over the canonical graph) + MIME part + pod-copy
 *     header + onboarding link.
 *  4. **Negotiate** the channel up ({@link detectBridgeCapability},
 *     {@link highestMutualChannel}, {@link decideUpgrade}) — fail-closed on a
 *     security-bearing step; the floor is always a working channel.
 *
 * Persistence ({@link importInbound}) is owner-private (fail-closed ACL first). See
 * `PROTOCOL.md` for the wire protocol and `docs/DECISIONS.md` for the design choices.
 *
 * @packageDocumentation
 */
export { buildOwnerOnlyAclTurtle } from "./acl.js";
// --- canonical message (solid-chat-interop) ---
export { emailToCanonical, serializeCanonical, toCanonicalMessage } from "./canonical.js";
// --- channels + orchestration ---
export { InMemoryChannelAdapter, parseEmailInbound, } from "./channel.js";
// --- rung 1: parse + represent ---
export { EmailParseError, parseEmail } from "./email/index.js";
export { ChannelParseError } from "./errors.js";
export { buildAgenticGraph, } from "./graph.js";
export { importInbound, } from "./import.js";
// --- rung 2: interpret with reliability ---
export { DeterministicInterpreter, deterministicInterpreter, extractIsoDateTimes, extractRelativeMeetings, } from "./interpret.js";
// --- the channel-neutral message shape (M2.0) ---
export { asBridgeMessage, isBridgeMessage, toBridgeMessage, } from "./message.js";
// --- rung 4: negotiation ---
export { asChannel, CHANNEL_EXTENSION_URI, CHANNEL_PREFERENCE, CHANNELS_HEADER, decideUpgrade, detectBridgeCapability, highestMutualChannel, REPLY_HEADER, } from "./negotiate.js";
export { addInterpretation, clampConfidence, classifyReliability, DEFAULT_THRESHOLDS, } from "./reliability.js";
// --- rung 3: structured reply ---
export { buildReply, htmlSafeJson, } from "./reply.js";
export { base64Url, canonicalContainer, isValidEmailAddress, isWithinBase, mintUrn, normalizeEmailAddress, safeHttpIri, safeMailtoIri, safeMediaType, safeTelIri, sanitizeText, } from "./safe-iri.js";
export { addSenderPerson, personIriFor } from "./sender.js";
// --- vocabulary ---
export * as vocab from "./vocab.js";
//# sourceMappingURL=index.js.map