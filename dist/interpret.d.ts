/**
 * The INTERPRETATION seam (LEGACY-INTEROP.md §3) — turn a message body into
 * reliability-tagged structured RDF.
 *
 * The {@link Interpreter} interface is INJECTABLE: M1 ships a hermetic, deterministic
 * rule-based reference ({@link DeterministicInterpreter}) with NO model dependency,
 * so tests are fully hermetic. The design's LLM path (an injected `translate` fn via
 * `@jeswr/solid-a2a` `parseIntent`) is an M2 adapter that implements this SAME
 * interface — the reliability model (per-datum confidence + calibration provenance)
 * is identical either way; only the METHOD (`Deterministic` vs `LlmInterpretation`)
 * and the calibration differ.
 *
 * The deterministic reference extracts the flagship signal — proposed MEETING times
 * (explicit ISO-8601 datetimes at high, re-derivable confidence; a bounded subset of
 * relative expressions like "next Tuesday at 2pm" at lower, self-reported confidence)
 * — plus a simple yes/no reply polarity. Every regex is linear (no backtracking on
 * attacker input) and every extraction is count-capped.
 */
import type { EmailMessage } from "./email/types.js";
import type { Interpretation } from "./reliability.js";
/** Context for an interpretation pass. */
export interface InterpretContext {
    /** The document base IRI — interpreted subjects are minted as `${docIri}#event-<n>` etc. */
    readonly docIri: string;
    /** "Now", injectable so relative-date resolution is deterministic in tests. Defaults to `new Date()`. */
    readonly now?: Date;
}
/** The interpretation seam: message → reliability-tagged interpreted data. */
export interface Interpreter {
    interpret(message: EmailMessage, ctx: InterpretContext): Interpretation[];
}
/**
 * The hermetic, deterministic reference interpreter. No model, no network — a pure
 * function of the message body + `ctx.now`.
 */
export declare class DeterministicInterpreter implements Interpreter {
    interpret(message: EmailMessage, ctx: InterpretContext): Interpretation[];
}
/** A ready-to-use singleton of the deterministic reference interpreter. */
export declare const deterministicInterpreter: Interpreter;
/**
 * Extract valid ISO-8601 datetimes from text (linear, bounded). Each match is
 * re-validated by `Date.parse` (so `2026-13-40T99:99` is rejected) and canonicalised
 * to a UTC ISO string. Deduped + capped.
 */
export declare function extractIsoDateTimes(text: string): string[];
/**
 * Extract a BOUNDED subset of relative meeting expressions: `today`/`tomorrow`/a
 * weekday (optionally `next`), combined with an explicit time (`at 2pm`, `at 14:00`).
 * Resolved against `now` in UTC (the timezone ambiguity is why these carry a lower,
 * self-reported confidence and a note). Returns at most a few, deduped.
 */
export declare function extractRelativeMeetings(text: string, now: Date): Array<{
    iso: string;
    note: string;
}>;
//# sourceMappingURL=interpret.d.ts.map