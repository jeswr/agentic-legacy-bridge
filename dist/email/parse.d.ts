/**
 * A minimal, HOSTILE-INPUT-HARDENED RFC 5322 / MIME parser.
 *
 * The ENTIRE input is untrusted. The design goals, in priority order:
 *  1. **Never crash / never hang.** Every cap is explicit; every decode is
 *     try/caught; no regex has super-linear backtracking on attacker input. The
 *     ONLY throw is {@link EmailParseError} for a message that exceeds the hard
 *     input cap — a controlled, typed, fail-closed refusal (callers can catch it).
 *     Everything else degrades: a malformed part is dropped, a bad encoding falls
 *     back, a cap-exceeding structure is truncated — each with a `warnings` entry.
 *  2. **No header injection.** Header VALUES are unfolded and control-stripped, so
 *     a `\r\n`-carrying value can never split into a second header downstream.
 *  3. **No stored XSS.** HTML is never surfaced as HTML — the body is always plain
 *     text (a text/plain part preferred; text/html tag-stripped as a last resort).
 *  4. **Byte-faithful structure, charset-correct leaves.** Structure is parsed in a
 *     byte-preserving `latin1` view (1 char = 1 byte), so a leaf part's original
 *     bytes are recoverable and decoded with ITS declared charset.
 *
 * This is an EMAIL parser (explicitly allowed to be in-house — the RDF house rule
 * bans only bespoke *RDF* parsers). It is intentionally small: envelope headers +
 * one plain-text body, not a faithful MIME object model.
 */
import type { EmailMessage } from "./types.js";
/** A controlled, typed, fail-closed refusal (the only throw from {@link parseEmail}). */
export declare class EmailParseError extends Error {
    constructor(message: string);
}
/**
 * Parse raw email bytes/text into an {@link EmailMessage}. Fail-closed + never
 * hangs; the only throw is {@link EmailParseError} when the input exceeds the hard
 * byte cap. All other malformations degrade with a `warnings` entry.
 */
export declare function parseEmail(input: string | Uint8Array): EmailMessage;
//# sourceMappingURL=parse.d.ts.map