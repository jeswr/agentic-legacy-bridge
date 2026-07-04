/**
 * Map a parsed inbound message ({@link BridgeMessage}, or an M1
 * {@link EmailMessage} unchanged) to a `@jeswr/solid-chat-interop`
 * {@link CanonicalMessage} and serialise it with the package's TYPED serialisers
 * (never hand-built triples) — so the sender's raw text lands owner-private in the
 * pod as an ordinary chat message readable by Pod Manager `/chat` and any AS2 reader,
 * and is never lost or mutated by the interpretation step (LEGACY-INTEROP.md §2.2).
 *
 * Two rules hold here, on EVERY channel:
 *  - **body is ALWAYS `text/plain`** — the channel parse already stripped/derived
 *    plain text (HTML/mrkdwn never persisted); we re-assert the media type so no
 *    untrusted markup can slip through (the stored-XSS lesson).
 *  - **no unverified identity as `author`** — a channel handle authenticates
 *    nothing, so the canonical `author` (a verified human WebID) is left UNSET. The
 *    full sender/provenance linkage lives in the agentic graph, keyed on the
 *    raw-message anchor; `solid-chat-interop` drops non-http(s) IRIs anyway, so the
 *    `urn:` anchors would not survive here.
 */
import { type CanonicalMessage } from "@jeswr/solid-chat-interop";
import type { EmailMessage } from "./email/types.js";
import type { BridgeMessage } from "./message.js";
/**
 * Build a {@link CanonicalMessage} from a parsed inbound message (channel-neutral).
 * `content` is the plain-text body; `published` is the sender-claimed date (when
 * parseable). `author` is deliberately unset (no verified WebID).
 */
export declare function toCanonicalMessage(message: BridgeMessage | EmailMessage): CanonicalMessage;
/**
 * Build a {@link CanonicalMessage} from a parsed email — the M1 entry point,
 * unchanged; email is now just the first channel of {@link toCanonicalMessage}.
 */
export declare function emailToCanonical(message: EmailMessage): CanonicalMessage;
/**
 * Serialise the canonical message as an ActivityStreams 2.0 Turtle resource at
 * `resourceUrl` (the suite's canonical write shape), via `solid-chat-interop`'s
 * typed `serializeAs2`. `resourceUrl` MUST be an absolute http(s) resource IRI;
 * the subject is its `#it`.
 */
export declare function serializeCanonical(message: BridgeMessage | EmailMessage, resourceUrl: string): Promise<string>;
//# sourceMappingURL=canonical.d.ts.map