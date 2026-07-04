// AUTHORED-BY Claude Opus 4.8
/**
 * The WHATSAPP (Business Cloud API) {@link ChannelAdapter} (M2-DESIGN.md §1.2) — a
 * pure, hostile-input-hardened transform ({@link waMessageToBridgeMessage}) from a
 * WhatsApp Cloud webhook delivery (its `entry[].changes[].value.messages[]` entry)
 * into the channel-neutral {@link BridgeMessage}, plus a thin
 * {@link WhatsAppChannelAdapter} that plugs into the M2.0 pipeline unchanged
 * (`parse` = the transform). Mirrors the M2.1 Slack adapter's posture exactly.
 *
 * ## Positioning — the BUSINESS / hosted persona ONLY
 *
 * PERSONAL WhatsApp (and Signal / Telegram) stay on the `@jeswr/matrix-chat-to-pod`
 * (mautrix → Matrix) path — already the working inbound path for personal accounts.
 * This native adapter serves ONLY the org-run bridge persona: a business / front-desk
 * agent with a WhatsApp Business Account (WABA), where webhook-native inbound + the
 * official send API matter. Do NOT route personal accounts here (M2-DESIGN.md §1.2).
 *
 * ## The webhook payload is UNTRUSTED end-to-end
 *
 * Everything in a Meta webhook delivery is attacker-influenceable. The transform
 * therefore:
 *  - **never crashes / never hangs** — every field is read defensively, the input is
 *    byte-capped BEFORE JSON parse, and every id/number regex is ANCHORED + linear
 *    (single char class, bounded quantifier → no nested quantifier → no ReDoS). The
 *    ONLY throw is {@link WhatsAppParseError} (a {@link ChannelParseError}) for a
 *    refused input, which `importInbound` treats as "skip this message, never abort
 *    the batch";
 *  - keeps `textBody` **plain text ONLY** — only a `type: "text"` message's
 *    `text.body` is retained (control-stripped, capped). Interactive / template /
 *    button / media / location / reaction messages carry NO plain-text body, so they
 *    are REFUSED (skipped) — their content is NEVER flattened into markup or
 *    persisted (the stored-XSS class the estate guards against — the
 *    `matrix-chat-to-pod` lesson). Media handling (record metadata, never fetch at
 *    webhook time) is a later phase (M2-DESIGN.md §1.2);
 *  - **validates the `from` / `wa_id` phone-number handle before it mints anything**
 *    (digits, bounded). An out-of-shape handle yields NO sender, so `personIriFor`
 *    falls back to a provisional anon node (fail-closed per M2.0) — a handle carrying
 *    an IRIREF-forbidden char can never reach a `namedNode()` (it is base64url-folded
 *    into the person URN regardless, but the shape gate keeps garbage out of the
 *    identity graph entirely);
 *  - mints a `tel:` IRI candidate ONLY via {@link waIdToTelIri} — strict E.164, the
 *    `safeMailtoIri` sibling — so an attacker-controlled `wa_id` can never inject a
 *    malformed `tel:` IRI (see below).
 *
 * The remote read side does not exist for WhatsApp: **there is no history-poll API**
 * for arbitrary past messages — inbound is webhook-only (Meta pushes). So the
 * {@link WhatsAppChannelAdapter}'s `pullInbound` returns only already-received
 * deliveries (a webhook batch); there is no backfill `pull` analogue to Slack's
 * `conversations.history`. M2.2 is the PARSE transform only; the live webhook
 * receiver (verify → transform → owner-private create-only pod write) is M2.4.
 *
 * ## Webhook signature-verification contract (for the M2.4 webhook service)
 *
 * The transform authenticates NOTHING about the *source* — a Meta delivery's
 * authenticity is the webhook service's job, verified over the RAW request body
 * BEFORE any JSON parse (M2-DESIGN.md §3.2), and endpoint registration is answered
 * before any message parse:
 *
 *  1. **Endpoint registration (`GET`).** Meta sends `GET` with `hub.mode=subscribe`,
 *     `hub.verify_token`, and `hub.challenge`. The service echoes `hub.challenge`
 *     back as the plain-text response body IFF `hub.verify_token` equals the
 *     configured verify token (a CONSTANT-TIME compare). This is a GET query, not a
 *     message body — it never reaches this transform.
 *  2. **`X-Hub-Signature-256` HMAC.** Every delivery `POST` carries
 *     `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(RAW body, App Secret)>`. The
 *     service recomputes the HMAC over the EXACT raw request bytes (before any JSON
 *     parse) and compares in CONSTANT TIME; a mismatch is answered `401` with no body
 *     detail and nothing written or logged beyond a counter (don't hand a prober an
 *     oracle). The App Secret lives ONLY in the service env — never in a URL, a log,
 *     or a pod resource.
 *  3. **Retry / replay dedupe.** Meta retries a failed delivery aggressively (over
 *     ~36 hours), so idempotent handling is MANDATORY — but the `id` (wamid) is
 *     GLOBALLY unique, so a deterministic in-pod slug keyed on the wamid maps a
 *     retried / replayed delivery to the SAME URL. NOTE the M2.1 `importInbound`
 *     write path is a plain `PUT` (overwrite) and does NOT itself provide
 *     idempotency; the M2.4 service must add create-only writes (`If-None-Match: *`,
 *     treating `412` as already-imported) — the property the design assigns to the
 *     service, not this adapter (M2-DESIGN.md §3.3/§3.4). No dedupe table is needed.
 *  4. **Batching / fan-out.** Unlike a Slack Events API delivery (one message per
 *     delivery), ONE Meta webhook body can carry MANY messages
 *     (`entry[].changes[].value.messages[]`). This transform parses ONE message per
 *     call — selected by {@link WhatsAppParseContext.messageIndex} (default 0) over
 *     the SAME raw bytes — so the M2.4 service fans a multi-message delivery out by
 *     calling the transform once per index (each yields a distinct
 *     `messageId`/wamid; all share the one signed-delivery `rawSha256` anchor, which
 *     is honest — they arrived in one authenticated delivery). A multi-message body
 *     records a `warnings` entry so the fan-out is visible.
 *
 * ## No structured-reply / capability carrier on WhatsApp
 *
 * WhatsApp has NO metadata / HTML carrier — replies are plain text (+ interactive
 * types) and free-form replies are only allowed inside the 24-hour customer-service
 * window (M2-DESIGN.md §1.2/§1.3). So `signals` is ALWAYS empty here (a WhatsApp
 * message can never advertise bridge capability inline; capabilities are read from
 * the pod copy at the negotiation layer, out of this transform's scope), and the
 * structured carrier degrades to the pod-copy pointer form — assembled by
 * `buildReply`/`sendReply` at the M2.4 send phase, NOT here. `sendReply` (when built)
 * MUST refuse to send free-form outside the 24-hour service window.
 */
