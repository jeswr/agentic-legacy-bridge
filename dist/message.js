// AUTHORED-BY Claude Fable 5
/**
 * `BridgeMessage` — the CHANNEL-NEUTRAL parsed inbound message (M2-DESIGN.md
 * §M2.0): what {@link EmailMessage} already is, minus the email-isms. This is the
 * one shape the whole pipeline (interpret → graph → canonical → persist) runs on,
 * so adding a channel means writing ONE pure `parse` transform — never a copy of
 * the pipeline.
 *
 * Every field is UNTRUSTED (the channel remote is hostile end-to-end); a
 * `BridgeMessage` is the output of a HARDENED channel parse (control-stripped
 * text, plain-text-only body — the stored-XSS rule — and best-effort envelope
 * fields that downstream code re-validates before minting any IRI from them).
 *
 * Email maps 1:1 via {@link toBridgeMessage}; `EmailMessage` stays exported and
 * the `./email` subexport is untouched. The widened pipeline entry points accept
 * `BridgeMessage | EmailMessage` (via {@link asBridgeMessage}) so every M1 call
 * site keeps working unchanged.
 */
/**
 * Map a parsed {@link EmailMessage} 1:1 onto the channel-neutral shape —
 * email is the FIRST channel. `sender` comes from `From:`, `signals` from the
 * header map (names are already lower-cased by the parser; the FIRST occurrence
 * of a duplicated header wins, so an appended duplicate can never override the
 * original), `threadId` from `In-Reply-To`, `rawMediaType` is `message/rfc822`.
 */
export function toBridgeMessage(email) {
    // Null-prototype target: a hostile `__proto__:`/`constructor:` header name
    // must become an ordinary own property, never touch the prototype chain.
    const signals = Object.create(null);
    for (const [name, value] of email.headers) {
        if (signals[name] === undefined)
            signals[name] = value;
    }
    return {
        channel: "email",
        ...(email.from !== undefined
            ? {
                sender: {
                    handle: email.from.address,
                    ...(email.from.displayName !== undefined
                        ? { displayName: email.from.displayName }
                        : {}),
                },
            }
            : {}),
        textBody: email.textBody,
        ...(email.subject !== undefined ? { subject: email.subject } : {}),
        ...(email.date !== undefined ? { date: email.date } : {}),
        ...(email.messageId !== undefined ? { messageId: email.messageId } : {}),
        ...(email.inReplyTo !== undefined ? { threadId: email.inReplyTo } : {}),
        ...(email.dkimDomain !== undefined ? { dkimDomainClaim: email.dkimDomain } : {}),
        ...(email.jsonLdBlocks !== undefined ? { jsonLdBlocks: email.jsonLdBlocks } : {}),
        ...(email.calendarParts !== undefined ? { calendarParts: email.calendarParts } : {}),
        signals: Object.freeze(signals),
        rawSha256: email.rawSha256,
        rawByteLength: email.rawByteLength,
        rawMediaType: "message/rfc822",
        warnings: email.warnings,
    };
}
/**
 * Discriminate the widened pipeline union. A {@link BridgeMessage} carries the
 * required `channel` + `rawMediaType` strings; an {@link EmailMessage} carries
 * neither.
 */
export function isBridgeMessage(message) {
    const m = message;
    return typeof m.channel === "string" && typeof m.rawMediaType === "string";
}
/**
 * Normalise a widened pipeline input to the channel-neutral shape: a
 * {@link BridgeMessage} passes through unchanged; an {@link EmailMessage} is
 * mapped via {@link toBridgeMessage} (so every M1 `EmailMessage` call site
 * behaves identically through the new seam).
 */
export function asBridgeMessage(message) {
    return isBridgeMessage(message) ? message : toBridgeMessage(message);
}
//# sourceMappingURL=message.js.map