// AUTHORED-BY Claude Fable 5
import { Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { type InboundRawMessage, InMemoryChannelAdapter, parseEmailInbound } from "./channel.js";
import { EmailParseError, parseEmail } from "./email/parse.js";
import { ChannelParseError } from "./errors.js";
import { importInbound } from "./import.js";
import { deterministicInterpreter } from "./interpret.js";
import { type BridgeMessage, toBridgeMessage } from "./message.js";
import { addSenderPerson, personIriFor } from "./sender.js";
import {
  AGENTIC_CANDIDATE_PERSON,
  AGENTIC_IDENTITY_STATUS,
  SCHEMA_EMAIL,
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
} from "./vocab.js";

const CONTAINER = "https://pod.example/inbox/";
const OWNER = "https://pod.example/profile/card#me";
const NOW = new Date("2026-07-04T00:00:00Z");

const EMAIL = [
  "From: Jane <jane@example.com>",
  "Subject: Project sync",
  "Date: Wed, 08 Jul 2026 09:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "Can we meet at 2026-07-08T14:00:00Z?",
].join("\r\n");

/** A minimal, fixture-only "slack" parse (M2.1 ships the real hardened transform). */
function slackParse(item: InboundRawMessage): BridgeMessage {
  const ev = JSON.parse(String(item.raw)) as {
    team: string;
    user: string;
    text: string;
    ts: string;
  };
  if (typeof ev.text !== "string") throw new ChannelParseError("not a message event");
  return {
    channel: "slack",
    sender: { handle: `${ev.team}:${ev.user}`, displayName: "Ada" },
    textBody: ev.text,
    messageId: ev.ts,
    signals: {},
    rawSha256: "b".repeat(64),
    rawByteLength: String(item.raw).length,
    rawMediaType: "application/json",
    warnings: [],
  };
}

function slackBridge(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    channel: "slack",
    sender: { handle: "T123:U456" },
    textBody: "hello",
    signals: {},
    rawSha256: "c".repeat(64),
    rawByteLength: 5,
    rawMediaType: "application/json",
    warnings: [],
    ...overrides,
  };
}

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

describe("parseEmailInbound (email is the first ChannelAdapter)", () => {
  it("parses a raw email into a channel-neutral BridgeMessage", () => {
    const m = parseEmailInbound({ id: "m1@example.com", raw: EMAIL });
    expect(m.channel).toBe("email");
    expect(m.sender?.handle).toBe("jane@example.com");
    expect(m.rawMediaType).toBe("message/rfc822");
  });

  it("throws EmailParseError, which IS a ChannelParseError (the skip contract)", () => {
    const huge = `From: a@b.com\r\n\r\n${"x".repeat(31 * 1024 * 1024)}`;
    let thrown: unknown;
    try {
      parseEmailInbound({ id: "big", raw: huge });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EmailParseError);
    expect(thrown).toBeInstanceOf(ChannelParseError);
  });
});

describe("InMemoryChannelAdapter (M2.0 parse seam)", () => {
  it("defaults to the email parse for the email channel", () => {
    const adapter = new InMemoryChannelAdapter("email", []);
    expect(adapter.parse({ id: "m1", raw: EMAIL }).channel).toBe("email");
  });

  it("fails fast when a non-email channel omits its parse (never mis-channelled)", () => {
    expect(() => new InMemoryChannelAdapter("slack", [])).toThrow(TypeError);
  });

  it("uses the injected parse for a non-email channel", () => {
    const adapter = new InMemoryChannelAdapter("slack", [], slackParse);
    const m = adapter.parse({
      id: "1720000000.000100",
      raw: JSON.stringify({ team: "T1", user: "U2", text: "hi", ts: "1720000000.000100" }),
    });
    expect(m.channel).toBe("slack");
    expect(m.sender?.handle).toBe("T1:U2");
  });
});

