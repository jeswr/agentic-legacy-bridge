// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Rung 3 (LEGACY-INTEROP.md §4) — build the STRUCTURED, machine-readable carrier
 * embedded alongside the human prose in an outbound reply.
 *
 * The design's endorsed carrier (recorded in `docs/DECISIONS.md`): an **inline
 * JSON-LD** block (Gmail's own markup path — survives forwarding), signed as a
 * `@jeswr/solid-vc` Verifiable Credential **over the canonicalised graph** (so the
 * proof holds even if a mail client re-flows the HTML), plus a `multipart/alternative`
 * `application/ld+json` fallback part and an `X-Agentic-Reply` header pointing at the
 * authoritative pod copy. The onboarding link (§5) is the ratchet's teeth.
 *
 * M1 builds the carrier + wires an INJECTABLE `sign` seam (so tests are hermetic and
 * no crypto dependency is pulled in); the concrete `solid-vc` Data-Integrity signer
 * is the M2 adapter. Without a signer the payload is an honest UNSIGNED reply (it does
 * NOT claim the `VerifiableCredential` type). Every URL is injection-validated; the
 * inline JSON is HTML-escaped so it cannot break out of the `<script>` element.
 */

import {
  PROPOSE_TIMES_PATTERN_HASH,
  PROPOSE_TIMES_PATTERN_IRI,
  SENT_AT_PATTERN_HASH,
  SENT_AT_PATTERN_IRI,
} from "./metadata/patterns.js";
import { safeHttpIri, sanitizeText } from "./safe-iri.js";
import { A2A_RDF, AGENTIC, DCT, PROV } from "./vocab.js";

/** A proposed meeting time in the reply (a `schema:Event`). */
export interface OfferedTime {
  /** Event name/summary (control-stripped, capped). */
  readonly name?: string;
  /** Start time — MUST be a valid ISO-8601 datetime (else the offer is dropped). */
  readonly startTime: string;
  /** End time — optional ISO-8601 datetime. */
  readonly endTime?: string;
}

/** A signer that attaches a Data Integrity proof over the credential's canonical graph. */
export type ReplySigner = (
  credential: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Options for {@link buildReply}. */
export interface BuildReplyOptions {
  /** The raw-message anchor (a `urn:agentic:raw:…`) this reply answers. */
  readonly inReplyTo: string;
  /** Proposed meeting times to offer (each a `schema:Event`). */
  readonly offeredTimes?: readonly OfferedTime[];
  /** The authoritative pod-hosted copy URL (→ `X-Agentic-Reply` + a body link). http(s) only. */
  readonly podCopyUrl?: string;
  /** The onboarding entry URL (§5). http(s) only. */
  readonly onboardingUrl?: string;
  /** The replying agent's issuer WebID (the VC issuer). http(s) only. */
  readonly issuer?: string;
  /**
   * When this reply was sent (ISO-8601 → canonical UTC) — the metadata-protocol
   * Rule-2 "sent-at" envelope every reply should carry (`schema:dateSent` +
   * `dct:conformsTo` the content-addressed `sent-at` pattern). Invalid → omitted.
   */
  readonly dateSent?: string;
  /** The sending agent IRI (`schema:sender`). http(s) only; invalid → omitted. */
  readonly sender?: string;
  /**
   * An injectable signer. When provided, the credential is signed (Data Integrity
   * over the canonical graph — the M2 `solid-vc` adapter) and typed
   * `VerifiableCredential`. When absent, the payload is an honest UNSIGNED reply.
   */
  readonly sign?: ReplySigner;
}

/** A MIME part (for `multipart/alternative`). */
export interface MimePart {
  readonly contentType: string;
  readonly body: string;
}

/** The assembled reply carrier. */
export interface BuiltReply {
  /** The JSON-LD credential (with a `proof` iff a signer was supplied). */
  readonly credential: Record<string, unknown>;
  /** True iff the credential carries a Data Integrity proof. */
  readonly signed: boolean;
  /** An HTML-safe `<script type="application/ld+json">…</script>` block for the body. */
  readonly inlineHtml: string;
  /** The `application/ld+json` fallback part for `multipart/alternative`. */
  readonly mimePart: MimePart;
  /** Reply headers (`X-Agentic-Reply` → the pod copy) — safe, single-line values only. */
  readonly headers: Readonly<Record<string, string>>;
  /** A plain-text onboarding block for the human body, when an onboarding URL was given. */
  readonly onboardingBlock?: string;
}

const MAX_NAME_CHARS = 200;
const MAX_OFFERS = 32;

/**
 * The self-contained JSON-LD context (every term defined → deterministic RDFC-1.0).
 * Shared with {@link import("./metadata/emit.js").buildActionMetadata} — the envelope
 * terms (`dateSent`/`sender`/`conformsTo`/`protocolHash` + the PROV attribution set)
 * implement metadata-protocol Rules 2–3 (`NOW-PERSONAL-AGENT.md` §5.2–5.3), reusing
 * schema.org / Dublin Core / PROV / the a2a-rdf extension — minting nothing.
 */
export const INLINE_CONTEXT: readonly unknown[] = [
  "https://www.w3.org/ns/credentials/v2",
  {
    agentic: AGENTIC,
    schema: "https://schema.org/",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    dct: DCT,
    a2a: A2A_RDF,
    prov: PROV,
    AgenticReply: "agentic:AgenticReply",
    ProposeAction: "schema:ProposeAction",
    Event: "schema:Event",
    Message: "schema:Message",
    name: "schema:name",
    startTime: { "@id": "schema:startTime", "@type": "xsd:dateTime" },
    endTime: { "@id": "schema:endTime", "@type": "xsd:dateTime" },
    object: { "@id": "schema:object", "@container": "@set" },
    inReplyTo: "agentic:inReplyTo",
    onboarding: "agentic:onboarding",
    dateSent: { "@id": "schema:dateSent", "@type": "xsd:dateTime" },
    sender: { "@id": "schema:sender", "@type": "@id" },
    conformsTo: { "@id": "dct:conformsTo", "@type": "@id", "@container": "@set" },
    protocolHash: "a2a:protocolHash",
    wasAttributedTo: { "@id": "prov:wasAttributedTo", "@type": "@id" },
    wasDerivedFrom: { "@id": "prov:wasDerivedFrom", "@type": "@id" },
    qualifiedAssociation: { "@id": "prov:qualifiedAssociation" },
    Association: "prov:Association",
    agent: { "@id": "prov:agent", "@type": "@id" },
    hadPlan: { "@id": "prov:hadPlan", "@type": "@id" },
  },
];

/** A `dct:conformsTo` entry binding a pattern IRI to its `sha256:` content-address. */
function conformanceEntry(iri: string, protocolHash: string): Record<string, unknown> {
  return { "@id": iri, protocolHash };
}

/**
 * Build the structured reply carrier. Pure + hermetic (the only async is an optional
 * injected signer). Invalid offered times are dropped; unsafe URLs are omitted.
 */
export async function buildReply(options: BuildReplyOptions): Promise<BuiltReply> {
  const events = (options.offeredTimes ?? []).slice(0, MAX_OFFERS).flatMap((o) => {
    const start = isoOrUndefined(o.startTime);
    if (start === undefined) return [];
    const end = isoOrUndefined(o.endTime);
    const name =
      o.name === undefined ? undefined : sanitizeText(o.name).trim().slice(0, MAX_NAME_CHARS);
    const ev: Record<string, unknown> = { type: "Event", startTime: start };
    if (name !== undefined && name !== "") ev.name = name;
    if (end !== undefined) ev.endTime = end;
    return [ev];
  });

  const subject: Record<string, unknown> = { type: "ProposeAction" };
  const inReplyTo = safeUrn(options.inReplyTo);
  if (inReplyTo !== undefined) subject.inReplyTo = inReplyTo;
  const onboarding = safeHttpIri(options.onboardingUrl);
  if (onboarding !== undefined) subject.onboarding = onboarding;
  if (events.length > 0) subject.object = events;

  // The Rule-2 sent-at envelope + the Rule-3 pattern conformances (content-addressed
  // by their RDFC-1.0 hash so a peer learns each pattern ONCE, then goes LLM-free).
  const dateSent = isoOrUndefined(options.dateSent);
  if (dateSent !== undefined) subject.dateSent = dateSent;
  const sender = safeHttpIri(options.sender);
  if (sender !== undefined) subject.sender = sender;
  const conformances: Record<string, unknown>[] = [];
  if (dateSent !== undefined) {
    conformances.push(conformanceEntry(SENT_AT_PATTERN_IRI, SENT_AT_PATTERN_HASH));
  }
  if (events.length > 0) {
    conformances.push(conformanceEntry(PROPOSE_TIMES_PATTERN_IRI, PROPOSE_TIMES_PATTERN_HASH));
  }
  if (conformances.length > 0) subject.conformsTo = conformances;

  const issuer = safeHttpIri(options.issuer);
  const base: Record<string, unknown> = {
    "@context": INLINE_CONTEXT,
    type: ["AgenticReply"],
    ...(issuer !== undefined ? { issuer } : {}),
    credentialSubject: subject,
  };

  let credential = base;
  let signed = false;
  if (options.sign !== undefined) {
    // A signer is present → this IS a verifiable credential; claim the type, then sign.
    const toSign: Record<string, unknown> = {
      ...base,
      type: ["VerifiableCredential", "AgenticReply"],
    };
    const result = await options.sign(toSign);
    // Honest: only treat as signed if the signer actually attached a proof.
    if (result !== null && typeof result === "object" && "proof" in result) {
      credential = result as Record<string, unknown>;
      signed = true;
    } else {
      credential = base;
      signed = false;
    }
  }

  const json = JSON.stringify(credential, null, 2);
  const mimePart: MimePart = { contentType: "application/ld+json", body: json };
  const inlineHtml = `<script type="application/ld+json">\n${htmlSafeJson(json)}\n</script>`;

  const headers: Record<string, string> = {};
  const podCopy = safeHttpIri(options.podCopyUrl);
  if (podCopy !== undefined) headers["X-Agentic-Reply"] = podCopy;

  const result: BuiltReply = {
    credential,
    signed,
    inlineHtml,
    mimePart,
    headers,
    ...(onboarding !== undefined ? { onboardingBlock: onboardingBlockFor(onboarding) } : {}),
  };
  return result;
}

/**
 * Produce a `<script>`-safe form of a JSON string. Valid JSON escapes for `<`, `>`,
 * `&` and the JS line separators keep the JSON well-formed while making it impossible
 * to close the `<script>` element or open a comment/CDATA sequence — the canonical
 * JSON-in-HTML-script XSS guard.
 */
export function htmlSafeJson(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The human-readable onboarding block (§5) — one unobtrusive link (per DECISIONS.md Q3). */
function onboardingBlockFor(url: string): string {
  return [
    "---",
    "This message includes a machine-readable version an AI assistant can act on.",
    `Want your own assistant to read it (and reply in kind)? Set one up: ${url}`,
  ].join("\n");
}

/** Validate an ISO-8601 datetime → canonical UTC ISO, or undefined. */
function isoOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Accept only a safe `urn:agentic:*` anchor (no IRIREF-forbidden char); else undefined. */
function safeUrn(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^urn:agentic:[a-z]+:[A-Za-z0-9._~%:-]+$/.test(value) ? value : undefined;
}
