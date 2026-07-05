/**
 * Shared, security-critical primitives for the webhook signature verifiers
 * ({@link ./verify-slack.ts}, {@link ./verify-meta.ts}) — one home so both channels
 * compare secrets identically (no divergent copy of a constant-time compare).
 */
/**
 * Constant-time string compare. A length difference is NOT secret (an expected
 * signature / shared-token length is fixed + public), so an early length check is
 * safe; equal-length inputs are compared with `timingSafeEqual` so no byte-position of
 * a forged value leaks through timing. Returns `false` for a non-string input.
 */
export declare function constantTimeEqual(a: unknown, b: unknown): boolean;
/**
 * Lower-case all header keys into a null-prototype map (a hostile `__proto__`/
 * `constructor` header key becomes an ordinary own property, never touches the
 * prototype chain). Non-string values are dropped.
 */
export declare function lowerCaseHeaderKeys(headers: Readonly<Record<string, string>>): Record<string, string>;
//# sourceMappingURL=verify-util.d.ts.map