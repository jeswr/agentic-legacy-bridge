/**
 * RESPOND-AND-RECOMMEND-UPGRADE — the legacy-channel delivery policy.
 *
 * A bridge that can answer on the current channel should provide value first: a
 * plain-text answer where one is available, the normal structured reply carrier,
 * and one unobtrusive link recommending full agentic (A2A) mode. Delivery is a
 * separate capability boundary: the default is `approval-required`, so parsing an
 * untrusted inbound message can never itself cause an outbound side effect.
 */

import type { ChannelAdapter, ReplyTarget } from "./channel.js";
import { type BuildReplyOptions, type BuiltReply, buildReply } from "./reply.js";
import { safeHttpIri, sanitizeText } from "./safe-iri.js";

/** The explicit outbound side-effect policy. */
export type ReplyDeliveryMode = "approval-required" | "auto-send";

/** A fully assembled reply ready for approval or delivery. */
export interface RecommendedReplyDraft {
  readonly channel: string;
  readonly target: ReplyTarget;
  readonly reply: BuiltReply;
  /** True when the caller supplied a non-empty answer; false uses the honest fallback. */
  readonly answered: boolean;
}

/** The injected human/policy approval seam. */
export type ReplyApprover = (draft: RecommendedReplyDraft) => boolean | Promise<boolean>;

/** Options for {@link respondAndRecommendUpgrade}. */
export interface RespondAndRecommendUpgradeOptions {
  /** The current legacy channel. A read-only adapter yields `channel-read-only`. */
  readonly adapter: ChannelAdapter;
  /** The legacy-channel recipient/conversation and reply target. */
  readonly target: ReplyTarget;
  /**
   * The agent's answer, if it has one. This function never fabricates an answer:
   * missing/blank content becomes an honest review-needed acknowledgement.
   */
  readonly answer?: string;
  /**
   * HTTPS link for continuing in full agentic (A2A) mode. It is also embedded as
   * the structured reply's onboarding link. Credentials-in-URL are refused.
   */
  readonly upgradeUrl: string;
  /** Structured-carrier options; this policy owns `humanText`/`onboardingUrl`. */
  readonly reply: Omit<BuildReplyOptions, "humanText" | "onboardingUrl">;
  /** Default `approval-required`; `auto-send` must be selected explicitly. */
  readonly deliveryMode?: ReplyDeliveryMode;
  /** Approval hook. Omitted in approval mode → return a pending draft, do not send. */
  readonly approve?: ReplyApprover;
}

/** The result makes every no-send case explicit and still exposes its draft. */
export type RespondAndRecommendUpgradeResult =
  | { readonly status: "channel-read-only" }
  | { readonly status: "pending-approval"; readonly draft: RecommendedReplyDraft }
  | { readonly status: "declined"; readonly draft: RecommendedReplyDraft }
  | { readonly status: "sent"; readonly draft: RecommendedReplyDraft };

const MAX_UPGRADE_URL_CHARS = 2048;
const NO_RELIABLE_ANSWER =
  "I received your message, but I do not yet have a reliable answer. A person needs to review it.";

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
export async function respondAndRecommendUpgrade(
  options: RespondAndRecommendUpgradeOptions,
): Promise<RespondAndRecommendUpgradeResult> {
  const sendReply = options.adapter.sendReply;
  if (typeof sendReply !== "function") return { status: "channel-read-only" };

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
  const draft: RecommendedReplyDraft = {
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
    if (options.approve === undefined) return { status: "pending-approval", draft };
    if (!(await options.approve(draft))) return { status: "declined", draft };
  }

  // Preserve `this` for class-based adapters.
  await sendReply.call(options.adapter, options.target, reply);
  return { status: "sent", draft };
}

function cleanAnswer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeText(value).trim();
  return clean === "" ? undefined : clean;
}

function safeUpgradeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_UPGRADE_URL_CHARS) return undefined;
  const safe = safeHttpIri(value);
  if (safe === undefined) return undefined;
  const url = new URL(safe);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return safe;
}
