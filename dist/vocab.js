// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Vocabulary — the IRI constants this package writes.
 *
 * House rule: **mint minimally, reuse the standards.** Everything that has a W3C /
 * schema.org / Dublin Core / PROV term uses it. The ONLY minted namespace is
 * `agentic:` = `https://w3id.org/jeswr/agentic#`, and only for the two concepts
 * with no existing standard equivalent: the per-datum RELIABILITY annotation and
 * the RAW-MESSAGE anchor (see `agentic-solid-vision/docs/LEGACY-INTEROP.md` §7.1).
 * The reply `Event`/`ProposeAction` shape reuses schema.org outright.
 *
 * These are string constants, not RDF terms — callers wrap them in `namedNode()`
 * (never hand-concatenate triples; the writers use `n3.Writer` + typed quads).
 */
// --- namespaces ---
export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const PROV = "http://www.w3.org/ns/prov#";
export const SCHEMA = "https://schema.org/";
export const FOAF = "http://xmlns.com/foaf/0.1/";
export const VCARD = "http://www.w3.org/2006/vcard/ns#";
export const DCT = "http://purl.org/dc/terms/";
export const ACL = "http://www.w3.org/ns/auth/acl#";
/** The ONE minted namespace (reliability + raw-message anchor). w3id redirect = needs:user. */
export const AGENTIC = "https://w3id.org/jeswr/agentic#";
// --- rdf / xsd ---
export const RDF_TYPE = `${RDF}type`;
export const XSD_DATE_TIME = `${XSD}dateTime`;
export const XSD_DECIMAL = `${XSD}decimal`;
export const XSD_STRING = `${XSD}string`;
export const XSD_BOOLEAN = `${XSD}boolean`;
// --- prov (reused for all attribution) ---
export const PROV_ENTITY = `${PROV}Entity`;
export const PROV_ACTIVITY = `${PROV}Activity`;
export const PROV_WAS_DERIVED_FROM = `${PROV}wasDerivedFrom`;
export const PROV_WAS_GENERATED_BY = `${PROV}wasGeneratedBy`;
export const PROV_WAS_ATTRIBUTED_TO = `${PROV}wasAttributedTo`;
export const PROV_WAS_ASSOCIATED_WITH = `${PROV}wasAssociatedWith`;
export const PROV_QUALIFIED_ASSOCIATION = `${PROV}qualifiedAssociation`;
export const PROV_HAD_PLAN = `${PROV}hadPlan`;
export const PROV_ASSOCIATION = `${PROV}Association`;
export const PROV_ENDED_AT_TIME = `${PROV}endedAtTime`;
export const PROV_GENERATED_AT_TIME = `${PROV}generatedAtTime`;
// --- schema.org (reused for the Person, the message, the reply Events) ---
export const SCHEMA_PERSON = `${SCHEMA}Person`;
export const SCHEMA_MESSAGE = `${SCHEMA}Message`;
export const SCHEMA_EMAIL = `${SCHEMA}email`;
export const SCHEMA_NAME = `${SCHEMA}name`;
export const SCHEMA_SENDER = `${SCHEMA}sender`;
export const SCHEMA_DATE_RECEIVED = `${SCHEMA}dateReceived`;
export const SCHEMA_DATE_SENT = `${SCHEMA}dateSent`;
export const SCHEMA_URL = `${SCHEMA}url`;
export const SCHEMA_EVENT = `${SCHEMA}Event`;
export const SCHEMA_START_TIME = `${SCHEMA}startTime`;
export const SCHEMA_END_TIME = `${SCHEMA}endTime`;
export const SCHEMA_ABOUT = `${SCHEMA}about`;
export const SCHEMA_IDENTIFIER = `${SCHEMA}identifier`;
// --- foaf / vcard (reused for the person) ---
export const FOAF_PERSON = `${FOAF}Person`;
export const FOAF_NAME = `${FOAF}name`;
export const FOAF_MBOX = `${FOAF}mbox`;
export const VCARD_INDIVIDUAL = `${VCARD}Individual`;
export const VCARD_FN = `${VCARD}fn`;
export const VCARD_HAS_EMAIL = `${VCARD}hasEmail`;
// --- agentic: (the minted terms — reliability + raw-message anchor) ---
export const AGENTIC_RAW_INBOUND_MESSAGE = `${AGENTIC}RawInboundMessage`;
export const AGENTIC_INTERPRETATION = `${AGENTIC}Interpretation`;
export const AGENTIC_CHANNEL = `${AGENTIC}channel`;
export const AGENTIC_RAW_MEDIA_TYPE = `${AGENTIC}rawMediaType`;
export const AGENTIC_RAW_DIGEST = `${AGENTIC}rawDigest`;
/** A per-datum reliability score in [0,1] (`xsd:decimal`). */
export const AGENTIC_CONFIDENCE = `${AGENTIC}confidence`;
export const AGENTIC_INTERPRETATION_METHOD = `${AGENTIC}interpretationMethod`;
export const AGENTIC_CALIBRATION = `${AGENTIC}calibration`;
// method individuals
export const AGENTIC_DETERMINISTIC = `${AGENTIC}Deterministic`;
export const AGENTIC_LLM_INTERPRETATION = `${AGENTIC}LlmInterpretation`;
export const AGENTIC_HUMAN_CONFIRMED = `${AGENTIC}HumanConfirmed`;
// calibration individuals
export const AGENTIC_SELF_REPORTED = `${AGENTIC}SelfReported`;
export const AGENTIC_CALIBRATED = `${AGENTIC}Calibrated`;
export const AGENTIC_VERIFIED = `${AGENTIC}Verified`;
// the reified statement the interpretation annotates
export const AGENTIC_ASSERTS_SUBJECT = `${AGENTIC}assertsSubject`;
export const AGENTIC_ASSERTS_PREDICATE = `${AGENTIC}assertsPredicate`;
export const AGENTIC_ASSERTS_OBJECT = `${AGENTIC}assertsObject`;
export const AGENTIC_ASSERTS_OBJECT_IRI = `${AGENTIC}assertsObjectIri`;
export const AGENTIC_ASSERTS_DATATYPE = `${AGENTIC}assertsDatatype`;
export const AGENTIC_SECURITY_BEARING = `${AGENTIC}securityBearing`;
// identity (candidate-vs-verified WebID — never assumed from an unauthenticated address)
export const AGENTIC_IDENTITY_STATUS = `${AGENTIC}identityStatus`;
export const AGENTIC_CANDIDATE_WEB_ID = `${AGENTIC}candidateWebId`;
/** The CLAIMED (unverified in M1) DKIM signing domain from the message's DKIM-Signature header. */
export const AGENTIC_DKIM_DOMAIN_CLAIM = `${AGENTIC}dkimDomainClaim`;
/**
 * A cross-CHANNEL person-node HINT edge between person URNs (M2-DESIGN.md §1.4) —
 * a candidate, never a merge (never `owl:sameAs`), minted when a channel discloses
 * a linking attribute (e.g. a Slack member email). Verification only ever happens
 * via the control-of-both loop, which records {@link AGENTIC_VERIFIED_WEB_ID}.
 */