import { createHash } from "node:crypto";
import { ChannelParseError } from "./errors.js";
import { safeTelIri, sanitizeText } from "./safe-iri.js";
/** The channel name written as `agentic:channel` for a WhatsApp message. */
export const WHATSAPP_CHANNEL = "whatsapp";
/** The media type of the byte-exact raw anchor (a Meta webhook body is JSON). */
export const WHATSAPP_RAW_MEDIA_TYPE = "application/json";
// --- hard caps (fail-closed) -------------------------------------------------
/** Hard cap on the whole webhook body; over this throws {@link WhatsAppParseError}. */
const MAX_EVENT_BYTES = 1024 * 1024;
/** Cap on the retained plain-text body length. */
const MAX_TEXT_CHARS = 100_000;
/** Cap on a display name (`profile.name`). */
const MAX_NAME_CHARS = 200;
// --- WhatsApp id / number shapes (anchored + linear → ReDoS-free) ------------
/**
 * A WhatsApp `wa_id` / `from` — the customer's phone number, digits only, bounded.
 * E.164 caps an international number at 15 digits; we allow a little slack (a test
 * number can be shorter). Digits-only by construction, so nothing here can carry an
 * IRIREF-forbidden char; the shape gate exists to keep GARBAGE out of the identity
 * graph, not for injection safety (base64url-folding already provides that).
 */
const WA_ID = /^[1-9]\d{4,17}$/;
/**
 * A WhatsApp message id (`wamid.<base64>`). Anchored, single char class, bounded
 * quantifier → linear. Rejects any IRIREF-forbidden char (`>`, space, newline, …),
 * so an injected id can never break out of a `<...>` downstream.
 */
