// AUTHORED-BY Claude Fable 5
import { Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { slackEventToBridgeMessage } from "../slack.js";
import { writeMessageCreateOnly } from "./write.js";

const CONTAINER = "https://alice.example/inbox/";

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A recording fake pod fetch. `existing` URLs answer 412 to a create-only PUT. */
function recordingFetch(
  opts: { existing?: ReadonlySet<string>; fail?: (url: string) => number } = {},
) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, headers, body: init?.body });
    if (method === "PUT" && headers["if-none-match"] === "*" && opts.existing?.has(url)) {
      return new Response(null, { status: 412 });
    }
    const failStatus = opts.fail?.(url);
    if (failStatus !== undefined && failStatus !== 0)
      return new Response(null, { status: failStatus });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A minimal valid Slack event with a caller-chosen body text. */
function slackEvent(text: string, ts = "1700000000.000100"): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T12345",
    event: { type: "message", channel: "C99999", user: "U54321", ts, text },
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("writeMessageCreateOnly — create-only + idempotency", () => {
  it("writes the three resources create-only (If-None-Match: *)", async () => {
    const raw = slackEvent("let us meet on 2026-08-01T10:00:00Z");
    const message = slackEventToBridgeMessage(enc(raw));
    const { fetchImpl, calls } = recordingFetch();

    const result = await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: fetchImpl,
    });

    expect(result.created).toBe(true);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(3);
    for (const p of puts) {
      expect(p.headers["if-none-match"]).toBe("*");
      expect(p.url.startsWith(CONTAINER)).toBe(true);
    }
    // one .json anchor, one .ttl graph, one .chat.ttl canonical
    expect(puts.map((p) => p.url.replace(/^.*\//, "")).some((n) => n.endsWith(".json"))).toBe(true);
    expect(puts.some((p) => p.url.endsWith(".ttl") && !p.url.endsWith(".chat.ttl"))).toBe(true);
    expect(puts.some((p) => p.url.endsWith(".chat.ttl"))).toBe(true);
  });

  it("is IDEMPOTENT: a replayed message maps to the same URLs and does not overwrite", async () => {
    const raw = slackEvent("hello");
    const message = slackEventToBridgeMessage(enc(raw));

    // First delivery.
    const first = recordingFetch();
    await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: first.fetchImpl,
    });
    const urls = first.calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(new Set(urls).size).toBe(3);

    // Second (replayed) delivery: those URLs already exist → all 412 → created:false.
    const second = recordingFetch({ existing: new Set(urls) });
    const result = await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: second.fetchImpl,
    });
    expect(result.created).toBe(false);
    // Same three URLs (deterministic slug), each got a 412 → no overwrite.
    expect(
      second.calls
        .filter((c) => c.method === "PUT")
        .map((c) => c.url)
        .sort(),
    ).toEqual([...urls].sort());
  });

  it("heals a PARTIAL prior delivery on retry (raw existed, graph+chat created)", async () => {
    const raw = slackEvent("partial");
    const message = slackEventToBridgeMessage(enc(raw));
    const probe = recordingFetch();
    await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: probe.fetchImpl,
    });
    const rawUrl = probe.calls.find((c) => c.url.endsWith(".json"))?.url as string;

    const retry = recordingFetch({ existing: new Set([rawUrl]) });
    const result = await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: retry.fetchImpl,
    });
    // The raw anchor 412'd (already there) but the graph + chat were newly created.
    expect(result.created).toBe(true);
  });

  it("throws on a genuine pod write failure (non-412)", async () => {
    const raw = slackEvent("boom");
    const message = slackEventToBridgeMessage(enc(raw));
    const { fetchImpl } = recordingFetch({ fail: () => 500 });
    await expect(
      writeMessageCreateOnly({
        message,
        raw: enc(raw),
        container: CONTAINER,
        writeFetch: fetchImpl,
      }),
    ).rejects.toThrow(/pod write failed/);
  });

  it("refuses a redirect on a pod write (fail-closed)", async () => {
    const raw = slackEvent("redir");
    const message = slackEventToBridgeMessage(enc(raw));
    const fetchImpl = (async () => new Response(null, { status: 302 })) as typeof fetch;
    await expect(
      writeMessageCreateOnly({
        message,
        raw: enc(raw),
        container: CONTAINER,
        writeFetch: fetchImpl,
      }),
    ).rejects.toThrow(/redirect/);
  });

  it("refuses a write escaping the configured container", async () => {
    const raw = slackEvent("escape");
    const message = slackEventToBridgeMessage(enc(raw));
    const { fetchImpl } = recordingFetch();
    await expect(
      writeMessageCreateOnly({
        message,
        raw: enc(raw),
        container: CONTAINER,
        writeFetch: fetchImpl,
        baseUrlFor: () => "https://evil.example/x",
      }),
    ).rejects.toThrow(/outside the configured container/);
  });

  it("marks agentic:Pending when a decoupled LLM sweep is expected", async () => {
    const raw = slackEvent("pending");
    const message = slackEventToBridgeMessage(enc(raw));
    const { fetchImpl, calls } = recordingFetch();
    await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: fetchImpl,
      markPendingInterpretation: true,
    });
    const graph = calls.find((c) => c.url.endsWith(".ttl") && !c.url.endsWith(".chat.ttl"));
    expect(String(graph?.body)).toContain("interpretationStatus");
    expect(String(graph?.body)).toContain("Pending");
  });
});

