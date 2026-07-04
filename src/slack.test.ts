// AUTHORED-BY Claude Opus 4.8
import { createHash } from "node:crypto";
import { Parser } from "n3";
import { describe, expect, it } from "vitest";
import { ChannelParseError } from "./errors.js";
import { importInbound } from "./import.js";
import { detectBridgeCapability } from "./negotiate.js";
import { personIriFor } from "./sender.js";
import {
  SLACK_AGENTIC_METADATA_EVENT_TYPE,
  SlackChannelAdapter,
  SlackParseError,
  slackEventToBridgeMessage,
} from "./slack.js";
import { AGENTIC_IDENTITY_STATUS, SCHEMA_IDENTIFIER } from "./vocab.js";

const CONTAINER = "https://pod.example/inbox/";
const OWNER = "https://pod.example/profile/card#me";
const NOW = new Date("2026-07-04T00:00:00Z");

/** A realistic Events API `event_callback` wrapping a `message` event. */
function eventCallback(
  event: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    token: "verification-token",
    team_id: "T123",
    api_app_id: "A999",
    type: "event_callback",
    event_id: "Ev0001",
    event_time: 1_720_000_000,
    ...envelope,
    event: { type: "message", channel: "C111", ...event },
  });
}

// --- the happy path ----------------------------------------------------------

