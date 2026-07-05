// AUTHORED-BY Claude Fable 5
/**
 * `@jeswr/agentic-legacy-bridge/webhook` — the M2.4 stateless, pod-as-state inbound
 * webhook service (M2-DESIGN.md §3). Receives a raw Slack Events API / WhatsApp
 * Business Cloud delivery, AUTHENTICATES the source (HMAC over the raw bytes, before
 * any parse), and writes the message OWNER-PRIVATE into a pod create-only + idempotent.
 *
 * The whole surface is injectable — signature secret, pod write-fetch, interpreter,
 * clock — so it is fully testable with no live network or credentials. Live channel
 * credentials are a deployment (`needs:user`) concern, never hardcoded.
 *
 * @packageDocumentation
 */
export { createFetchWebhookHandler } from "./fetch-adapter.js";
export { createWebhookHandler, DEFAULT_MAX_BODY_BYTES, } from "./handler.js";
export { headerValue, OK, PAYLOAD_TOO_LARGE, UNAUTHORIZED, } from "./request.js";
export { META_SIGNATURE_HEADER, metaVerificationChallenge, verifyMetaSignature, } from "./verify-meta.js";
export { SLACK_MAX_SKEW_SECONDS, SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, verifySlackSignature, } from "./verify-slack.js";
export { writeMessageCreateOnly, } from "./write.js";
//# sourceMappingURL=index.js.map