const WAMID = /^wamid\.[A-Za-z0-9+/=_-]{1,512}$/;
/** A WhatsApp `timestamp` — Unix epoch SECONDS as a decimal string, bounded. */
const WA_TIMESTAMP = /^\d{1,15}$/;
/**
 * A controlled, typed, fail-closed refusal (the only throw from
 * {@link waMessageToBridgeMessage}). Extends the channel-neutral
 * {@link ChannelParseError} (M2.0) so `importInbound`'s skip-don't-abort catch is
 * channel-agnostic.
 */
export class WhatsAppParseError extends ChannelParseError {
    constructor(message) {
        super(message);
        this.name = "WhatsAppParseError";
    }
}
/** Narrow an untrusted value to a plain (non-array) object. */
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** Narrow an untrusted value to a string. */
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
/** Narrow an untrusted value to an array. */
function asArray(value) {
    return Array.isArray(value) ? value : undefined;
}
/** Force a value single-line (a display name must never carry a line break). */
function oneLine(value) {
    return value
        .replace(/[\r\n\t]+/g, " ")
        .replace(/ {2,}/g, " ")
        .trim();
}
/** Convert a validated Unix-seconds timestamp string to an ISO-8601 datetime, or undefined. */
function timestampToIso(ts) {
    const ms = Number(ts) * 1000;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15)
        return undefined;
    return new Date(ms).toISOString();
}
/**
 * Build an injection-safe `tel:` IRI CANDIDATE (RFC 3966 global-number form) from a
 * WhatsApp `wa_id` — the phone-keyed sibling of email's `safeMailtoIri` (M2-DESIGN.md
 * §1.2). A `wa_id` is the customer's phone number WITHOUT the leading `+`, so this
 * prepends `+` and delegates to the strict-E.164 {@link safeTelIri} (which fails
 * closed on anything but `+` and 7–15 digits, first digit non-zero). Returns the
 * `tel:` IRI, or `undefined` when the handle is not a usable E.164 number.
 *
 * This is a PURE seam: M2.2 is the PARSE transform only, and the person → RDF path
 * (`addSenderPerson`) records a channel-scoped handle as a `schema:identifier`
 * literal EXACTLY as for Slack — the pipeline is unchanged. The `schema:telephone`
 * `tel:` edge the design describes (M2-DESIGN.md §1.2) is wired at the sender/import
 * layer via this helper WITHOUT touching the M2.0 pipeline — the same deferral posture
 * M2.1 used for its candidate-email → `agentic:candidatePerson` hint.
 */
export function waIdToTelIri(waId) {
    if (typeof waId !== "string")
        return undefined;
    const digits = waId.trim().replace(/^\+/, "");
    if (!/^[0-9]{1,20}$/.test(digits))
        return undefined;
    return safeTelIri(`+${digits}`);
}
/**
 * Resolve the flattened, in-order list of `messages[]` (plus the sibling `contacts[]`
 * for display names) from an UNTRUSTED webhook payload. Accepts:
 *  - the full webhook body — `{ object: "whatsapp_business_account", entry: [{ changes:
 *    [{ field: "messages", value: { messages, contacts, … } }] }] }`;
 *  - a bare `value` change object — `{ messaging_product: "whatsapp", messages,
 *    contacts, … }` (a fanned-out feed);
 *  - a bare single message object — `{ from, id, type, text, … }` (no contacts, so no
 *    display name).
 *
 * Only `field === "messages"` changes contribute (a `statuses`/receipt change, or any
 * other field, carries no importable message). Returns `messages` in delivery order
 * and the union of `contacts` across the contributing changes.
 */
