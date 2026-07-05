// AUTHORED-BY Claude Fable 5
/**
 * Deterministic extraction of embedded **schema.org JSON-LD** (metadata-protocol
 * Rule 1a — `NOW-PERSONAL-AGENT.md` §5.1): the machine-readable blocks senders and
 * booking systems already emit because Gmail itself consumes them ("Gmail times sent
 * automatically"). Parsed by FIXED code at deterministic confidence — no LLM, no
 * prompt-injection surface.
 *
 * **Deliberately NOT a JSON-LD processor.** A general JSON-LD expansion (the `jsonld`
 * library) dereferences remote `@context` URLs — an SSRF the suite has closed twice
 * before (solid-components §9; this repo's sweep forces the Turtle parse path for the
 * same reason). This module instead does a CLOSED-WORLD shape mapping: it accepts a
 * block ONLY when its `@context` is the well-known schema.org context (the Gmail
 * email-markup context — matched as a literal string set, nothing fetched), and maps
 * a CLOSED alias table of types/fields (`Event`, `EventReservation.reservationFor`,
 * `Message.dateSent`) onto {@link Interpretation}s. An unknown context or type is
 * SKIPPED — never guessed at. That is exactly the fail-closed tradeoff the design
 * asks for: deterministic on the patterns we know, silent on the rest (the prose
 * falls through to the injection-contained LLM interpreter instead).
 *
 * Every read is own-property-only, every string capped + control-stripped, every IRI
 * `safeHttpIri`-gated, every datetime field-exact-validated (`values.ts`). A
 * zone-less datetime is flagged ambiguous and carries reduced, SELF-REPORTED
 * confidence — never asserted as a confident instant.
 */

import type { InterpretContext } from "../interpret.js";
import type { Interpretation } from "../reliability.js";
import { safeHttpIri } from "../safe-iri.js";
import {
  RDF_TYPE,
  SCHEMA,
  SCHEMA_DATE_SENT,
  SCHEMA_END_TIME,
  SCHEMA_EVENT,
  SCHEMA_EVENT_CANCELLED,
  SCHEMA_EVENT_SCHEDULED,
  SCHEMA_EVENT_STATUS,
  SCHEMA_LOCATION,
  SCHEMA_MESSAGE,
  SCHEMA_NAME,
  SCHEMA_START_TIME,
  SCHEMA_URL,
} from "../vocab.js";
import {
  AMBIGUOUS_TZ_NOTE,
  asBoundedString,
  firstProp,
  parseWhen,
  prop,
  whenDatatype,
} from "./values.js";

/** Caps (fail-closed): blocks are already count/size-capped by the channel parse. */
const MAX_TOP_LEVEL_NODES = 16;
const MAX_EVENTS_PER_MESSAGE = 16;
const MAX_NAME_CHARS = 200;
const MAX_LOCATION_CHARS = 200;

/** The recognised schema.org `@context` spellings (the Gmail email-markup context). */
const SCHEMA_CONTEXTS: ReadonlySet<string> = new Set([
  "http://schema.org",
  "http://schema.org/",
  "https://schema.org",
  "https://schema.org/",
]);

/** True when an untrusted `@context` value denotes (or includes) the schema.org context. */
export function isSchemaOrgContext(context: unknown, depth = 0): boolean {
  if (typeof context === "string") return SCHEMA_CONTEXTS.has(context.trim());
  if (Array.isArray(context)) {
    // DEPTH-BOUNDED: a hostile deeply-nested array (JSON.parse happily builds one
    // thousands deep) must not recurse the stack — never-throw is the contract.
    if (depth >= 4) return false;
    return context.slice(0, 8).some((entry) => isSchemaOrgContext(entry, depth + 1));
  }
  if (context !== null && typeof context === "object") {
    const vocab = prop(context, "@vocab");
    return typeof vocab === "string" && SCHEMA_CONTEXTS.has(vocab.trim());
  }
  return false;
}

