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
export declare const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export declare const XSD = "http://www.w3.org/2001/XMLSchema#";
export declare const PROV = "http://www.w3.org/ns/prov#";
export declare const SCHEMA = "https://schema.org/";
export declare const FOAF = "http://xmlns.com/foaf/0.1/";
export declare const VCARD = "http://www.w3.org/2006/vcard/ns#";
export declare const DCT = "http://purl.org/dc/terms/";
export declare const ACL = "http://www.w3.org/ns/auth/acl#";
/** The ONE minted namespace (reliability + raw-message anchor). w3id redirect = needs:user. */
export declare const AGENTIC = "https://w3id.org/jeswr/agentic#";
export declare const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
export declare const XSD_DATE_TIME = "http://www.w3.org/2001/XMLSchema#dateTime";
export declare const XSD_DECIMAL = "http://www.w3.org/2001/XMLSchema#decimal";
export declare const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
export declare const PROV_ENTITY = "http://www.w3.org/ns/prov#Entity";
export declare const PROV_ACTIVITY = "http://www.w3.org/ns/prov#Activity";
export declare const PROV_WAS_DERIVED_FROM = "http://www.w3.org/ns/prov#wasDerivedFrom";
export declare const PROV_WAS_GENERATED_BY = "http://www.w3.org/ns/prov#wasGeneratedBy";
export declare const PROV_WAS_ATTRIBUTED_TO = "http://www.w3.org/ns/prov#wasAttributedTo";
export declare const PROV_WAS_ASSOCIATED_WITH = "http://www.w3.org/ns/prov#wasAssociatedWith";
export declare const PROV_QUALIFIED_ASSOCIATION = "http://www.w3.org/ns/prov#qualifiedAssociation";
export declare const PROV_HAD_PLAN = "http://www.w3.org/ns/prov#hadPlan";
export declare const PROV_ASSOCIATION = "http://www.w3.org/ns/prov#Association";
export declare const PROV_ENDED_AT_TIME = "http://www.w3.org/ns/prov#endedAtTime";
export declare const PROV_GENERATED_AT_TIME = "http://www.w3.org/ns/prov#generatedAtTime";
export declare const SCHEMA_PERSON = "https://schema.org/Person";
export declare const SCHEMA_MESSAGE = "https://schema.org/Message";
export declare const SCHEMA_EMAIL = "https://schema.org/email";
export declare const SCHEMA_NAME = "https://schema.org/name";
export declare const SCHEMA_SENDER = "https://schema.org/sender";
export declare const SCHEMA_DATE_RECEIVED = "https://schema.org/dateReceived";
export declare const SCHEMA_DATE_SENT = "https://schema.org/dateSent";
export declare const SCHEMA_URL = "https://schema.org/url";
export declare const SCHEMA_EVENT = "https://schema.org/Event";
export declare const SCHEMA_START_TIME = "https://schema.org/startTime";
export declare const SCHEMA_END_TIME = "https://schema.org/endTime";
export declare const SCHEMA_ABOUT = "https://schema.org/about";
export declare const SCHEMA_IDENTIFIER = "https://schema.org/identifier";
export declare const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
export declare const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";
export declare const FOAF_MBOX = "http://xmlns.com/foaf/0.1/mbox";
export declare const VCARD_INDIVIDUAL = "http://www.w3.org/2006/vcard/ns#Individual";
export declare const VCARD_FN = "http://www.w3.org/2006/vcard/ns#fn";
export declare const VCARD_HAS_EMAIL = "http://www.w3.org/2006/vcard/ns#hasEmail";
export declare const AGENTIC_RAW_INBOUND_MESSAGE = "https://w3id.org/jeswr/agentic#RawInboundMessage";
export declare const AGENTIC_INTERPRETATION = "https://w3id.org/jeswr/agentic#Interpretation";
export declare const AGENTIC_CHANNEL = "https://w3id.org/jeswr/agentic#channel";
export declare const AGENTIC_RAW_MEDIA_TYPE = "https://w3id.org/jeswr/agentic#rawMediaType";
export declare const AGENTIC_RAW_DIGEST = "https://w3id.org/jeswr/agentic#rawDigest";
/** A per-datum reliability score in [0,1] (`xsd:decimal`). */
export declare const AGENTIC_CONFIDENCE = "https://w3id.org/jeswr/agentic#confidence";
export declare const AGENTIC_INTERPRETATION_METHOD = "https://w3id.org/jeswr/agentic#interpretationMethod";
export declare const AGENTIC_CALIBRATION = "https://w3id.org/jeswr/agentic#calibration";
export declare const AGENTIC_DETERMINISTIC = "https://w3id.org/jeswr/agentic#Deterministic";
export declare const AGENTIC_LLM_INTERPRETATION = "https://w3id.org/jeswr/agentic#LlmInterpretation";
export declare const AGENTIC_HUMAN_CONFIRMED = "https://w3id.org/jeswr/agentic#HumanConfirmed";
export declare const AGENTIC_SELF_REPORTED = "https://w3id.org/jeswr/agentic#SelfReported";
export declare const AGENTIC_CALIBRATED = "https://w3id.org/jeswr/agentic#Calibrated";
export declare const AGENTIC_VERIFIED = "https://w3id.org/jeswr/agentic#Verified";
export declare const AGENTIC_ASSERTS_SUBJECT = "https://w3id.org/jeswr/agentic#assertsSubject";
export declare const AGENTIC_ASSERTS_PREDICATE = "https://w3id.org/jeswr/agentic#assertsPredicate";
export declare const AGENTIC_ASSERTS_OBJECT = "https://w3id.org/jeswr/agentic#assertsObject";
export declare const AGENTIC_ASSERTS_OBJECT_IRI = "https://w3id.org/jeswr/agentic#assertsObjectIri";
export declare const AGENTIC_ASSERTS_DATATYPE = "https://w3id.org/jeswr/agentic#assertsDatatype";
export declare const AGENTIC_SECURITY_BEARING = "https://w3id.org/jeswr/agentic#securityBearing";
export declare const AGENTIC_IDENTITY_STATUS = "https://w3id.org/jeswr/agentic#identityStatus";
export declare const AGENTIC_CANDIDATE_WEB_ID = "https://w3id.org/jeswr/agentic#candidateWebId";
/** The CLAIMED (unverified in M1) DKIM signing domain from the message's DKIM-Signature header. */
export declare const AGENTIC_DKIM_DOMAIN_CLAIM = "https://w3id.org/jeswr/agentic#dkimDomainClaim";
/**
 * A cross-CHANNEL person-node HINT edge between person URNs (M2-DESIGN.md §1.4) —
 * a candidate, never a merge (never `owl:sameAs`), minted when a channel discloses
 * a linking attribute (e.g. a Slack member email). Verification only ever happens
 * via the control-of-both loop, which records {@link AGENTIC_VERIFIED_WEB_ID}.
 */
