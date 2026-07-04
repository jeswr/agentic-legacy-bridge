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
export { emailToCanonical, serializeCanonical, toCanonicalMessage } from "./canonical.js";
export { type ChannelAdapter, type InboundRawMessage, InMemoryChannelAdapter, parseEmailInbound, type ReplyTarget, } from "./channel.js";
export { EmailParseError, parseEmail } from "./email/index.js";
export type { EmailAddress, EmailMessage } from "./email/types.js";
export { ChannelParseError } from "./errors.js";
export { type AgenticGraphOptions, type AgenticGraphResult, buildAgenticGraph, } from "./graph.js";
export { type ImportInboundOptions, type ImportInboundResult, importInbound, } from "./import.js";
export { DeterministicInterpreter, deterministicInterpreter, extractIsoDateTimes, extractRelativeMeetings, type InterpretContext, type Interpreter, } from "./interpret.js";
export { type AsyncInterpreter, actionItemsTask, DEFAULT_TASKS, type ExtractionTask, type LlmExtractor, LlmInterpreter, type LlmInterpreterOptions, type LlmInterpretResult, meetingTimesTask, replyPolarityTask, scriptedExtractor, } from "./interpret-llm.js";
export { createHttpLlmExtractor, type HttpLlmExtractorOptions, } from "./interpret-llm-http.js";
export { asBridgeMessage, type BridgeMessage, type BridgeSender, isBridgeMessage, toBridgeMessage, } from "./message.js";
export { asChannel, type BridgeCapability, CHANNEL_EXTENSION_URI, CHANNEL_PREFERENCE, CHANNELS_HEADER, type Channel, decideUpgrade, detectBridgeCapability, highestMutualChannel, type InboundSignals, REPLY_HEADER, type UpgradeDecision, type UpgradeOffer, type UpgradeResponse, } from "./negotiate.js";
export { addInterpretation, type Calibration, clampConfidence, classifyReliability, DEFAULT_THRESHOLDS, type Interpretation, type InterpretationGraphContext, type InterpretationMethod, type InterpretationObject, type ReliabilityDecision, type ReliabilityThresholds, } from "./reliability.js";
export { type BuildReplyOptions, type BuiltReply, buildReply, htmlSafeJson, type MimePart, type OfferedTime, type ReplySigner, } from "./reply.js";
export { base64Url, canonicalContainer, isValidEmailAddress, isWithinBase, mintUrn, normalizeEmailAddress, safeHttpIri, safeMailtoIri, safeMediaType, safeTelIri, sanitizeText, } from "./safe-iri.js";
export { addSenderPerson, personIriFor, type SenderOptions, type SenderResult } from "./sender.js";
export { SLACK_AGENTIC_METADATA_EVENT_TYPE, SLACK_CHANNEL, SLACK_RAW_MEDIA_TYPE, SlackChannelAdapter, type SlackChannelAdapterOptions, type SlackParseContext, SlackParseError, slackEventToBridgeMessage, } from "./slack.js";
export * as vocab from "./vocab.js";
export { WHATSAPP_CHANNEL, WHATSAPP_RAW_MEDIA_TYPE, WhatsAppChannelAdapter, type WhatsAppChannelAdapterOptions, type WhatsAppParseContext, WhatsAppParseError, waIdToTelIri, waMessageToBridgeMessage, } from "./whatsapp.js";
//# sourceMappingURL=index.d.ts.map