function resolveMessages(envelope) {
    const messages = [];
    const contacts = [];
    const collectValue = (value) => {
        if (value === undefined)
            return;
        for (const m of asArray(value.messages) ?? []) {
            const rec = asRecord(m);
            if (rec !== undefined)
                messages.push(rec);
        }
        for (const c of asArray(value.contacts) ?? []) {
            const rec = asRecord(c);
            if (rec !== undefined)
                contacts.push(rec);
        }
    };
    const entries = asArray(envelope.entry);
    if (entries !== undefined) {
        // Full webhook body: walk entry[].changes[] taking only `field: "messages"`.
        for (const entry of entries) {
            const entryRec = asRecord(entry);
            if (entryRec === undefined)
                continue;
            for (const change of asArray(entryRec.changes) ?? []) {
                const changeRec = asRecord(change);
                if (changeRec === undefined)
                    continue;
                if (asString(changeRec.field) !== "messages")
                    continue;
                collectValue(asRecord(changeRec.value));
            }
        }
        return { messages, contacts };
    }
    if (Array.isArray(envelope.messages)) {
        // A bare `value` change object.
        collectValue(envelope);
        return { messages, contacts };
    }
    // A bare single message object (`from`/`id`/`type` present) — no contacts.
    if (asString(envelope.id) !== undefined || asString(envelope.from) !== undefined) {
        messages.push(envelope);
    }
    return { messages, contacts };
}
/** Best-effort, control-stripped, single-line, capped `profile.name` for a wa_id (or undefined). */
function contactName(contacts, waId) {
    for (const contact of contacts) {
        if (asString(contact.wa_id) !== waId)
            continue;
        const profile = asRecord(contact.profile);
        const name = profile !== undefined ? asString(profile.name) : undefined;
        if (name === undefined)
            continue;
        const clean = oneLine(sanitizeText(name)).slice(0, MAX_NAME_CHARS).trim();
        if (clean !== "")
            return clean;
    }
    return undefined;
}
/**
 * Parse a raw WhatsApp Cloud webhook delivery into a channel-neutral
 * {@link BridgeMessage}, selecting ONE message ({@link WhatsAppParseContext.messageIndex},
 * default 0) from the delivery's flattened `messages[]`.
 *
 * Pure + hermetic + fail-closed. The `rawSha256`/`rawByteLength` provenance anchor is
 * computed over the EXACT input bytes (so it matches the byte-exact `.json` anchor
 * `importInbound` stores). Only a `type: "text"` message is importable — a non-text
 * (interactive / media / location / reaction / template) message carries no
 * plain-text body and is REFUSED (skipped). The only throw is
 * {@link WhatsAppParseError} for a refused input; everything survivable degrades with
 * a `warnings` entry.
 *
 * @throws {WhatsAppParseError} on an over-cap input, non-JSON / non-object body, a
 *   delivery with no importable `messages`, an out-of-range `messageIndex`, a
 *   non-text message type, a missing/invalid `id` (wamid), or a missing plain-text
 *   `text.body`.
 */