/** Read a node's declared types as a bounded string array (`@type` preferred). */
function nodeTypes(node: unknown): string[] {
  const raw = firstProp(node, ["@type", "type"]);
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    return raw.slice(0, 8).filter((t): t is string => typeof t === "string");
  }
  return [];
}

/** True when a node declares the given schema.org type (bare / prefixed / full-IRI). */
export function hasSchemaType(node: unknown, typeName: string): boolean {
  const accepted = new Set([typeName, `schema:${typeName}`, `${SCHEMA}${typeName}`]);
  return nodeTypes(node).some((t) => accepted.has(t));
}

/** True when a block root (or any of its top-level nodes) declares `AgenticReply`. */
export function isAgenticReplyNode(node: unknown): boolean {
  const accepted = new Set([
    "AgenticReply",
    "agentic:AgenticReply",
    "https://w3id.org/jeswr/agentic#AgenticReply",
  ]);
  return nodeTypes(node).some((t) => accepted.has(t));
}

/** The closed `schema:eventStatus` value map (bare / prefixed / full-IRI spellings). */
const EVENT_STATUS: ReadonlyMap<string, string> = new Map(
  (
    [
      ["EventCancelled", SCHEMA_EVENT_CANCELLED],
      ["EventScheduled", SCHEMA_EVENT_SCHEDULED],
    ] as const
  ).flatMap(([name, iri]) => [
    [name, iri],
    [`schema:${name}`, iri],
    [`${SCHEMA}${name}`, iri],
  ]),
);

/** Shared shape of one interpreted-statement emission (exported for the reply extractor). */
export interface EmitContext {
  readonly out: Interpretation[];
  readonly confidence: number;
  readonly calibration: Interpretation["calibration"];
}

function emit(
  ctx: EmitContext,
  subject: string,
  predicate: string,
  object: Interpretation["object"],
  overrides?: Partial<Pick<Interpretation, "confidence" | "calibration" | "note">>,
): void {
  ctx.out.push({
    subject,
    predicate,
    object,
    confidence: overrides?.confidence ?? ctx.confidence,
    method: "Deterministic",
    calibration: overrides?.calibration ?? ctx.calibration,
    securityBearing: false,
    ...(overrides?.note !== undefined ? { note: overrides.note } : {}),
  });
}

/** Emit a validated date/datetime property, downgraded when timezone-ambiguous. */
function emitWhen(ctx: EmitContext, subject: string, predicate: string, raw: unknown): void {
  const when = parseWhen(raw);
  if (when === undefined) return;
  if (when.ambiguous) {
    emit(
      ctx,
      subject,
      predicate,
      { kind: "literal", value: when.value, datatype: whenDatatype(when) },
      { confidence: 0.6, calibration: "SelfReported", note: AMBIGUOUS_TZ_NOTE },
    );
    return;
  }
  emit(ctx, subject, predicate, {
    kind: "literal",
    value: when.value,
    datatype: whenDatatype(when),
  });
}

/**
 * Map one schema.org `Event`-shaped node onto interpretations under `eventIri`.
 * Accepts BOTH the schema.org `startDate`/`endDate` spelling (real Gmail markup)
 * and the design carrier's `startTime`/`endTime` — a fixed alias table, no guessing.
 * Exported for reuse by the AgenticReply extractor.
 */
