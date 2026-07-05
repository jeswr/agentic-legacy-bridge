// AUTHORED-BY Claude Fable 5
/**
 * The METADATA PROTOCOL (`agentic-solid-vision/docs/NOW-PERSONAL-AGENT.md` §5) —
 * deterministic first, LLM last:
 *
 *  - **Rule 1 (inbound):** {@link extractStructuredMetadata} /
 *    {@link StructuredMetadataInterpreter} — read the machine-readable metadata
 *    senders already emit (Gmail schema.org JSON-LD, `text/calendar` VEVENTs, a
 *    peer's signed `AgenticReply`) with fixed code, before any model reads anything.
 *  - **Rule 2 (outbound):** {@link buildActionMetadata} (+ `buildReply`'s
 *    `dateSent`/`sender` options) — emit standardized schema.org/iCal/PROV metadata
 *    on every action, minting nothing.
 *  - **Rule 3 (patterns):** `patterns.js` — name each exchange shape at a stable IRI,
 *    content-address it by SHA-256 over RDFC-1.0 (the a2a-rdf mechanism), reference
 *    it with `dct:conformsTo`, so a peer agent learns the pattern ONCE and runs
 *    LLM-free forever after.
 */
export { extractAgenticReply, extractAgenticReplyStructural, } from "./agentic-reply.js";
export { buildActionMetadata, } from "./emit.js";
export { extractCalendarInterpretations, icalWhen, parseCalendar, parseIcalContentLine, unescapeIcalText, unfoldIcalLines, } from "./ical.js";
export { composeInterpreters, extractStructuredMetadata, StructuredMetadataInterpreter, structuredMetadataInterpreter, } from "./interpreter.js";
export { extractJsonLdInterpretations, hasSchemaType, isAgenticReplyNode, isSchemaOrgContext, mapEventNode, } from "./jsonld.js";
export { AGENTIC_PATTERNS, hashPatternDocument, KNOWN_PATTERN_HASHES, knownPatternHash, PROPOSE_TIMES_PATTERN_HASH, PROPOSE_TIMES_PATTERN_IRI, PROPOSE_TIMES_PATTERN_TURTLE, SENT_AT_PATTERN_HASH, SENT_AT_PATTERN_IRI, SENT_AT_PATTERN_TURTLE, verifyPatternDocument, } from "./patterns.js";
export { AMBIGUOUS_TZ_NOTE, parseWhen } from "./values.js";
//# sourceMappingURL=index.js.map