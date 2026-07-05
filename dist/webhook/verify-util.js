// AUTHORED-BY Claude Fable 5
/**
 * Shared, security-critical primitives for the webhook signature verifiers
 * ({@link ./verify-slack.ts}, {@link ./verify-meta.ts}) — one home so both channels
 * compare secrets identically (no divergent copy of a constant-time compare).
 */
import { timingSafeEqual } from "node:crypto";
/**
 * Constant-time string compare. A length difference is NOT secret (an expected
 * signature / shared-token length is fixed + public), so an early length check is
 * safe; equal-length inputs are compared with `timingSafeEqual` so no byte-position of
 * a forged value leaks through timing. Returns `false` for a non-string input.
 */
export function constantTimeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string")
        return false;
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length)
        return false;
    return timingSafeEqual(bufA, bufB);
}
/**
 * Lower-case all header keys into a null-prototype map (a hostile `__proto__`/
 * `constructor` header key becomes an ordinary own property, never touches the
 * prototype chain). Non-string values are dropped.
 */
export function lowerCaseHeaderKeys(headers) {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string")
            out[k.toLowerCase()] = v;
    }
    return out;
}
//# sourceMappingURL=verify-util.js.map