export const AGENTIC_CANDIDATE_PERSON = `${AGENTIC}candidatePerson`;
/** The VERIFIED WebID recorded by the control-of-both verification event (M2-DESIGN.md §4.3). */
export const AGENTIC_VERIFIED_WEB_ID = `${AGENTIC}verifiedWebId`;
/** The opaque model tag on an LLM interpretation activity (LEGACY-INTEROP.md §3b). */
export const AGENTIC_MODEL = `${AGENTIC}model`;
/** The interpretation-pipeline status of an imported resource (M2-DESIGN.md §3.6). */
export const AGENTIC_INTERPRETATION_STATUS = `${AGENTIC}interpretationStatus`;
/** `interpretationStatus` individual: the decoupled LLM pass has not yet run. */
export const AGENTIC_PENDING = `${AGENTIC}Pending`;
/** A deterministically-classified reply polarity: `"affirmative"` / `"negative"` (no standard term exists). */
export const AGENTIC_REPLY_POLARITY = `${AGENTIC}replyPolarity`;
// --- channel-upgrade relationship state machine (M2-DESIGN.md §4.1) -----------
// One owner-private `agentic:Relationship` resource per counterparty person node
// tracks how far a conversation has moved from the legacy channel toward A2A. No
// standard term names this state machine, so it is minted here (still under the ONE
// `agentic:` namespace). The per-state IRIs are a CLOSED set — a state literal read
// back from the pod is validated against it, never trusted verbatim.
/** The relationship-resource type. */
export const AGENTIC_RELATIONSHIP = `${AGENTIC}Relationship`;
/** The current state of the upgrade relationship (one of the closed state set below). */
export const AGENTIC_RELATIONSHIP_STATE = `${AGENTIC}relationshipState`;
/** The counterparty person node this relationship tracks. */
export const AGENTIC_COUNTERPARTY = `${AGENTIC}counterparty`;
/** The channel currently in use with the counterparty (`agentic:currentChannel`). */
export const AGENTIC_CURRENT_CHANNEL = `${AGENTIC}currentChannel`;
/** The verified agent-card URL discovered for the counterparty (only after IDENTITY-VERIFIED). */
export const AGENTIC_AGENT_CARD = `${AGENTIC}agentCard`;
/** The channel currently OFFERED (present only in OFFER-PENDING). */
export const AGENTIC_OFFERED_CHANNEL = `${AGENTIC}offeredChannel`;
/** The protocol-doc hash bound into a pending offer (fail-closed binding). */
export const AGENTIC_OFFER_PROTOCOL_HASH = `${AGENTIC}offerProtocolHash`;
/** True when the pending offer is security-bearing (a decline ABORTS, never downgrades). */
export const AGENTIC_OFFER_REQUIRED = `${AGENTIC}offerRequired`;
/** The last transition time (`xsd:dateTime`). */
export const AGENTIC_UPDATED_AT = `${AGENTIC}updatedAt`;
// state individuals (the CLOSED set — M2-DESIGN.md §4.1)
export const AGENTIC_STATE_LEGACY_ONLY = `${AGENTIC}LegacyOnly`;
export const AGENTIC_STATE_BRIDGE_DETECTED = `${AGENTIC}BridgeDetected`;
export const AGENTIC_STATE_IDENTITY_VERIFIED = `${AGENTIC}IdentityVerified`;
export const AGENTIC_STATE_CARD_DISCOVERED = `${AGENTIC}CardDiscovered`;
export const AGENTIC_STATE_OFFER_PENDING = `${AGENTIC}OfferPending`;
export const AGENTIC_STATE_UPGRADED = `${AGENTIC}Upgraded`;
export const AGENTIC_STATE_ABORTED = `${AGENTIC}Aborted`;
/** `interpretationStatus` individual: the decoupled LLM pass has completed. */
export const AGENTIC_INTERPRETED = `${AGENTIC}Interpreted`;
/** Prefix map for `n3.Writer` (pretty Turtle only — has no effect on correctness). */
export const PREFIXES = Object.freeze({
    rdf: RDF,
    xsd: XSD,
    prov: PROV,
    schema: SCHEMA,
    foaf: FOAF,
    vcard: VCARD,
    dct: DCT,
    acl: ACL,
    agentic: AGENTIC,
});
//# sourceMappingURL=vocab.js.map