export function mapEventNode(node: unknown, eventIri: string, ctx: EmitContext): void {
  emit(ctx, eventIri, RDF_TYPE, { kind: "iri", value: SCHEMA_EVENT });
  emitWhen(ctx, eventIri, SCHEMA_START_TIME, firstProp(node, ["startDate", "startTime"]));
  emitWhen(ctx, eventIri, SCHEMA_END_TIME, firstProp(node, ["endDate", "endTime"]));

  const name = asBoundedString(prop(node, "name"), MAX_NAME_CHARS);
  if (name !== undefined) emit(ctx, eventIri, SCHEMA_NAME, { kind: "literal", value: name });

  // location: a string, or a Place-shaped node with a `name` — stored as a plain literal.
  const locationRaw = prop(node, "location");
  const location =
    asBoundedString(locationRaw, MAX_LOCATION_CHARS) ??
    asBoundedString(prop(locationRaw, "name"), MAX_LOCATION_CHARS);
  if (location !== undefined) {
    emit(ctx, eventIri, SCHEMA_LOCATION, { kind: "literal", value: location });
  }

  const url = safeHttpIri(prop(node, "url"));
  if (url !== undefined) emit(ctx, eventIri, SCHEMA_URL, { kind: "iri", value: url });

  const statusRaw = prop(node, "eventStatus");
  if (typeof statusRaw === "string") {
    const statusIri = EVENT_STATUS.get(statusRaw.trim());
    if (statusIri !== undefined) {
      emit(ctx, eventIri, SCHEMA_EVENT_STATUS, { kind: "iri", value: statusIri });
    }
  }
}

/** Parse one JSON block fail-closed: valid JSON object/array or `undefined`. */
function parseBlock(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The top-level candidate nodes of a parsed block: the root, a root array, or `@graph`. */
function topLevelNodes(root: unknown): unknown[] {
  if (Array.isArray(root)) return root.slice(0, MAX_TOP_LEVEL_NODES);
  const graph = prop(root, "@graph");
  if (Array.isArray(graph)) return graph.slice(0, MAX_TOP_LEVEL_NODES);
  return [root];
}

/**
 * Extract confidence-1.0 deterministic {@link Interpretation}s from a message's
 * embedded JSON-LD blocks (Rule 1a). Blocks that are not recognised schema.org
 * markup — including `AgenticReply` carriers, which the dedicated extractor owns —
 * are skipped, never guessed at. Returns `[]` when there is nothing machine-readable.
 */
export function extractJsonLdInterpretations(
  blocks: readonly string[] | undefined,
  ctx: InterpretContext,
): Interpretation[] {
  const out: Interpretation[] = [];
  if (blocks === undefined || blocks.length === 0) return out;
  const emitCtx: EmitContext = { out, confidence: 1, calibration: "Calibrated" };
  let eventCount = 0;
  let messageCount = 0;

  for (const text of blocks) {
    const root = parseBlock(text);
    if (root === undefined) continue;
    // The AgenticReply carrier has its own (signature-aware) extractor.
    if (isAgenticReplyNode(root)) continue;
    // Closed-world context gate: only the well-known schema.org context is mapped.
    if (
      !isSchemaOrgContext(
        prop(root, "@context") ?? prop(Array.isArray(root) ? root[0] : root, "@context"),
      )
    ) {
      continue;
    }

    for (const node of topLevelNodes(root)) {
      if (eventCount >= MAX_EVENTS_PER_MESSAGE) break;

      // A reservation wraps its event in `reservationFor` (Gmail EventReservation markup).
      let eventNode: unknown;
      if (hasSchemaType(node, "Event")) {
        eventNode = node;
      } else if (hasSchemaType(node, "EventReservation")) {
        const wrapped = prop(node, "reservationFor");
        if (hasSchemaType(wrapped, "Event")) eventNode = wrapped;
      }
      if (eventNode !== undefined) {
        eventCount++;
        mapEventNode(eventNode, `${ctx.docIri}#md-event-${eventCount}`, emitCtx);
        continue;
      }

      // A message envelope: `schema:Message` with `dateSent` (the "sent-at" pattern).
      if (hasSchemaType(node, "Message")) {
        if (messageCount >= MAX_EVENTS_PER_MESSAGE) continue;
        messageCount++;
        const messageIri = `${ctx.docIri}#md-message-${messageCount}`;
        emit(emitCtx, messageIri, RDF_TYPE, { kind: "iri", value: SCHEMA_MESSAGE });
        emitWhen(emitCtx, messageIri, SCHEMA_DATE_SENT, prop(node, "dateSent"));
      }
    }
  }
  return out;
}
