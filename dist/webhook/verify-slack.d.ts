/**
 * Slack Events API request verification (M2-DESIGN.md §3.2) — a PURE function of
 * (headers, raw body, signing secret, now). Authenticity of a Slack delivery is the
 * webhook service's job; the transform ({@link slackEventToBridgeMessage}) trusts
 * NOTHING about the source. This module is the gate that runs BEFORE any JSON parse.
 *
 * ## The Slack v0 signature (primary-source: docs.slack.dev/authentication/verifying-requests-from-slack)
 *
 *  - `X-Slack-Signature` = `v0=` + lower-hex `HMAC-SHA256(signingSecret,
 *    "v0:" + X-Slack-Request-Timestamp + ":" + <RAW request body>)`.
 *  - The HMAC is computed over the EXACT raw body BYTES (never a re-serialised JSON
 *    round-trip — that would change the bytes and the HMAC would never match).
 *  - Reject when `|now − X-Slack-Request-Timestamp| > 300 s` (the replay window) —
 *    even a byte-perfect captured request cannot be replayed after 5 minutes.
 *  - The signature comparison is CONSTANT-TIME (`crypto.timingSafeEqual`) — a
 *    byte-by-byte early-exit `===` leaks, over many probes, how much of a forged
 *    signature is correct.
 *
 * Fail-closed everywhere: a missing header, a non-numeric / stale timestamp, an
 * empty/blank secret (a mis-config must never verify-open), or any mismatch returns a
 * typed failure — the caller answers `401` with no body detail and writes nothing but
 * a counter (M2-DESIGN.md §3.2: don't hand a prober an oracle).
 */
/** The Slack signature header. */
export declare const SLACK_SIGNATURE_HEADER = "x-slack-signature";
/** The Slack request-timestamp header. */
export declare const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** The replay window Slack recommends: reject a request older/newer than 5 minutes. */
export declare const SLACK_MAX_SKEW_SECONDS = 300;
/** Why a Slack verification failed (a counter dimension; never leaked to the client). */
export type SlackVerifyFailure = "no-secret" | "missing-signature" | "missing-timestamp" | "bad-timestamp" | "stale-timestamp" | "signature-mismatch";
/** The result of {@link verifySlackSignature}. */
export type SlackVerifyResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: SlackVerifyFailure;
};
/**
 * Verify a Slack Events API request's `v0` signature over the RAW body bytes.
 *
 * @param headers  the request headers (case-insensitive keys accepted)
 * @param rawBody  the EXACT raw request body bytes (what Slack signed)
 * @param signingSecret  the app's Signing Secret (from the service env; never logged)
 * @param nowEpochMs  the current time in epoch milliseconds (injectable for tests)
 */
export declare function verifySlackSignature(headers: Readonly<Record<string, string>>, rawBody: Uint8Array, signingSecret: string, nowEpochMs: number): SlackVerifyResult;
//# sourceMappingURL=verify-slack.d.ts.map