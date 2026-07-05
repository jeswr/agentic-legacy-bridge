/**
 * Meta / WhatsApp Business Cloud webhook verification (M2-DESIGN.md §3.2) — PURE
 * functions for (1) the delivery-`POST` `X-Hub-Signature-256` HMAC check and (2) the
 * registration-`GET` `hub.challenge` echo. Authenticity of a Meta delivery is the
 * webhook service's job; the transform ({@link waMessageToBridgeMessage}) trusts
 * NOTHING about the source. This module runs BEFORE any JSON parse.
 *
 * ## The signature (primary-source: developers.facebook.com/docs/graph-api/webhooks)
 *
 *  - Every delivery `POST` carries `X-Hub-Signature-256: sha256=<lower-hex
 *    HMAC-SHA256(App Secret, RAW body)>`. There is NO timestamp — replay is bounded
 *    NOT by a time window (Meta retries a failed delivery over ~36 h) but by the
 *    create-only slug idempotency at the persistence layer (M2-DESIGN.md §3.4).
 *  - The HMAC is over the EXACT raw body bytes; the compare is CONSTANT-TIME.
 *
 * ## Registration handshake (`GET`)
 *
 *  - Meta sends `GET ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<c>`.
 *  - The service echoes `hub.challenge` back as `text/plain` IFF `hub.mode` is
 *    `subscribe` AND `hub.verify_token` equals the configured verify token (a
 *    CONSTANT-TIME compare). Otherwise it REFUSES (no echo) — a wrong/absent token can
 *    never drive an arbitrary reflected response. The verify token lives only in the
 *    service env.
 *
 * Fail-closed everywhere: an empty/blank secret or verify token never verifies-open.
 */
/** The Meta HMAC signature header. */
export declare const META_SIGNATURE_HEADER = "x-hub-signature-256";
/** Why a Meta signature verification failed (a counter dimension; never leaked). */
export type MetaVerifyFailure = "no-secret" | "missing-signature" | "signature-mismatch";
/** The result of {@link verifyMetaSignature}. */
export type MetaVerifyResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: MetaVerifyFailure;
};
/**
 * Verify a Meta webhook delivery's `X-Hub-Signature-256` HMAC over the RAW body bytes.
 *
 * @param headers  the request headers (case-insensitive keys accepted)
 * @param rawBody  the EXACT raw request body bytes (what Meta signed)
 * @param appSecret  the WhatsApp app's App Secret (from the service env; never logged)
 */
export declare function verifyMetaSignature(headers: Readonly<Record<string, string>>, rawBody: Uint8Array, appSecret: string): MetaVerifyResult;
/** The result of {@link metaVerificationChallenge}. */
export type MetaChallengeResult = {
    readonly ok: true;
    readonly challenge: string;
} | {
    readonly ok: false;
};
/**
 * Handle the Meta registration `GET`: return the `hub.challenge` to echo IFF
 * `hub.mode === "subscribe"` AND `hub.verify_token` matches (constant-time) the
 * configured `verifyToken`. Any mismatch / missing param / blank configured token →
 * `{ ok: false }` (REFUSE — no echo). The challenge is length-capped; it is echoed
 * verbatim within the cap (Meta byte-compares it), and only ever after the token
 * match, so it can never become an attacker-chosen reflected response.
 *
 * @param query  the URL query params (`hub.mode`, `hub.verify_token`, `hub.challenge`)
 * @param verifyToken  the configured verify token (from the service env)
 */
export declare function metaVerificationChallenge(query: Readonly<Record<string, string>> | undefined, verifyToken: string): MetaChallengeResult;
//# sourceMappingURL=verify-meta.d.ts.map