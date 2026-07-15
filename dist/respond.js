/**
 * RESPOND-AND-RECOMMEND-UPGRADE — the legacy-channel delivery policy.
 *
 * A bridge that can answer on the current channel should provide value first: a
 * plain-text answer where one is available, the normal structured reply carrier,
 * and one unobtrusive link recommending full agentic (A2A) mode. Delivery is a
 * separate capability boundary: the default is `approval-required`, so parsing an
 * untrusted inbound message can never itself cause an outbound side effect.
 */
import { buildReply } from "./reply.js";
import { safeHttpIri, sanitizeText } from "./safe-iri.js";
const MAX_UPGRADE_URL_CHARS = 2048;
const NO_RELIABLE_ANSWER = "I received your message, but I do not yet have a reliable answer. A person needs to review it.";
/**
 * Build an answer + structured carrier + A2A recommendation and, when policy
 * permits, deliver it through the adapter's existing `sendReply` seam.
 *
 * Security properties:
 * - default no-side-effect (`approval-required` with no approver → pending);
 * - no answer is invented; the fallback says review is required;
 * - upgrade links are short, HTTPS-only, and carry no URL credentials;
 * - answer controls/size are bounded again in `buildReply`;
 * - a sender error propagates, so callers cannot mistake a failed send for success.
 */
export async function respondAndRecommendUpgrade(options) {
    const sendReply = options.adapter.sendReply;
    if (typeof sendReply !== "function")
        return { status: "channel-read-only" };
    const upgradeUrl = safeUpgradeUrl(options.upgradeUrl);
    if (upgradeUrl === undefined) {
        throw new Error("respond-and-recommend: upgradeUrl must be a credential-free HTTPS URL.");
    }
    const answer = cleanAnswer(options.answer);
    const reply = await buildReply({
        ...options.reply,
        humanText: answer ?? NO_RELIABLE_ANSWER,
        onboardingUrl: upgradeUrl,
    });
    const draft = {
        channel: options.adapter.channel,
        target: options.target,
        reply,
        answered: answer !== undefined,
    };
    const mode = options.deliveryMode ?? "approval-required";
    if (mode !== "approval-required" && mode !== "auto-send") {
        throw new Error("respond-and-recommend: deliveryMode is not recognised.");
    }
    if (mode === "approval-required") {
        if (options.approve === undefined)
            return { status: "pending-approval", draft };
        if (!(await options.approve(draft)))
            return { status: "declined", draft };
    }
    // Preserve `this` for class-based adapters.
    await sendReply.call(options.adapter, options.target, reply);
    return { status: "sent", draft };
}
function cleanAnswer(value) {
    if (value === undefined)
        return undefined;
    const clean = sanitizeText(value).trim();
    return clean === "" ? undefined : clean;
}
function safeUpgradeUrl(value) {
    if (typeof value !== "string" || value.length > MAX_UPGRADE_URL_CHARS)
        return undefined;
    const safe = safeHttpIri(value);
    if (safe === undefined)
        return undefined;
    const url = new URL(safe);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
        return undefined;
    return safe;
}
//# sourceMappingURL=respond.js.map