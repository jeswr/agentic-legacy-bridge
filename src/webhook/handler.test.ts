// AUTHORED-BY Claude Fable 5
import { createHmac } from "node:crypto";
import { Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { createWebhookHandler, type WebhookAuditEvent } from "./handler.js";
import type { WebhookRequest } from "./request.js";

const CONTAINER = "https://alice.example/inbox/";
const SLACK_SECRET = "slack-signing-secret";
const META_SECRET = "meta-app-secret";
const VERIFY_TOKEN = "verify-tok";
const NOW_SEC = 1_700_000_000;
const NOW_MS = NOW_SEC * 1000;
const now = () => NOW_MS;
const enc = (s: string) => new TextEncoder().encode(s);

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function recordingFetch(existing: Set<string> = new Set()) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, headers });
    if (method === "PUT" && headers["if-none-match"] === "*" && existing.has(url)) {
      return new Response(null, { status: 412 });
    }
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function slackSig(body: string, ts = String(NOW_SEC)): Record<string, string> {
  const mac = createHmac("sha256", SLACK_SECRET);
  mac.update(`v0:${ts}:${body}`);
  return { "x-slack-signature": `v0=${mac.digest("hex")}`, "x-slack-request-timestamp": ts };
}

function metaSig(body: string): Record<string, string> {
  const mac = createHmac("sha256", META_SECRET);
  mac.update(body);
  return { "x-hub-signature-256": `sha256=${mac.digest("hex")}` };
}

function slackBody(text: string, ts = "1700000000.000100"): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T12345",
    event: { type: "message", channel: "C99999", user: "U54321", ts, text },
  });
}

function req(partial: Partial<WebhookRequest> & { rawBody: Uint8Array }): WebhookRequest {
  return { method: "POST", headers: {}, ...partial };
}

describe("createWebhookHandler — construction is fail-closed", () => {
  it("throws on a bad container", () => {
    expect(() =>
      createWebhookHandler({
        channel: { channel: "slack", signingSecret: SLACK_SECRET },
        container: "not a url",
        writeFetch: recordingFetch().fetchImpl,
      }),
    ).toThrow(/container/);
  });

  it("throws on an empty Slack signing secret", () => {
    expect(() =>
      createWebhookHandler({
        channel: { channel: "slack", signingSecret: "" },
        container: CONTAINER,
        writeFetch: recordingFetch().fetchImpl,
      }),
    ).toThrow(/signingSecret/);
  });

  it("throws on an empty WhatsApp verify token", () => {
    expect(() =>
      createWebhookHandler({
        channel: { channel: "whatsapp", appSecret: META_SECRET, verifyToken: "" },
        container: CONTAINER,
        writeFetch: recordingFetch().fetchImpl,
      }),
    ).toThrow(/verifyToken/);
  });
});