export declare const AGENTIC_CANDIDATE_PERSON = "https://w3id.org/jeswr/agentic#candidatePerson";
/** The VERIFIED WebID recorded by the control-of-both verification event (M2-DESIGN.md §4.3). */
export declare const AGENTIC_VERIFIED_WEB_ID = "https://w3id.org/jeswr/agentic#verifiedWebId";
/** The opaque model tag on an LLM interpretation activity (LEGACY-INTEROP.md §3b). */
export declare const AGENTIC_MODEL = "https://w3id.org/jeswr/agentic#model";
/** The interpretation-pipeline status of an imported resource (M2-DESIGN.md §3.6). */
export declare const AGENTIC_INTERPRETATION_STATUS = "https://w3id.org/jeswr/agentic#interpretationStatus";
/** `interpretationStatus` individual: the decoupled LLM pass has not yet run. */
export declare const AGENTIC_PENDING = "https://w3id.org/jeswr/agentic#Pending";
/** A deterministically-classified reply polarity: `"affirmative"` / `"negative"` (no standard term exists). */
export declare const AGENTIC_REPLY_POLARITY = "https://w3id.org/jeswr/agentic#replyPolarity";
/** Prefix map for `n3.Writer` (pretty Turtle only — has no effect on correctness). */
export declare const PREFIXES: Readonly<Record<string, string>>;
//# sourceMappingURL=vocab.d.ts.map