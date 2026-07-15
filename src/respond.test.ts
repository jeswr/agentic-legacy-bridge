import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, InboundRawMessage, ReplyTarget } from "./channel.js";
import type { BridgeMessage } from "./message.js";
import type { BuiltReply } from "./reply.js";
import { respondAndRecommendUpgrade } from "./respond.js";

const TARGET: ReplyTarget = { to: "C123ABC456", inReplyToId: "C123ABC456:1784383200.000100" };
const REPLY = {
  inReplyTo: "urn:agentic:raw:abc123",
  podCopyUrl: "https://pod.example/replies/1.ttl",
  issuer: "https://agent.example/#me",
};
const UPGRADE = "https://onboard.example/#/t/opaque-token";

class SendingAdapter implements ChannelAdapter {
  readonly channel = "slack";
  readonly sent: Array<{ target: ReplyTarget; reply: BuiltReply }> = [];

  pullInbound(): Promise<readonly InboundRawMessage[]> {
    return Promise.resolve([]);
  }

  parse(): BridgeMessage {
    throw new Error("unused");
  }

  sendReply(target: ReplyTarget, reply: BuiltReply): Promise<void> {
    this.sent.push({ target, reply });
    return Promise.resolve();
  }
}

class ReadOnlyAdapter implements ChannelAdapter {
  readonly channel = "slack";
  pullInbound(): Promise<readonly InboundRawMessage[]> {
    return Promise.resolve([]);
  }
  parse(): BridgeMessage {
    throw new Error("unused");
  }
}

describe("respondAndRecommendUpgrade — approval is the default", () => {
  it("returns a complete pending draft and does NOT send without an approver", async () => {
    const adapter = new SendingAdapter();
    const result = await respondAndRecommendUpgrade({
      adapter,
      target: TARGET,
      answer: "Tuesday at 14:00 works for me.",
      upgradeUrl: UPGRADE,
      reply: REPLY,
    });
    expect(result.status).toBe("pending-approval");
    expect(adapter.sent).toHaveLength(0);
    if (result.status !== "pending-approval") throw new Error("unexpected result");
    expect(result.draft.answered).toBe(true);
    expect(result.draft.reply.humanText).toContain("Tuesday at 14:00 works for me.");
    expect(result.draft.reply.humanText).toContain("full agentic (A2A) mode");
    expect(result.draft.reply.humanText).toContain(UPGRADE);
  });

  it("sends only after the injected approver accepts", async () => {
    const adapter = new SendingAdapter();
    const approve = vi.fn(() => true);
    const result = await respondAndRecommendUpgrade({
      adapter,
      target: TARGET,
      answer: "Yes.",
      upgradeUrl: UPGRADE,
      reply: REPLY,
      approve,
    });
    expect(result.status).toBe("sent");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.target).toEqual(TARGET);
  });

  it("returns declined and does not send when approval is refused", async () => {
    const adapter = new SendingAdapter();
    const result = await respondAndRecommendUpgrade({
      adapter,
      target: TARGET,
      answer: "No.",
      upgradeUrl: UPGRADE,
      reply: REPLY,
      approve: () => false,
    });
    expect(result.status).toBe("declined");
    expect(adapter.sent).toHaveLength(0);
  });

  it("supports explicit auto-send as an opt-in policy", async () => {
    const adapter = new SendingAdapter();
    const result = await respondAndRecommendUpgrade({
      adapter,
      target: TARGET,
      answer: "Confirmed.",
      upgradeUrl: UPGRADE,
      reply: REPLY,
      deliveryMode: "auto-send",
    });
    expect(result.status).toBe("sent");
    expect(adapter.sent).toHaveLength(1);
  });

  it("refuses an unknown runtime delivery mode instead of accidentally auto-sending", async () => {
    const adapter = new SendingAdapter();
    await expect(
      respondAndRecommendUpgrade({
        adapter,
        target: TARGET,
        answer: "Confirmed.",
        upgradeUrl: UPGRADE,
        reply: REPLY,
        deliveryMode: "send-whatever" as "auto-send",
      }),
    ).rejects.toThrow(/deliveryMode/);
    expect(adapter.sent).toHaveLength(0);
  });
});

describe("respondAndRecommendUpgrade — honest fail-closed edges", () => {
  it("returns channel-read-only without invoking signer or approval", async () => {
    const sign = vi.fn();
    const approve = vi.fn();
    const result = await respondAndRecommendUpgrade({
      adapter: new ReadOnlyAdapter(),
      target: TARGET,
      answer: "answer",
      upgradeUrl: UPGRADE,
      reply: { ...REPLY, sign },
      approve,
    });
    expect(result).toEqual({ status: "channel-read-only" });
    expect(sign).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it("never fabricates an answer when none is available", async () => {
    const adapter = new SendingAdapter();
    const result = await respondAndRecommendUpgrade({
      adapter,
      target: TARGET,
      answer: " \u0000\u001b ",
      upgradeUrl: UPGRADE,
      reply: REPLY,
    });
    if (result.status !== "pending-approval") throw new Error("unexpected result");
    expect(result.draft.answered).toBe(false);
    expect(result.draft.reply.humanText).toContain("do not yet have a reliable answer");
    expect(result.draft.reply.humanText).toContain(UPGRADE);
  });

  it.each([
    "http://onboard.example/t/x",
    "javascript:alert(1)",
    "https://user:secret@onboard.example/t/x",
    `https://onboard.example/${"x".repeat(3000)}`,
  ])("refuses an unsafe upgrade URL before approval or send: %s", async (upgradeUrl) => {
    const adapter = new SendingAdapter();
    const approve = vi.fn();
    await expect(
      respondAndRecommendUpgrade({
        adapter,
        target: TARGET,
        answer: "answer",
        upgradeUrl,
        reply: REPLY,
        approve,
      }),
    ).rejects.toThrow(/upgradeUrl/);
    expect(approve).not.toHaveBeenCalled();
    expect(adapter.sent).toHaveLength(0);
  });

  it("propagates sender failure instead of reporting a false success", async () => {
    const adapter = new SendingAdapter();
    adapter.sendReply = async () => {
      throw new Error("transport unavailable");
    };
    await expect(
      respondAndRecommendUpgrade({
        adapter,
        target: TARGET,
        answer: "answer",
        upgradeUrl: UPGRADE,
        reply: REPLY,
        deliveryMode: "auto-send",
      }),
    ).rejects.toThrow("transport unavailable");
  });
});
