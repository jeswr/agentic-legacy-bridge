// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
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

import { DataFactory, Store, Writer } from "n3";
import type { EmailMessage } from "./email/types.js";
import { asBridgeMessage, type BridgeMessage } from "./message.js";
import { addInterpretation, type Interpretation } from "./reliability.js";
import { asUrn, safeHttpIri, safeMediaType, sanitizeText } from "./safe-iri.js";
import { addSenderPerson } from "./sender.js";
import {
  AGENTIC_CHANNEL,
  AGENTIC_INTERPRETATION_STATUS,
  AGENTIC_INTERPRETED,
  AGENTIC_PENDING,
  AGENTIC_RAW_DIGEST,
  AGENTIC_RAW_INBOUND_MESSAGE,
  AGENTIC_RAW_MEDIA_TYPE,
  PREFIXES,
  PROV_ENTITY,
  RDF_TYPE,
  SCHEMA_DATE_RECEIVED,
  SCHEMA_DATE_SENT,
  SCHEMA_MESSAGE,
  SCHEMA_SENDER,
  SCHEMA_URL,
  XSD,
} from "./vocab.js";

/**
 * The interpretation-pipeline status of an imported resource (M2-DESIGN.md §3.6) —
 * a CLOSED set. The M2.4 webhook path acks fast with `"pending"` (deterministic
 * interpretations only; the LLM pass is decoupled), and a later sweep re-writes the
 * graph with `"interpreted"`. Only these two values map to a minted status IRI — an
 * arbitrary string can never reach `namedNode()` (fail-closed, no injection).
 */
export type InterpretationStatus = "pending" | "interpreted";

/** Map a closed {@link InterpretationStatus} to its minted status IRI. */
function interpretationStatusIri(status: InterpretationStatus): string {
  return status === "pending" ? AGENTIC_PENDING : AGENTIC_INTERPRETED;
}

const { namedNode, literal } = DataFactory;

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
export async function buildAgenticGraph(options: AgenticGraphOptions): Promise<AgenticGraphResult> {
  const store = new Store();
  // Normalise to the channel-neutral shape (an M1 EmailMessage maps 1:1 — the
  // email path's output is unchanged through this seam).
  const message = asBridgeMessage(options.message);
  // Re-validate the raw-message anchor before it becomes a `namedNode()`. Although
  // this IRI is normally minted internally (a `urn:agentic:raw:…`, safe by
  // construction), `buildAgenticGraph` is a public API — an untrusted or malformed
  // value carrying an IRIREF-forbidden char (`>`, newline, …) would break out of the
  // Turtle `<...>` and inject arbitrary triples (potentially into a `.acl`). Route it
  // through `safeHttpIri ?? asUrn` (the same guard `addInterpretation` uses) and fail
  // closed if neither accepts it — there is no safe anchor to build the graph on.
  const rawMessageIri = safeHttpIri(options.rawMessageIri) ?? asUrn(options.rawMessageIri);
  if (rawMessageIri === undefined) {
    throw new TypeError(
      "buildAgenticGraph: rawMessageIri must be a safe absolute http(s) or urn: IRI",
    );
  }
  const raw = namedNode(rawMessageIri);

  // --- raw-message anchor ---
  store.addQuad(raw, namedNode(RDF_TYPE), namedNode(PROV_ENTITY));
  store.addQuad(raw, namedNode(RDF_TYPE), namedNode(SCHEMA_MESSAGE));
  store.addQuad(raw, namedNode(RDF_TYPE), namedNode(AGENTIC_RAW_INBOUND_MESSAGE));
  store.addQuad(
    raw,
    namedNode(AGENTIC_CHANNEL),
    literal(sanitizeText(options.channel).slice(0, 64)),
  );
  store.addQuad(
    raw,
    namedNode(AGENTIC_RAW_MEDIA_TYPE),
    literal(
      safeMediaType(options.rawMediaType) ??
        safeMediaType(message.rawMediaType) ??
        "message/rfc822",
    ),
  );
  store.addQuad(raw, namedNode(AGENTIC_RAW_DIGEST), literal(`sha256:${message.rawSha256}`));
  const receivedAt = isoOrNow(options.receivedAt);
  store.addQuad(
    raw,
    namedNode(SCHEMA_DATE_RECEIVED),
    literal(receivedAt, namedNode(`${XSD}dateTime`)),
  );
  if (message.date !== undefined) {
    store.addQuad(
      raw,
      namedNode(SCHEMA_DATE_SENT),
      literal(message.date, namedNode(`${XSD}dateTime`)),
    );
  }
  const rawResource = safeHttpIri(options.rawResourceIri);
  if (rawResource !== undefined) {
    store.addQuad(raw, namedNode(SCHEMA_URL), namedNode(rawResource));
  }
  if (options.interpretationStatus !== undefined) {
    store.addQuad(
      raw,
      namedNode(AGENTIC_INTERPRETATION_STATUS),
      namedNode(interpretationStatusIri(options.interpretationStatus)),
    );
  }

  // --- sender ---
  const { personIri } = addSenderPerson(store, message, {
    ...(options.candidateWebIds !== undefined ? { candidateWebIds: options.candidateWebIds } : {}),
  });
  store.addQuad(raw, namedNode(SCHEMA_SENDER), namedNode(personIri));

  // --- interpretations ---
  const interpretationIris: string[] = [];
  const interps = options.interpretations ?? [];
  for (let i = 0; i < interps.length; i++) {
    const iri = addInterpretation(store, interps[i] as Interpretation, i + 1, {
      docIri: options.docIri,
      rawMessageIri,
      ...(options.interpretingAgentWebId !== undefined
        ? { interpretingAgentWebId: options.interpretingAgentWebId }
        : {}),
      ...(options.mandateIri !== undefined ? { mandateIri: options.mandateIri } : {}),
      endedAtTime: receivedAt,
    });
    if (iri !== undefined) interpretationIris.push(iri);
  }

  const turtle = await serialize(store);
  return { turtle, personIri, interpretationIris };
}

/** Serialise a store to Turtle with the package prefix map. */
function serialize(store: Store): Promise<string> {
  const writer = new Writer({ format: "text/turtle", prefixes: { ...PREFIXES } });
  writer.addQuads([...store]);
  return new Promise<string>((resolve, reject) => {
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** Return `iso` if valid, else now. */
function isoOrNow(iso: string | undefined): string {
  if (iso !== undefined) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}