describe("Slack webhook handler — end to end", () => {
  function slackHandler(fetchImpl: typeof fetch, events?: WebhookAuditEvent[]) {
    return createWebhookHandler({
      channel: { channel: "slack", signingSecret: SLACK_SECRET },
      container: CONTAINER,
      writeFetch: fetchImpl,
      now,
      ...(events !== undefined ? { onEvent: (e) => events.push(e) } : {}),
    });
  }

  it("verifies + imports a valid message (200, three pod writes within the container)", async () => {
    const body = slackBody("please meet 2026-09-01T09:00:00Z");
    const { fetchImpl, calls } = recordingFetch();
    const res = await slackHandler(fetchImpl)(req({ headers: slackSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(3);
    for (const p of puts) expect(p.url.startsWith(CONTAINER)).toBe(true);
  });

  it("rejects a bad signature (401) and writes NOTHING", async () => {
    const body = slackBody("hi");
    const { fetchImpl, calls } = recordingFetch();
    const res = await slackHandler(fetchImpl)(
      req({
        headers: { ...slackSig(body), "x-slack-signature": "v0=deadbeef" },
        rawBody: enc(body),
      }),
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects an oversize body (413) BEFORE any write", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const { fetchImpl, calls } = recordingFetch();
    const res = await slackHandler(fetchImpl)(req({ headers: slackSig(big), rawBody: enc(big) }));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("answers the url_verification handshake with the challenge (signed)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc-challenge-123" });
    const { fetchImpl, calls } = recordingFetch();
    const res = await slackHandler(fetchImpl)(req({ headers: slackSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    expect(res.body).toBe("abc-challenge-123");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("acks (200) + skips an unsupported event type without writing", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T12345",
      event: { type: "reaction_added", user: "U1" },
    });
    const events: WebhookAuditEvent[] = [];
    const { fetchImpl, calls } = recordingFetch();
    const res = await slackHandler(
      fetchImpl,
      events,
    )(req({ headers: slackSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(events.some((e) => e.kind === "skipped")).toBe(true);
  });

  it("is IDEMPOTENT: replaying the same signed delivery does not double-write", async () => {
    const body = slackBody("idempotent");
    const first = recordingFetch();
    await slackHandler(first.fetchImpl)(req({ headers: slackSig(body), rawBody: enc(body) }));
    const urls = new Set(first.calls.filter((c) => c.method === "PUT").map((c) => c.url));

    const events: WebhookAuditEvent[] = [];
    const second = recordingFetch(urls);
    const res = await slackHandler(
      second.fetchImpl,
      events,
    )(req({ headers: slackSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    // Same 3 URLs, each got a 412 → nothing overwritten.
    expect(new Set(second.calls.filter((c) => c.method === "PUT").map((c) => c.url))).toEqual(urls);
    expect(events.find((e) => e.kind === "written")).toMatchObject({ created: false });
  });

  it("returns 500 (never rejects) on a transient pod-write failure so the platform retries", async () => {
    const body = slackBody("write-fails");
    const failing = (async () => new Response(null, { status: 503 })) as typeof fetch;
    const events: WebhookAuditEvent[] = [];
    const res = await slackHandler(
      failing,
      events,
    )(req({ headers: slackSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(500);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("returns 500 (not a dropped 200) when a pod PUT answers 409 Conflict", async () => {
    const body = slackBody("conflict");
    const conflicting = (async () => new Response(null, { status: 409 })) as typeof fetch;
    const res = await slackHandler(conflicting)(
      req({ headers: slackSig(body), rawBody: enc(body) }),
    );
    expect(res.status).toBe(500);
  });

  it("rejects GET (405) — Slack has no GET registration", async () => {
    const { fetchImpl } = recordingFetch();
    const res = await slackHandler(fetchImpl)(req({ method: "GET", rawBody: new Uint8Array(0) }));
    expect(res.status).toBe(405);
  });

  it("makes NO outbound fetch to a webhook-supplied URL (SSRF)", async () => {
    // The body embeds an attacker URL; the handler must never fetch it.
    const body = slackBody("visit http://169.254.169.254/latest/meta-data/ now");
    const { fetchImpl, calls } = recordingFetch();
    await slackHandler(fetchImpl)(req({ headers: slackSig(body), rawBody: enc(body) }));
    // Every fetch the handler made is a pod write within the configured container.
    for (const c of calls) expect(c.url.startsWith(CONTAINER)).toBe(true);
  });

  it("contains an RDF-injection body end-to-end (no injected acl triple lands)", async () => {
    const hostile =
      "ok> ] . <https://alice.example/inbox/.acl#x> a <http://www.w3.org/ns/auth/acl#Authorization> ; " +
      "<http://www.w3.org/ns/auth/acl#agentClass> <http://xmlns.com/foaf/0.1/Agent> . #";
    const body = slackBody(hostile);
    const bodies: string[] = [];
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") bodies.push(String(init?.body));
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const handler = createWebhookHandler({
      channel: { channel: "slack", signingSecret: SLACK_SECRET },
      container: CONTAINER,
      writeFetch: fetchImpl,
      now,
    });
    await handler(req({ headers: slackSig(body), rawBody: enc(body) }));
    for (const b of bodies.filter((x) => x.includes("@prefix") || x.includes("a "))) {
      const store = new Store(new Parser().parse(b));
      expect(
        store.getQuads(null, "http://www.w3.org/ns/auth/acl#agentClass", null, null),
      ).toHaveLength(0);
    }
  });
});

describe("WhatsApp webhook handler — end to end", () => {
  function waHandler(fetchImpl: typeof fetch) {
    return createWebhookHandler({
      channel: { channel: "whatsapp", appSecret: META_SECRET, verifyToken: VERIFY_TOKEN },
      container: CONTAINER,
      writeFetch: fetchImpl,
      now,
    });
  }

  function waBody(messages: Array<{ id: string; from: string; text: string }>): string {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                contacts: messages.map((m) => ({ wa_id: m.from, profile: { name: "Cust" } })),
                messages: messages.map((m) => ({
                  from: m.from,
                  id: m.id,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: m.text },
                })),
              },
            },
          ],
        },
      ],
    });
  }

  it("answers the GET registration handshake with the challenge", async () => {
    const { fetchImpl } = recordingFetch();
    const res = await waHandler(fetchImpl)({
      method: "GET",
      headers: {},
      rawBody: new Uint8Array(0),
      query: { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "9988" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("9988");
  });

  it("refuses the GET handshake with a wrong verify token (403)", async () => {
    const { fetchImpl } = recordingFetch();
    const res = await waHandler(fetchImpl)({
      method: "GET",
      headers: {},
      rawBody: new Uint8Array(0),
      query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "9988" },
    });
    expect(res.status).toBe(403);
  });

  it("verifies + imports a single text message", async () => {
    const body = waBody([{ id: "wamid.AAA", from: "15551230000", text: "hello there" }]);
    const { fetchImpl, calls } = recordingFetch();
    const res = await waHandler(fetchImpl)(req({ headers: metaSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3);
  });

  it("FANS OUT a multi-message delivery (one resource set per wamid)", async () => {
    const body = waBody([
      { id: "wamid.AAA", from: "15551230000", text: "one" },
      { id: "wamid.BBB", from: "15551230001", text: "two" },
    ]);
    const { fetchImpl, calls } = recordingFetch();
    await waHandler(fetchImpl)(req({ headers: metaSig(body), rawBody: enc(body) }));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(6); // 2 messages × 3 resources
    // Distinct slugs per wamid (the `alb-<base64url>` prefix carries no dot).
    const slugs = new Set(puts.map((p) => p.url.slice(CONTAINER.length).split(".")[0]));
    expect(slugs.size).toBe(2);
  });

  it("acks (200) a status/receipt delivery carrying no messages, writing nothing", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        { changes: [{ field: "statuses", value: { statuses: [{ id: "x", status: "read" }] } }] },
      ],
    });
    const { fetchImpl, calls } = recordingFetch();
    const res = await waHandler(fetchImpl)(req({ headers: metaSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("rejects a bad signature (401) and writes nothing", async () => {
    const body = waBody([{ id: "wamid.AAA", from: "15551230000", text: "hi" }]);
    const { fetchImpl, calls } = recordingFetch();
    const res = await waHandler(fetchImpl)(
      req({ headers: { "x-hub-signature-256": "sha256=deadbeef" }, rawBody: enc(body) }),
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("skips a non-text message but imports its text sibling in the same delivery", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    from: "15551230000",
                    id: "wamid.IMG",
                    timestamp: "1700000000",
                    type: "image",
                    image: { id: "m1" },
                  },
                  {
                    from: "15551230000",
                    id: "wamid.TXT",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "caption" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const { fetchImpl, calls } = recordingFetch();
    await waHandler(fetchImpl)(req({ headers: metaSig(body), rawBody: enc(body) }));
    // Only the text message was written (3 resources); the image was skipped.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3);
  });

  it("refuses an over-cap delivery fail-closed (422), writes nothing, surfaces the event", async () => {
    // A verified, byte-bounded delivery whose message count exceeds the fan-out cap is
    // refused with a bounded 422 — never fanned out in an unbounded loop — and the
    // over-cap is SURFACED via a distinct audit counter (not silently dropped). Uses a
    // small caller-supplied cap so the amplification bound is exercised without 1001 msgs.
    const events: WebhookAuditEvent[] = [];
    const { fetchImpl, calls } = recordingFetch();
    const handler = createWebhookHandler({
      channel: { channel: "whatsapp", appSecret: META_SECRET, verifyToken: VERIFY_TOKEN },
      container: CONTAINER,
      writeFetch: fetchImpl,
      maxMessagesPerDelivery: 2,
      onEvent: (e) => events.push(e),
      now,
    });
    const body = waBody([
      { id: "wamid.AAA", from: "15551230000", text: "one" },
      { id: "wamid.BBB", from: "15551230001", text: "two" },
      { id: "wamid.CCC", from: "15551230002", text: "three" },
    ]);
    const res = await handler(req({ headers: metaSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0); // fail-closed BEFORE any fan-out / write
    expect(events).toContainEqual({ kind: "over-message-cap", channel: "whatsapp", count: 3 });
  });

  it("imports a delivery AT the cap (boundary is not off-by-one)", async () => {
    // total === cap must NOT be refused — only total > cap is over the fan-out bound.
    const { fetchImpl, calls } = recordingFetch();
    const handler = createWebhookHandler({
      channel: { channel: "whatsapp", appSecret: META_SECRET, verifyToken: VERIFY_TOKEN },
      container: CONTAINER,
      writeFetch: fetchImpl,
      maxMessagesPerDelivery: 2,
      now,
    });
    const body = waBody([
      { id: "wamid.AAA", from: "15551230000", text: "one" },
      { id: "wamid.BBB", from: "15551230001", text: "two" },
    ]);
    const res = await handler(req({ headers: metaSig(body), rawBody: enc(body) }));
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(6); // 2 messages × 3 resources
  });

  it("rejects construction with a non-positive-integer maxMessagesPerDelivery", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() =>
        createWebhookHandler({
          channel: { channel: "whatsapp", appSecret: META_SECRET, verifyToken: VERIFY_TOKEN },
          container: CONTAINER,
          writeFetch: recordingFetch().fetchImpl,
          maxMessagesPerDelivery: bad,
          now,
        }),
      ).toThrow(/maxMessagesPerDelivery must be a positive integer/);
    }
  });
});