describe("slackEventToBridgeMessage — the happy path", () => {
  it("maps an event_callback message to a channel-neutral BridgeMessage", () => {
    const raw = eventCallback({
      user: "U456",
      text: "Can we meet at 2026-07-08T14:00:00Z?",
      ts: "1720000000.000100",
    });
    const m = slackEventToBridgeMessage(raw);
    expect(m.channel).toBe("slack");
    expect(m.sender?.handle).toBe("T123:U456");
    expect(m.textBody).toBe("Can we meet at 2026-07-08T14:00:00Z?");
    expect(m.messageId).toBe("1720000000.000100");
    expect(m.date).toBe(new Date(1_720_000_000_000).toISOString()); // ts seconds → ISO
    expect(m.rawMediaType).toBe("application/json");
    expect(m.subject).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it("computes the provenance anchor over the EXACT raw bytes", () => {
    const raw = eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100" });
    const m = slackEventToBridgeMessage(raw);
    expect(m.rawSha256).toBe(createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));
    expect(m.rawByteLength).toBe(Buffer.byteLength(raw, "utf8"));
  });

  it("accepts raw bytes (Uint8Array) as well as a string, with a matching digest", () => {
    const raw = eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100" });
    const bytes = new TextEncoder().encode(raw);
    const m = slackEventToBridgeMessage(bytes);
    expect(m.sender?.handle).toBe("T123:U456");
    expect(m.rawSha256).toBe(createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
  });

  it("parses a bare conversations.history row using the ctx.teamId", () => {
    const row = JSON.stringify({
      type: "message",
      user: "U789",
      text: "backfilled",
      ts: "1719000000.000200",
    });
    const m = slackEventToBridgeMessage(row, { teamId: "T555" });
    expect(m.sender?.handle).toBe("T555:U789");
    expect(m.textBody).toBe("backfilled");
  });

  it("prefers the inner event.team over the envelope team_id and ctx", () => {
    const raw = eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100", team: "T777" });
    const m = slackEventToBridgeMessage(raw, { teamId: "T000" });
    expect(m.sender?.handle).toBe("T777:U456");
  });

  it("accepts an app_mention event type", () => {
    const raw = eventCallback({
      type: "app_mention",
      user: "U456",
      text: "<@A999> hi",
      ts: "1720000000.000100",
    });
    const m = slackEventToBridgeMessage(raw);
    expect(m.channel).toBe("slack");
    expect(m.textBody).toBe("<@A999> hi");
  });

  it("sets threadId from a threaded reply's parent ts, and omits it for a root", () => {
    const reply = slackEventToBridgeMessage(
      eventCallback({
        user: "U456",
        text: "in-thread",
        ts: "1720000000.000200",
        thread_ts: "1720000000.000100",
      }),
    );
    expect(reply.threadId).toBe("1720000000.000100");
    const root = slackEventToBridgeMessage(
      eventCallback({
        user: "U456",
        text: "root",
        ts: "1720000000.000100",
        thread_ts: "1720000000.000100",
      }),
    );
    expect(root.threadId).toBeUndefined(); // thread_ts === ts → not a reply
  });

  it("extracts a display name from user_profile / username", () => {
    const withProfile = slackEventToBridgeMessage(
      eventCallback({
        user: "U456",
        text: "hi",
        ts: "1720000000.000100",
        user_profile: { display_name: "Ada L.", real_name: "Ada Lovelace" },
      }),
    );
    expect(withProfile.sender?.displayName).toBe("Ada L.");
    const withUsername = slackEventToBridgeMessage(
      eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100", username: "botname" }),
    );
    expect(withUsername.sender?.displayName).toBe("botname");
  });

  it("mints a channel-scoped slack person URN that cannot collide with email's", () => {
    const m = slackEventToBridgeMessage(
      eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100" }),
    );
    expect(personIriFor(m)).toMatch(/^urn:agentic:person:slack:[A-Za-z0-9_-]+$/);
  });
});

// --- signals → detectBridgeCapability ---------------------------------------

describe("slackEventToBridgeMessage — the detectBridgeCapability signal carrier", () => {
  it("maps our agentic_reply metadata payload into the signals map", () => {
    const raw = eventCallback({
      user: "U456",
      text: "here is a structured reply",
      ts: "1720000000.000100",
      metadata: {
        event_type: SLACK_AGENTIC_METADATA_EVENT_TYPE,
        event_payload: { channels: "rdf,a2a", reply: "https://pod.example/replies/1.ttl" },
      },
    });
    const m = slackEventToBridgeMessage(raw);
    const cap = detectBridgeCapability({ headers: m.signals });
    expect(cap.capable).toBe(true);
    expect(cap.channels).toContain("rdf");
    expect(cap.channels).toContain("a2a");
    expect(cap.podCopyUrl).toBe("https://pod.example/replies/1.ttl");
  });

  it("leaves signals empty (not capable) for a plain message with no agentic metadata", () => {
    const m = slackEventToBridgeMessage(
      eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100" }),
    );
    expect(Object.keys(m.signals)).toEqual([]);
    expect(detectBridgeCapability({ headers: m.signals }).capable).toBe(false);
  });

  it("ignores metadata whose event_type is not ours", () => {
    const raw = eventCallback({
      user: "U456",
      text: "hi",
      ts: "1720000000.000100",
      metadata: { event_type: "something_else", event_payload: { reply: "https://evil.example/" } },
    });
    const m = slackEventToBridgeMessage(raw);
    expect(Object.keys(m.signals)).toEqual([]);
  });

  it("builds signals on a null prototype (a hostile __proto__ payload key cannot pollute)", () => {
    // Hand-built so the raw JSON literally carries a "__proto__" key — JSON.parse
    // makes it an OWN property, which a naive header-map build could leak. We only
    // ever read known keys onto a null-proto target, so it cannot pollute.
    const raw =
      '{"type":"event_callback","team_id":"T123","event":{"type":"message","user":"U456",' +
      '"ts":"1720000000.000100","text":"hi","metadata":{"event_type":"' +
      SLACK_AGENTIC_METADATA_EVENT_TYPE +
      '","event_payload":{"channels":"rdf","__proto__":{"polluted":"x"}}}}}';
    expect(raw).toContain("__proto__");
    const m = slackEventToBridgeMessage(raw);
    expect(Object.getPrototypeOf(m.signals)).toBeNull();
    expect(Object.keys(m.signals)).toEqual(["x-agentic-channels"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// --- hostile / fail-closed input --------------------------------------------

describe("slackEventToBridgeMessage — hostile input skips, never crashes", () => {
  const cases: Array<[string, string | Uint8Array]> = [
    ["invalid JSON", "{not json"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON scalar", "42"],
    [
      "a non-message event type",
      eventCallback0({ type: "reaction_added", ts: "1720000000.000100" }),
    ],
    [
      "a url_verification handshake",
      JSON.stringify({ type: "url_verification", challenge: "abc" }),
    ],
    [
      "a message_changed subtype (edit)",
      eventCallback0({
        type: "message",
        subtype: "message_changed",
        ts: "1720000000.000100",
        text: "x",
      }),
    ],
    [
      "a message_deleted subtype",
      eventCallback0({
        type: "message",
        subtype: "message_deleted",
        ts: "1720000000.000100",
        text: "x",
      }),
    ],
    ["a missing ts", eventCallback0({ type: "message", user: "U456", text: "x" })],
    [
      "an out-of-shape ts",
      eventCallback0({ type: "message", user: "U456", text: "x", ts: "not-a-ts" }),
    ],
    ["a missing text", eventCallback0({ type: "message", user: "U456", ts: "1720000000.000100" })],
    [
      "a non-string text",
      eventCallback0({ type: "message", user: "U456", ts: "1720000000.000100", text: 123 }),
    ],
    [
      "an event_callback with no inner event",
      JSON.stringify({ type: "event_callback", team_id: "T1" }),
    ],
  ];
  for (const [label, raw] of cases) {
    it(`refuses ${label} with a SlackParseError (a ChannelParseError)`, () => {
      let thrown: unknown;
      try {
        slackEventToBridgeMessage(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SlackParseError);
      expect(thrown).toBeInstanceOf(ChannelParseError);
    });
  }

  it("throws (fail-closed) on an over-cap event, quickly", () => {
    const huge = `{"type":"message","user":"U1","ts":"1720000000.000100","text":"${"x".repeat(1024 * 1024 + 10)}"}`;
    expect(() => slackEventToBridgeMessage(huge)).toThrow(SlackParseError);
  });

  it("truncates an over-long (but under-cap) body with a warning", () => {
    const raw = eventCallback({ user: "U456", ts: "1720000000.000100", text: "y".repeat(200_000) });
    const m = slackEventToBridgeMessage(raw);
    expect(m.textBody.length).toBe(100_000);
    expect(m.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
});

describe("slackEventToBridgeMessage — untrusted content hardening", () => {
  it("control-strips terminal-escape sequences from the text (never persisted verbatim)", () => {
    const m = slackEventToBridgeMessage(
      eventCallback({ user: "U456", ts: "1720000000.000100", text: "hi\u0007\u001b[31mred\u0000" }),
    );
    expect(m.textBody).toBe("hi[31mred");
  });

  it("NEVER persists blocks/rich content — only the plain text, with a drop warning", () => {
    const m = slackEventToBridgeMessage(
      eventCallback({
        user: "U456",
        ts: "1720000000.000100",
        text: "fallback text",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<script>alert(1)</script>" } }],
      }),
    );
    expect(m.textBody).toBe("fallback text");
    expect(JSON.stringify(m)).not.toContain("<script>");
    expect(m.warnings.some((w) => w.includes("blocks"))).toBe(true);
  });

  it("leaves the sender provisional (anon node) on an out-of-shape user id", () => {
    const m = slackEventToBridgeMessage(
      eventCallback({ user: "u456", ts: "1720000000.000100", text: "hi" }),
    );
    expect(m.sender).toBeUndefined();
    expect(personIriFor(m)).toMatch(/^urn:agentic:person:anon-/);
    expect(m.warnings.some((w) => w.includes("provisional"))).toBe(true);
  });

  it("never mints a URN from an injection-carrying id — the handle is dropped", () => {
    const m = slackEventToBridgeMessage(
      eventCallback(
        { user: "U1> <urn:evil:s>", ts: "1720000000.000100", text: "hi" },
        { team_id: "T1\n<x>" },
      ),
    );
    expect(m.sender).toBeUndefined();
    expect(personIriFor(m)).toMatch(/^urn:agentic:person:anon-/);
  });

  it("drops an out-of-shape ctx.teamId rather than minting from it", () => {
    const m = slackEventToBridgeMessage(
      JSON.stringify({ type: "message", user: "U789", text: "hi", ts: "1719000000.000200" }),
      { teamId: "not-a-team>" },
    );
    expect(m.sender).toBeUndefined();
  });

  it("single-lines + caps a hostile multi-line display name", () => {
    const m = slackEventToBridgeMessage(
      eventCallback({
        user: "U456",
        ts: "1720000000.000100",
        text: "hi",
        username: `Ada\n\r<script>${"z".repeat(500)}`,
      }),
    );
    expect(m.sender?.displayName).not.toContain("\n");
    expect((m.sender?.displayName ?? "").length).toBeLessThanOrEqual(200);
  });
});

// --- the SlackChannelAdapter through the M2.0 pipeline -----------------------

interface Put {
  url: string;
  contentType: string;
  body: string;
}
function recordingFetch(puts: Put[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    puts.push({
      url: String(input),
      contentType: String((init?.headers as Record<string, string>)?.["content-type"] ?? ""),
      body: typeof init?.body === "string" ? init.body : "<bytes>",
    });
    return new Response(null, { status: 201 });
  }) as typeof globalThis.fetch;
}

describe("SlackChannelAdapter", () => {
  it("parses via slackEventToBridgeMessage and threads the configured teamId", () => {
    const adapter = new SlackChannelAdapter({ teamId: "T555" });
    const m = adapter.parse({
      id: "1719000000.000200",
      raw: JSON.stringify({ type: "message", user: "U789", text: "hi", ts: "1719000000.000200" }),
    });
    expect(m.channel).toBe("slack");
    expect(m.sender?.handle).toBe("T555:U789");
  });

  it("pullInbound returns the seeded messages (default), or the injected pull", async () => {
    const seeded = new SlackChannelAdapter({ messages: [{ id: "1", raw: "{}" }] });
    expect(await seeded.pullInbound()).toEqual([{ id: "1", raw: "{}" }]);
    const pulled = new SlackChannelAdapter({
      pull: () => Promise.resolve([{ id: "2", raw: "{}" }]),
    });
    expect(await pulled.pullInbound()).toEqual([{ id: "2", raw: "{}" }]);
  });

  it("writes a byte-exact .json anchor + graph + canonical, owner-private in-container", async () => {
    const puts: Put[] = [];
    const raw = eventCallback({
      user: "U456",
      text: "Can we meet at 2026-07-08T14:00:00Z?",
      ts: "1720000000.000100",
    });
    const adapter = new SlackChannelAdapter({ messages: [{ id: "1720000000.000100", raw }] });
    const result = await importInbound({
      adapter,
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
    });
    expect(result.written).toBe(1);
    expect(result.interpretations).toBeGreaterThan(0);

    const rawPut = puts.find((p) => p.url.endsWith(".json"));
    expect(rawPut?.contentType).toBe("application/json");
    expect(rawPut?.body).toBe(raw); // byte-exact anchor
    expect(puts.some((p) => p.url.endsWith(".eml"))).toBe(false);

    const graph = puts.find(
      (p) => p.url.endsWith(".ttl") && !p.url.endsWith(".chat.ttl") && !p.url.endsWith(".acl"),
    );
    expect(() => new Parser().parse(graph?.body ?? "")).not.toThrow();
    expect(graph?.body).toContain('"slack"'); // agentic:channel
    expect(graph?.body).toContain("application/json"); // agentic:rawMediaType
    expect(graph?.body).toContain("urn:agentic:person:slack:"); // channel-scoped sender
    for (const p of puts) expect(p.url.startsWith(CONTAINER)).toBe(true);
  });

  it("records the slack handle as a schema:identifier literal, never a mailto, flagged unverified", async () => {
    const puts: Put[] = [];
    const raw = eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100" });
    await importInbound({
      adapter: new SlackChannelAdapter({ messages: [{ id: "1", raw }] }),
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
    });
    const graph = puts.find(
      (p) => p.url.endsWith(".ttl") && !p.url.endsWith(".chat.ttl") && !p.url.endsWith(".acl"),
    );
    const store = new Parser().parse(graph?.body ?? "");
    const idQuad = store.find((q) => q.predicate.value === SCHEMA_IDENTIFIER);
    expect(idQuad?.object.value).toBe("T123:U456");
    expect(
      store.some(
        (q) => q.predicate.value === AGENTIC_IDENTITY_STATUS && q.object.value === "unverified",
      ),
    ).toBe(true);
    expect(graph?.body).not.toContain("mailto:");
  });

  it("skips a malformed event, never aborting the batch", async () => {
    const puts: Put[] = [];
    const adapter = new SlackChannelAdapter({
      messages: [
        { id: "bad", raw: JSON.stringify({ type: "reaction_added" }) }, // refused → skip
        { id: "ok", raw: eventCallback({ user: "U456", text: "hi", ts: "1720000000.000100" }) },
      ],
    });
    const result = await importInbound({
      adapter,
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
    });
    expect(result.skipped).toBe(1);
    expect(result.written).toBe(1);
  });
});

/**
 * A variant fixture that does NOT force `type: "message"` (so the hostile-input
 * table can drive arbitrary inner-event shapes through the `event_callback` envelope).
 */
function eventCallback0(event: Record<string, unknown>): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T123",
    event: { channel: "C111", ...event },
  });
}
