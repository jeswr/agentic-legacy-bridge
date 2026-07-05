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
/** True when an untrusted `@context` value denotes (or includes) the schema.org context. */
export declare function isSchemaOrgContext(context: unknown, depth?: number): boolean;
/** True when a node declares the given schema.org type (bare / prefixed / full-IRI). */
export declare function hasSchemaType(node: unknown, typeName: string): boolean;
/** True when a block root (or any of its top-level nodes) declares `AgenticReply`. */
export declare function isAgenticReplyNode(node: unknown): boolean;
/** Shared shape of one interpreted-statement emission (exported for the reply extractor). */
export interface EmitContext {
    readonly out: Interpretation[];
    readonly confidence: number;
    readonly calibration: Interpretation["calibration"];
}
/**
 * Map one schema.org `Event`-shaped node onto interpretations under `eventIri`.
 * Accepts BOTH the schema.org `startDate`/`endDate` spelling (real Gmail markup)
 * and the design carrier's `startTime`/`endTime` — a fixed alias table, no guessing.
 * Exported for reuse by the AgenticReply extractor.
 */
export declare function mapEventNode(node: unknown, eventIri: string, ctx: EmitContext): void;
/**
 * Extract confidence-1.0 deterministic {@link Interpretation}s from a message's
 * embedded JSON-LD blocks (Rule 1a). Blocks that are not recognised schema.org
 * markup — including `AgenticReply` carriers, which the dedicated extractor owns —
 * are skipped, never guessed at. Returns `[]` when there is nothing machine-readable.
 */
export declare function extractJsonLdInterpretations(blocks: readonly string[] | undefined, ctx: InterpretContext): Interpretation[];
//# sourceMappingURL=jsonld.d.ts.map