describe("channel-scoped person URNs (M2-DESIGN §1.4)", () => {
  it("email keeps its M1 key through the BridgeMessage seam (pod back-compat)", () => {
    // The M1 EmailMessage path and the M2 BridgeMessage path mint the SAME node.
    const viaEmailMessage = personIriFor(parseEmail(EMAIL));
    const viaBridge = personIriFor(parseEmailInbound({ id: "m1", raw: EMAIL }));
    const viaExplicitMap = personIriFor(toBridgeMessage(parseEmail(EMAIL)));
    expect(viaBridge).toBe(viaEmailMessage);
    expect(viaExplicitMap).toBe(viaEmailMessage);
    expect(viaBridge).toMatch(/^urn:agentic:person:[A-Za-z0-9_-]+$/); // unscoped M1 shape
  });

  it("a non-email channel mints a channel-scoped key that cannot collide with email's", () => {
    const slack = personIriFor(slackBridge());
    expect(slack).toMatch(/^urn:agentic:person:slack:[A-Za-z0-9_-]+$/);
    // The SAME handle string on another channel is a DIFFERENT person node.
    const other = personIriFor(slackBridge({ channel: "whatsapp" }));
    expect(other).toMatch(/^urn:agentic:person:whatsapp:/);
    expect(other).not.toBe(slack);
  });

  it("is stable for the same channel-scoped handle (reconcilable)", () => {
    expect(personIriFor(slackBridge())).toBe(personIriFor(slackBridge({ textBody: "different" })));
  });

  it("falls back to a provisional anon node on a missing handle", () => {
    const m = slackBridge();
    const noSender: BridgeMessage = { ...m, sender: undefined };
    expect(personIriFor(noSender)).toMatch(/^urn:agentic:person:anon-/);
  });

  it("falls back to anon on an out-of-shape channel token (never injected into the URN)", () => {
    expect(personIriFor(slackBridge({ channel: "Slack Evil>" }))).toMatch(
      /^urn:agentic:person:anon-/,
    );
  });

  it("falls back to anon (never a truncated, collidable key) on an over-cap handle", () => {
    expect(personIriFor(slackBridge({ sender: { handle: "x".repeat(2000) } }))).toMatch(
      /^urn:agentic:person:anon-/,
    );
  });
});

describe("addSenderPerson on a non-email channel", () => {
  it("records the handle as a schema:identifier literal, never a mailto", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(store, slackBridge());
    expect(store.getQuads(personIri, SCHEMA_IDENTIFIER, null, null)[0]?.object.value).toBe(
      "T123:U456",
    );
    expect(store.getQuads(personIri, SCHEMA_EMAIL, null, null).length).toBe(0);
    expect(store.getQuads(personIri, AGENTIC_IDENTITY_STATUS, null, null)[0]?.object.value).toBe(
      "unverified",
    );
  });

  it("control-strips a hostile display name and identifier", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(
      store,
      slackBridge({ sender: { handle: "T1:U2\u0007", displayName: "Ada\u001b[31m" } }),
    );
    expect(store.getQuads(personIri, SCHEMA_IDENTIFIER, null, null)[0]?.object.value).toBe("T1:U2");
    expect(store.getQuads(personIri, SCHEMA_NAME, null, null)[0]?.object.value).toBe("Ada[31m");
  });

  it("attaches candidatePerson HINT edges, fail-closed filtered + deduped, never a self-edge", () => {
    const store = new Store();
    const emailPerson = personIriFor(parseEmailInbound({ id: "m1", raw: EMAIL }));
    const { personIri } = addSenderPerson(store, slackBridge(), {
      candidatePersonIris: [
        emailPerson,
        emailPerson, // dup
        personIriFor(slackBridge()), // self — dropped
        "urn:agentic:person:x> <urn:evil:s> <urn:evil:p> <urn:evil:o>", // injection — dropped
        "urn:evil:foo", // foreign urn namespace — dropped (only urn:agentic:person:…)
        "urn:agentic:raw:abc", // wrong agentic kind — dropped
        "not a urn", // dropped
      ],
    });
    const edges = store.getQuads(personIri, AGENTIC_CANDIDATE_PERSON, null, null);
    expect(edges.length).toBe(1);
    expect(edges[0]?.object.value).toBe(emailPerson);
  });

  it("control-strips + caps an adapter-supplied dkimDomainClaim, dropping an empty one", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(
      store,
      slackBridge({ dkimDomainClaim: " mail.example.com\u0000\u001b[31m " }),
    );
    const claims = store.getQuads(
      personIri,
      "https://w3id.org/jeswr/agentic#dkimDomainClaim",
      null,
      null,
    );
    expect(claims[0]?.object.value).toBe("mail.example.com[31m");
    expect(claims[0]?.object.value.length).toBeLessThanOrEqual(253);

    const store2 = new Store();
    const { personIri: p2 } = addSenderPerson(
      store2,
      slackBridge({ dkimDomainClaim: "\u0000\u0007 " }),
    );
    expect(
      store2.getQuads(p2, "https://w3id.org/jeswr/agentic#dkimDomainClaim", null, null).length,
    ).toBe(0);
  });
});

