// AUTHORED-BY Claude Fable 5
/**
 * The Rule-1 ORCHESTRATOR (`NOW-PERSONAL-AGENT.md` §5.1): run every deterministic
 * metadata extractor — embedded schema.org JSON-LD, `text/calendar` VEVENTs, an
 * `AgenticReply` carrier — BEFORE any model reads anything. Zero LLM tokens, zero
 * prompt-injection surface; only residual unstructured prose should fall through to
 * the injection-contained LLM interpreter (M2.3).
 *
 * Two entry points:
 *  - {@link StructuredMetadataInterpreter} — the package's sync {@link Interpreter}
 *    seam (drop-in for `importInbound`), signature-blind: AgenticReply blocks are
 *    extracted STRUCTURALLY (SelfReported — never auto-run).
 *  - {@link extractStructuredMetadata} — the async full pass with the injectable
 *    {@link AgenticReplyVerifier}, returning the declared pattern conformances too
 *    (the §5.3 `(pattern hash → handler)` cache key).
 *
 * {@link composeInterpreters} chains this in FRONT of the textual deterministic
 * reference (and/or the LLM adapter): structured metadata first, prose fallback last.
 */

import type { EmailMessage } from "../email/types.js";
import type { InterpretContext, Interpreter } from "../interpret.js";
import { asBridgeMessage, type BridgeMessage } from "../message.js";
import type { Interpretation } from "../reliability.js";
import {
  type AgenticReplyVerifier,
  extractAgenticReply,
  extractAgenticReplyStructural,
  type PatternConformance,
} from "./agentic-reply.js";
import { extractCalendarInterpretations } from "./ical.js";
import { extractJsonLdInterpretations } from "./jsonld.js";

/** Hard cap on interpretations one message can yield across all extractors. */
const MAX_TOTAL_INTERPRETATIONS = 128;

/** Bound a combined interpretation list (fail-closed — extras dropped, never grown). */
function capped(interpretations: Interpretation[]): Interpretation[] {
  return interpretations.length > MAX_TOTAL_INTERPRETATIONS
    ? interpretations.slice(0, MAX_TOTAL_INTERPRETATIONS)
    : interpretations;
}

/**
 * The sync structured-metadata {@link Interpreter}: JSON-LD + iCal + STRUCTURAL
 * AgenticReply (unverified → SelfReported). Stateless and hermetic.
 */
export class StructuredMetadataInterpreter implements Interpreter {
  interpret(message: BridgeMessage | EmailMessage, ctx: InterpretContext): Interpretation[] {
    const m = asBridgeMessage(message);
    return capped([
      ...extractJsonLdInterpretations(m.jsonLdBlocks, ctx),
      ...extractCalendarInterpretations(m.calendarParts, ctx),
      ...extractAgenticReplyStructural(m.jsonLdBlocks, ctx).interpretations,
    ]);
  }
}

/** A ready-to-use singleton of the sync structured-metadata interpreter. */
export const structuredMetadataInterpreter: Interpreter = new StructuredMetadataInterpreter();

/** The result of the full (verifier-aware) structured-metadata pass. */
export interface StructuredMetadataResult {
  /** All deterministic interpretations (capped). */
  readonly interpretations: readonly Interpretation[];
  /** The pattern conformances declared by AgenticReply blocks (deduped by IRI). */
  readonly patterns: readonly PatternConformance[];
  /** True iff at least one AgenticReply block's signature VERIFIED. */
  readonly agenticReplyVerified: boolean;
  /** The verified issuer identity, when any. */
  readonly issuer?: string;
}

/** Options for {@link extractStructuredMetadata}. */
export interface StructuredMetadataOptions {
  /** The injectable AgenticReply signature verifier (`@jeswr/solid-vc` adapter). */
  readonly verify?: AgenticReplyVerifier;
}

/**
 * The FULL Rule-1 pass: every deterministic extractor, with signature verification
 * for AgenticReply blocks when a verifier is injected. Never throws on hostile
 * input; a throwing verifier counts as unverified.
 */
export async function extractStructuredMetadata(
  message: BridgeMessage | EmailMessage,
  ctx: InterpretContext,
  options?: StructuredMetadataOptions,
): Promise<StructuredMetadataResult> {
  const m = asBridgeMessage(message);
  const reply = await extractAgenticReply(m.jsonLdBlocks, ctx, {
    ...(options?.verify !== undefined ? { verify: options.verify } : {}),
  });
  return {
    interpretations: capped([
      ...extractJsonLdInterpretations(m.jsonLdBlocks, ctx),
      ...extractCalendarInterpretations(m.calendarParts, ctx),
      ...reply.interpretations,
    ]),
    patterns: reply.patterns,
    agenticReplyVerified: reply.verified,
    ...(reply.issuer !== undefined ? { issuer: reply.issuer } : {}),
  };
}

/**
 * Chain interpreters in order (structured metadata FIRST, textual/LLM fallback
 * last), concatenating their outputs under the shared cap. Each interpreter's
 * failure domain stays its own — one throwing interpreter aborts the chain (the
 * package's interpreters never throw on hostile input by contract).
 */
export function composeInterpreters(...interpreters: readonly Interpreter[]): Interpreter {
  return {
    interpret(message: BridgeMessage | EmailMessage, ctx: InterpretContext): Interpretation[] {
      const out: Interpretation[] = [];
      for (const interpreter of interpreters) {
        out.push(...interpreter.interpret(message, ctx));
        if (out.length >= MAX_TOTAL_INTERPRETATIONS) break;
      }
      return capped(out);
    },
  };
}
