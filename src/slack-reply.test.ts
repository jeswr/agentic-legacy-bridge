import { describe, expect, it, vi } from "vitest";
import { type BuiltReply, buildReply } from "./reply.js";
import { respondAndRecommendUpgrade } from "./respond.js";
import {
  createSlackReplySender,
  SLACK_CHAT_POST_MESSAGE_ENDPOINT,
  SlackChannelAdapter,
} from "./slack.js";

// Fake test-only token, split across two literals so secret-scanning does not flag it.
const TOKEN = `xoxb-${"EXAMPLE0EXAMPLE0abcdefgh"}`;
const CHANNEL = "C123ABC456";
const TS = "1784383200.000100";

async function reply(): Promise<BuiltReply> {
  return buildReply({
    inReplyTo: "urn:agentic:raw:abc123",
    humanText: "Tuesday at 14:00 works.",
    onboardingUrl: "https://onboard.example/#/t/opaque",
    podCopyUrl: "https://pod.example/replies/1.ttl",
  });
}

describe("createSlackReplySender — chat.postMessage carrier", () => {
  it("sends accessible plain text + bounded pointer metadata in the original thread", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, channel: CHANNEL, ts: "1784383300.1" }));
    }) as typeof fetch;
    const send = createSlackReplySender({ botToken: TOKEN, fetch: fetchImpl });
    await send({ to: CHANNEL, inReplyToId: `${CHANNEL}:${TS}` }, await reply());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SLACK_CHAT_POST_MESSAGE_ENDPOINT);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.channel).toBe(CHANNEL);
    expect(body.thread_ts).toBe(TS);
    expect(body.mrkdwn).toBe(false);
    expect(body.unfurl_links).toBe(false);
    expect(body.unfurl_media).toBe(false);
    expect(body.text).toContain("Tuesday at 14:00 works.");
    expect(body.text).toContain("full agentic (A2A) mode");
    expect(body.metadata).toEqual({
      event_type: "agentic_reply",
      event_payload: {
        channels: "rdf,dpop-sk,a2a",
        reply: "https://pod.example/replies/1.ttl",
      },
    });
    expect(String(calls[0]?.init?.body)).not.toContain(TOKEN);
  });

  it("installs sendReply only when Slack reply credentials are configured", () => {
    expect(new SlackChannelAdapter().sendReply).toBeUndefined();
    const configured = new SlackChannelAdapter({
      reply: {
        botToken: TOKEN,
        fetch: (async () => new Response('{"ok":true}')) as typeof fetch,
      },
    });
    expect(configured.sendReply).toBeTypeOf("function");
  });

  it("integrates with approval-gated respond-and-recommend without live credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}'));
    const adapter = new SlackChannelAdapter({
      reply: { botToken: TOKEN, fetch: fetchImpl as unknown as typeof fetch },
    });
    const pending = await respondAndRecommendUpgrade({
      adapter,
      target: { to: CHANNEL, inReplyToId: `${CHANNEL}:${TS}` },
      answer: "The answer.",
      upgradeUrl: "https://onboard.example/#/t/opaque",
      reply: { inReplyTo: "urn:agentic:raw:abc123" },
    });
    expect(pending.status).toBe("pending-approval");
    expect(fetchImpl).not.toHaveBeenCalled();

    const sent = await respondAndRecommendUpgrade({
      adapter,
      target: { to: CHANNEL, inReplyToId: `${CHANNEL}:${TS}` },
      answer: "The answer.",
      upgradeUrl: "https://onboard.example/#/t/opaque",
      reply: { inReplyTo: "urn:agentic:raw:abc123" },
      approve: () => true,
    });
    expect(sent.status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createSlackReplySender — fail-closed config and untrusted arguments", () => {
  it.each([
    "",
    "xoxp-user-token-not-bot",
    "xoxb-short",
    `xoxb-${"1234567890"}\r\nX-Evil:true`,
  ])("rejects a non-bot/header-unsafe token: %s", (botToken) => {
    expect(() => createSlackReplySender({ botToken })).toThrow(/botToken/);
  });

  it.each([
    "http://slack.com/api/chat.postMessage",
    "https://evil.example/api/chat.postMessage",
    "https://slack.com/api/chat.postMessage?token=leak",
    "https://slack.com/api/chat.delete",
    "https://user:secret@slack.com/api/chat.postMessage",
  ])("refuses a token-exfiltrating endpoint before fetch: %s", (apiEndpoint) => {
    const fetchImpl = vi.fn();
    expect(() =>
      createSlackReplySender({
        botToken: TOKEN,
        apiEndpoint,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).toThrow(/apiEndpoint/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses invalid channel/thread identifiers before fetch", async () => {
    const fetchImpl = vi.fn();
    const send = createSlackReplySender({
      botToken: TOKEN,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const built = await reply();
    await expect(send({ to: "U-not-a-conversation" }, built)).rejects.toThrow(/target/);
    await expect(send({ to: CHANNEL, inReplyToId: `COTHER123:${TS}` }, built)).rejects.toThrow(
      /inReplyToId/,
    );
    await expect(send({ to: CHANNEL, inReplyToId: "not-a-ts" }, built)).rejects.toThrow(
      /inReplyToId/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a bounded plain-text human body", async () => {
    const fetchImpl = vi.fn();
    const send = createSlackReplySender({
      botToken: TOKEN,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const base = await reply();
    await expect(send({ to: CHANNEL }, { ...base, humanText: undefined })).rejects.toThrow(
      /humanText/,
    );
    await expect(send({ to: CHANNEL }, { ...base, humanText: "x".repeat(40_001) })).rejects.toThrow(
      /40000/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses redirects, non-2xx, invalid JSON, Slack ok:false, and response bombs", async () => {
    const responses = [
      new Response(null, { status: 302 }),
      new Response(null, { status: 503 }),
      new Response("not json"),
      new Response('{"ok":false,"error":"invalid_auth"}'),
      new Response("x".repeat(2000)),
    ];
    const expected = [/redirect/, /HTTP 503/, /invalid JSON/, /rejected/, /size cap/];
    for (let i = 0; i < responses.length; i++) {
      const fetchImpl = (async () => responses[i] as Response) as typeof fetch;
      const send = createSlackReplySender({
        botToken: TOKEN,
        fetch: fetchImpl,
        maxResponseBytes: 100,
      });
      await expect(send({ to: CHANNEL }, await reply())).rejects.toThrow(expected[i]);
    }
  });

  it("never includes the bot token in transport error text", async () => {
    const send = createSlackReplySender({
      botToken: TOKEN,
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    let message = "";
    try {
      await send({ to: CHANNEL }, await reply());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("request failed");
  });
});