describe("importInbound through a non-email adapter (the M2.0 spine)", () => {
  it("writes .json raw anchor + graph + canonical for a slack-shaped channel", async () => {
    const puts: Put[] = [];
    const raw = JSON.stringify({
      team: "T1",
      user: "U2",
      text: "Can we meet at 2026-07-08T14:00:00Z?",
      ts: "1720000000.000100",
    });
    const adapter = new InMemoryChannelAdapter(
      "slack",
      [{ id: "1720000000.000100", raw }],
      slackParse,
    );
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
    expect(rawPut).toBeDefined();
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

  it("skips a message whose parse throws ChannelParseError, never aborting the batch", async () => {
    const puts: Put[] = [];
    const adapter = new InMemoryChannelAdapter(
      "slack",
      [
        { id: "bad", raw: JSON.stringify({ team: "T1", user: "U2", ts: "1" }) }, // no text → refuse
        {
          id: "ok",
          raw: JSON.stringify({ team: "T1", user: "U2", text: "hi", ts: "2" }),
        },
      ],
      slackParse,
    );
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

  it("fails FAST (before any pod write) on a pre-M2.0 adapter without parse", async () => {
    const puts: Put[] = [];
    // A stale JS consumer's adapter shape: pullInbound + sendReply only, no parse.
    const legacyAdapter = {
      channel: "email",
      pullInbound: () => Promise.resolve([{ id: "m1", raw: EMAIL }]),
    } as unknown as InMemoryChannelAdapter;
    await expect(
      importInbound({
        adapter: legacyAdapter,
        writeFetch: recordingFetch(puts),
        container: CONTAINER,
        ownerWebId: OWNER,
      }),
    ).rejects.toThrow(/must implement parse/);
    expect(puts.length).toBe(0); // nothing written — not even the ACL
  });

  it("re-throws a NON-parse error from an adapter (never silently loses data)", async () => {
    const adapter = new InMemoryChannelAdapter("slack", [{ id: "x", raw: "{}" }], () => {
      throw new Error("adapter bug");
    });
    await expect(
      importInbound({
        adapter,
        writeFetch: recordingFetch([]),
        container: CONTAINER,
        ownerWebId: OWNER,
      }),
    ).rejects.toThrow(/adapter bug/);
  });

  it("falls back fail-closed on a malformed adapter rawMediaType (octet-stream, .raw)", async () => {
    const puts: Put[] = [];
    const adapter = new InMemoryChannelAdapter("slack", [{ id: "x", raw: "{}" }], () =>
      slackBridge({ rawMediaType: 'evil">/type' }),
    );
    await importInbound({
      adapter,
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
    });
    const rawPut = puts.find((p) => p.url.endsWith(".raw"));
    expect(rawPut).toBeDefined();
    expect(rawPut?.contentType).toBe("application/octet-stream");
  });

  it("passes the parsed BridgeMessage to candidateWebIdsFor", async () => {
    const seen: string[] = [];
    const adapter = new InMemoryChannelAdapter(
      "slack",
      [{ id: "1", raw: JSON.stringify({ team: "T1", user: "U2", text: "hi", ts: "1" }) }],
      slackParse,
    );
    await importInbound({
      adapter,
      writeFetch: recordingFetch([]),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
      candidateWebIdsFor: (m) => {
        seen.push(m.channel);
        return [];
      },
    });
    expect(seen).toEqual(["slack"]);
  });
});

describe("Interpreter on a BridgeMessage (type-widened seam)", () => {
  it("the deterministic reference interprets a non-email BridgeMessage identically", () => {
    const out = deterministicInterpreter.interpret(
      slackBridge({ textBody: "Meet at 2026-07-08T14:00:00Z", subject: "Sync" }),
      { docIri: "https://pod.example/inbox/m.ttl", now: NOW },
    );
    expect(
      out.some((i) => i.object.kind === "literal" && i.object.value.startsWith("2026-07-08T14:00")),
    ).toBe(true);
  });
});
