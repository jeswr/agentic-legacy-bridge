// AUTHORED-BY Claude Fable 5
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFetchWebhookHandler } from "./fetch-adapter.js";

const CONTAINER = "https://alice.example/inbox/";
const SLACK_SECRET = "slack-signing-secret";
const VERIFY_TOKEN = "verify-tok";
const NOW_SEC = 1_700_000_000;

function okFetch(): typeof fetch {
  return (async () => new Response(null, { status: 201 })) as typeof fetch;
}

function slackSig(body: string, ts = String(NOW_SEC)): Record<string, string> {
  const mac = createHmac("sha256", SLACK_SECRET);
  mac.update(`v0:${ts}:${body}`);
  return { "x-slack-signature": `v0=${mac.digest("hex")}`, "x-slack-request-timestamp": ts };
}

describe("createFetchWebhookHandler — WinterCG Request/Response", () => {
  it("verifies a signed Slack Request over its exact raw bytes and returns 200", async () => {
    const handler = createFetchWebhookHandler({
      channel: { channel: "slack", signingSecret: SLACK_SECRET },
      container: CONTAINER,
      writeFetch: okFetch(),
      now: () => NOW_SEC * 1000,
    });
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T12345",
      event: {
        type: "message",
        channel: "C99999",
        user: "U54321",
        ts: "1700000000.000100",
        text: "hi",
      },
    });
    const res = await handler(
      new Request("https://svc.example/webhook/slack", {
        method: "POST",
        headers: { ...slackSig(body), "content-type": "application/json" },
        body,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a tampered Slack Request (401)", async () => {
    const handler = createFetchWebhookHandler({
      channel: { channel: "slack", signingSecret: SLACK_SECRET },
      container: CONTAINER,
      writeFetch: okFetch(),
      now: () => NOW_SEC * 1000,
    });
    const signedBody = "{}";
    const res = await handler(
      new Request("https://svc.example/webhook/slack", {
        method: "POST",
        headers: slackSig(signedBody),
        body: `${signedBody} tampered`,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an over-cap Content-Length with 413 WITHOUT reading the body", async () => {
    let fetched = false;
    const handler = createFetchWebhookHandler({
      channel: { channel: "slack", signingSecret: SLACK_SECRET },
      container: CONTAINER,
      writeFetch: (async () => {
        fetched = true;
        return new Response(null, { status: 201 });
      }) as typeof fetch,
      maxBodyBytes: 100,
      now: () => NOW_SEC * 1000,
    });
    const res = await handler(
      new Request("https://svc.example/webhook/slack", {
        method: "POST",
        headers: { ...slackSig("x".repeat(500)), "content-length": "500" },
        body: "x".repeat(500),
      }),
    );
    expect(res.status).toBe(413);
    expect(fetched).toBe(false);
  });

  it("aborts a streamed body that exceeds the cap (413)", async () => {
    const handler = createFetchWebhookHandler({
      channel: { channel: "slack", signingSecret: SLACK_SECRET },
      container: CONTAINER,
      writeFetch: okFetch(),
      maxBodyBytes: 100,
      now: () => NOW_SEC * 1000,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(500));
        controller.close();
      },
    });
    const res = await handler(
      // A streamed body has no Content-Length → the bounded read must abort at the cap.
      // `duplex` is required by Node's fetch for a stream body (not yet in the DOM types).
      new Request("https://svc.example/webhook/slack", {
        method: "POST",
        headers: slackSig(""),
        body: stream,
        duplex: "half",
      } as unknown as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  it("echoes the Meta GET registration challenge from the query string", async () => {
    const handler = createFetchWebhookHandler({
      channel: { channel: "whatsapp", appSecret: "s", verifyToken: VERIFY_TOKEN },
      container: CONTAINER,
      writeFetch: okFetch(),
    });
    const url = `https://svc.example/webhook/wa?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`;
    const res = await handler(new Request(url, { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });
});
