/**
 * Assemble the AGENTIC RDF graph for one inbound message: the raw-message anchor
 * (`prov:Entity` + `schema:Message` + `agentic:RawInboundMessage`, LEGACY-INTEROP.md
 * §2.2), the sender {@link addSenderPerson Person}, and the reliability-tagged
 * {@link addInterpretation interpretations} (§3b) — one owner-private Turtle doc,
 * serialised with `n3.Writer` (never hand-built triples).
 *
 * The raw BYTES themselves are stored separately as a byte-exact sibling resource
 * (so the provenance anchor is real + auditable); this graph carries their SHA-256
 * digest and, when known, a `schema:url` link to that resource.
 */
import type { EmailMessage } from "./email/types.js";
import { type BridgeMessage } from "./message.js";
import { type Interpretation } from "./reliability.js";
/**
 * The interpretation-pipeline status of an imported resource (M2-DESIGN.md §3.6) —
 * a CLOSED set. The M2.4 webhook path acks fast with `"pending"` (deterministic
 * interpretations only; the LLM pass is decoupled), and a later sweep re-writes the
 * graph with `"interpreted"`. Only these two values map to a minted status IRI — an
 * arbitrary string can never reach `namedNode()` (fail-closed, no injection).
 */
export type InterpretationStatus = "pending" | "interpreted";
/** Options for {@link buildAgenticGraph}. */
export interface AgenticGraphOptions {
    /** The parsed inbound message (channel-neutral, or an M1 `EmailMessage` unchanged). */
    readonly message: BridgeMessage | EmailMessage;
    /** The channel this arrived on (e.g. `"email"`). Control-stripped when written. */
    readonly channel: string;
    /** The resource IRI this graph is served at (interpreted subjects mint fragments under it). */
    readonly docIri: string;
    /** The minted raw-message anchor IRI (a `urn:agentic:raw:…`, safe by construction). */
    readonly rawMessageIri: string;
    /** The media type of the stored raw bytes (default: the message's own; `message/rfc822` last). */
    readonly rawMediaType?: string;
    /** The http(s) IRI where the byte-exact raw resource is stored, when known. */
    readonly rawResourceIri?: string;
    /** ISO ingestion time (`schema:dateReceived`); defaults to now. */
    readonly receivedAt?: string;
    /** The interpretations to lower (with their §3b reliability provenance). */
    readonly interpretations?: readonly Interpretation[];
    /** Caller-supplied UNVERIFIED candidate WebIDs for the sender. */
    readonly candidateWebIds?: readonly string[];
    /** The interpreting agent's WebID (`prov:wasAssociatedWith` on each interpretation activity). */
    readonly interpretingAgentWebId?: string;
    /** The ODRL mandate the interpreting agent acts under (`prov:hadPlan`). */
    readonly mandateIri?: string;
    /**
     * The interpretation-pipeline status to record on the raw-message anchor
     * (M2-DESIGN.md §3.6). Omitted → no status quad (M1 behaviour, unchanged). The
     * M2.4 webhook path sets `"pending"` (ack fast with deterministic interpretations
     * only; the LLM pass is decoupled). A CLOSED enum, so no arbitrary IRI can be
     * injected via this field.
     */
    readonly interpretationStatus?: InterpretationStatus;
}
/** The result of building the agentic graph. */
export interface AgenticGraphResult {
    /** The serialised Turtle document. */
    readonly turtle: string;
    /** The minted sender person node IRI. */
    readonly personIri: string;
    /** The interpretation node IRIs actually written (dropped/unsafe ones excluded). */
    readonly interpretationIris: readonly string[];
}
/** Build the agentic Turtle graph for one inbound message. */
export declare function buildAgenticGraph(options: AgenticGraphOptions): Promise<AgenticGraphResult>;
//# sourceMappingURL=graph.d.ts.map