describe("writeMessageCreateOnly — slot containment (hostile body cannot inject RDF)", () => {
  it("stores a Turtle-injection body as an escaped LITERAL, not injected triples", async () => {
    // A body engineered to break out of a `<...>` / a literal and inject an ACL grant.
    const hostile =
      "hi> ] . <https://alice.example/inbox/.acl#x> a <http://www.w3.org/ns/auth/acl#Authorization> ; " +
      "<http://www.w3.org/ns/auth/acl#agentClass> <http://xmlns.com/foaf/0.1/Agent> ; " +
      "<http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> . #";
    const raw = slackEvent(hostile);
    const message = slackEventToBridgeMessage(enc(raw));
    const { fetchImpl, calls } = recordingFetch();
    await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: fetchImpl,
    });

    for (const c of calls.filter((x) => x.url.endsWith(".ttl"))) {
      const store = new Store(new Parser().parse(String(c.body)));
      // NO acl:Authorization / acl:agentClass triple was injected from the body.
      expect(
        store.getQuads(null, "http://www.w3.org/ns/auth/acl#agentClass", null, null),
      ).toHaveLength(0);
      expect(
        store.getQuads(
          null,
          "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
          "http://www.w3.org/ns/auth/acl#Authorization",
          null,
        ),
      ).toHaveLength(0);
    }
    // The hostile text survives intact as the canonical message CONTENT literal.
    const chat = calls.find((c) => c.url.endsWith(".chat.ttl"));
    const chatStore = new Store(new Parser().parse(String(chat?.body)));
    const contents = chatStore
      .getQuads(null, "https://www.w3.org/ns/activitystreams#content", null, null)
      .map((q) => q.object.value);
    expect(contents.some((v) => v.includes("acl#Authorization"))).toBe(true);
  });

  it("stores a hostile display name as an escaped literal (no IRI breakout)", async () => {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: "T12345",
      event: {
        type: "message",
        channel: "C99999",
        user: "U54321",
        ts: "1700000000.000200",
        text: "hi",
        username:
          "Bob> <http://evil/> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Control>",
      },
    });
    const message = slackEventToBridgeMessage(enc(raw));
    const { fetchImpl, calls } = recordingFetch();
    await writeMessageCreateOnly({
      message,
      raw: enc(raw),
      container: CONTAINER,
      writeFetch: fetchImpl,
    });
    const graph = calls.find((c) => c.url.endsWith(".ttl") && !c.url.endsWith(".chat.ttl"));
    const store = new Store(new Parser().parse(String(graph?.body)));
    // No acl:mode Control triple injected via the display name.
    expect(store.getQuads(null, "http://www.w3.org/ns/auth/acl#mode", null, null)).toHaveLength(0);
  });
});