export function waMessageToBridgeMessage(raw, ctx = {}) {
    const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    if (buf.length > MAX_EVENT_BYTES) {
        throw new WhatsAppParseError(`whatsapp webhook exceeds the ${MAX_EVENT_BYTES}-byte hard cap (${buf.length} bytes).`);
    }
    const rawSha256 = createHash("sha256").update(buf).digest("hex");
    let parsed;
    try {
        parsed = JSON.parse(buf.toString("utf8"));
    }
    catch {
        throw new WhatsAppParseError("whatsapp webhook is not valid JSON.");
    }
    const envelope = asRecord(parsed);
    if (envelope === undefined) {
        throw new WhatsAppParseError("whatsapp webhook is not a JSON object.");
    }
    const warnings = [];
    const { messages, contacts } = resolveMessages(envelope);
    if (messages.length === 0) {
        throw new WhatsAppParseError("whatsapp webhook carries no importable messages.");
    }
    // Select the requested message (fan-out seam). A non-integer / negative index → 0.
    const rawIndex = ctx.messageIndex;
    const index = typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : 0;
    if (index >= messages.length) {
        throw new WhatsAppParseError(`whatsapp messageIndex ${index} is out of range (${messages.length} message(s)).`);
    }
    if (messages.length > 1) {
        warnings.push(`whatsapp delivery carries ${messages.length} messages; parsed index ${index} ` +
            "(fan out the rest at the service layer).");
    }
    // `messages[index]` is non-undefined here (index < messages.length, checked above),
    // but noUncheckedIndexedAccess still widens it — narrow explicitly, fail-closed.
    const inner = messages[index];
    if (inner === undefined) {
        throw new WhatsAppParseError("whatsapp selected message is missing.");
    }
    // Only a `type: "text"` message carries an importable plain-text body. Interactive /
    // media / location / reaction / template messages are REFUSED (skipped) — never
    // flattened into markup (M2.2 is text-only; media metadata is a later phase).
    const type = asString(inner.type);
    if (type !== "text") {
        throw new WhatsAppParseError(`unsupported whatsapp message type: ${type ?? "<none>"}.`);
    }
    // `id` (wamid) is the channel-stable id — required + shape-validated (idempotent
    // storage needs a stable id; Meta retries over ~36h).
    const wamid = asString(inner.id);
    if (wamid === undefined || !WAMID.test(wamid)) {
        throw new WhatsAppParseError("whatsapp message is missing a valid `id` (wamid).");
    }
    // `text.body`: PLAIN TEXT ONLY (control-stripped, capped). NEVER interactive /
    // template / media as markup (the stored-XSS rule).
    const textObj = asRecord(inner.text);
    const bodyField = textObj !== undefined ? textObj.body : undefined;
    if (typeof bodyField !== "string") {
        throw new WhatsAppParseError("whatsapp text message has no plain-text `text.body`.");
    }
    let textBody = sanitizeText(bodyField);
    if (textBody.length > MAX_TEXT_CHARS) {
        textBody = textBody.slice(0, MAX_TEXT_CHARS);
        warnings.push("whatsapp text truncated at the length cap.");
    }
    // Sender `from`/`wa_id` — the customer's phone number. Shape-validated before it
    // mints anything; an out-of-shape handle yields NO sender → `personIriFor` falls
    // back to a provisional anon node (M2.0). The display name comes from the sibling
    // `contacts[]` (`profile.name`, attacker-controlled → control-stripped, capped).
    const from = asString(inner.from);
    let sender;
    if (from !== undefined && WA_ID.test(from)) {
        const displayName = contactName(contacts, from);
        sender = {
            handle: from,
            ...(displayName !== undefined ? { displayName } : {}),
        };
    }
    else {
        warnings.push("whatsapp sender from/wa_id missing or out-of-shape; sender left provisional.");
    }
    // Thread linkage — a reply carries `context.id` = the wamid of the replied-to
    // message. Shape-validated; an out-of-shape / self-referential value is dropped.
    const context = asRecord(inner.context);
    const contextId = context !== undefined ? asString(context.id) : undefined;
    const threadId = contextId !== undefined && WAMID.test(contextId) && contextId !== wamid ? contextId : undefined;
    // `timestamp` — Unix epoch SECONDS; best-effort, degrades to no date on a bad value.
    const timestamp = asString(inner.timestamp);
    const date = timestamp !== undefined && WA_TIMESTAMP.test(timestamp) ? timestampToIso(timestamp) : undefined;
    if (timestamp !== undefined && date === undefined) {
        warnings.push("whatsapp timestamp missing/unparseable; date omitted.");
    }
    return {
        channel: WHATSAPP_CHANNEL,
        ...(sender !== undefined ? { sender } : {}),
        textBody,
        ...(threadId !== undefined ? { threadId } : {}),
        ...(date !== undefined ? { date } : {}),
        messageId: wamid,
        // WhatsApp has no inline metadata/capability carrier — signals are ALWAYS empty
        // (null-prototype), so a hostile payload key can never touch the prototype chain.
        signals: Object.freeze(Object.create(null)),
        rawSha256,
        rawByteLength: buf.length,
        rawMediaType: WHATSAPP_RAW_MEDIA_TYPE,
        warnings,
    };
}
/**
 * The WhatsApp {@link ChannelAdapter}: `parse` is {@link waMessageToBridgeMessage}, so
 * a WhatsApp Business webhook plugs into the M2.0 `importInbound` pipeline with zero
 * pipeline changes (owner-private write of the byte-exact `.json` anchor + agentic
 * graph + canonical chat message, channel-scoped `urn:agentic:person:whatsapp:…` URN,
 * deterministic interpretations).
 *
 * Read-only in M2.2 — `sendReply` (the pod-copy-pointer reply, 24-hour service-window
 * refusal) is the M2.4 live-transport phase.
 */
export class WhatsAppChannelAdapter {
    channel = WHATSAPP_CHANNEL;
    messages;
    pullFn;
    messageIndex;
    constructor(options = {}) {
        this.messages = options.messages ?? [];
        this.pullFn = options.pull;
        this.messageIndex = options.messageIndex;
    }
    parse(item) {
        return waMessageToBridgeMessage(item.raw, this.messageIndex !== undefined ? { messageIndex: this.messageIndex } : {});
    }
    pullInbound() {
        return this.pullFn !== undefined ? this.pullFn() : Promise.resolve(this.messages);
    }
}
//# sourceMappingURL=whatsapp.js.map