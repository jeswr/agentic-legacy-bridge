// AUTHORED-BY Claude Opus 4.8
import { createHash } from "node:crypto";
import { Parser } from "n3";
import { describe, expect, it } from "vitest";
import { ChannelParseError } from "./errors.js";
import { importInbound } from "./import.js";
import { detectBridgeCapability } from "./negotiate.js";
import { personIriFor } from "./sender.js";
import { AGENTIC_IDENTITY_STATUS, SCHEMA_IDENTIFIER } from "./vocab.js";
import {
  WhatsAppChannelAdapter,
  WhatsAppParseError,
  waIdToTelIri,
  waMessageToBridgeMessage,
} from "./whatsapp.js";

const CONTAINER = "https://pod.example/inbox/";
const OWNER = "https://pod.example/profile/card#me";
const NOW = new Date("2026-07-04T00:00:00Z");
const WAMID = "wamid.HBgLMTYzMTU1NTEyMzQVAgARGBI5QTNDQTVCM0Q0Q0Q2RTk3RTcA";
const WAMID_PARENT = "wamid.HBgLMTYzMTU1NTEyMzQVAgARGBJBNTVDQTAwMDAwMDAwMDAwMDAA";

/** A realistic full WhatsApp Cloud webhook body wrapping one `messages` change. */
function webhook(
  message: Record<string, unknown>,
  opts: { contacts?: Record<string, unknown>[]; field?: string } = {},
): string {
  const value: Record<string, unknown> = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550001111", phone_number_id: "PNID123" },
    ...(opts.contacts !== undefined
      ? { contacts: opts.contacts }
      : { contacts: [{ profile: { name: "Ada Lovelace" }, wa_id: "16315551234" }] }),
    messages: [message],
  };
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: opts.field ?? "messages", value }] }],
  });
}

/** A minimal valid text message object. */
function textMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: "16315551234",
    id: WAMID,
    timestamp: "1720000000",
    type: "text",
    text: { body: "Can we meet at 2026-07-08T14:00:00Z?" },
    ...overrides,
  };
}

// --- the happy path ----------------------------------------------------------

describe("waMessageToBridgeMessage — the happy path", () => {
  it("maps a full webhook body to a channel-neutral BridgeMessage", () => {
    const raw = webhook(textMessage());
    const m = waMessageToBridgeMessage(raw);
    expect(m.channel).toBe("whatsapp");
    expect(m.sender?.handle).toBe("16315551234");
    expect(m.sender?.displayName).toBe("Ada Lovelace");
    expect(m.textBody).toBe("Can we meet at 2026-07-08T14:00:00Z?");
    expect(m.messageId).toBe(WAMID); // globally-unique wamid (no qualification needed)
    expect(m.date).toBe(new Date(1_720_000_000_000).toISOString()); // epoch seconds → ISO
    expect(m.rawMediaType).toBe("application/json");
    expect(m.subject).toBeUndefined();
    expect(m.threadId).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it("computes the provenance anchor over the EXACT raw bytes", () => {
    const raw = webhook(textMessage());
    const m = waMessageToBridgeMessage(raw);
    expect(m.rawSha256).toBe(createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));
    expect(m.rawByteLength).toBe(Buffer.byteLength(raw, "utf8"));
  });

  it("accepts raw bytes (Uint8Array) as well as a string, with a matching digest", () => {
    const raw = webhook(textMessage());
    const bytes = new TextEncoder().encode(raw);
    const m = waMessageToBridgeMessage(bytes);
    expect(m.sender?.handle).toBe("16315551234");
    expect(m.rawSha256).toBe(createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
  });

  it("parses a bare `value` change object (a fanned-out feed)", () => {
    const bareValue = JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ profile: { name: "Grace" }, wa_id: "442071838750" }],
      messages: [textMessage({ from: "442071838750", text: { body: "hi from a bare value" } })],
    });
    const m = waMessageToBridgeMessage(bareValue);
    expect(m.sender?.handle).toBe("442071838750");
    expect(m.sender?.displayName).toBe("Grace");
    expect(m.textBody).toBe("hi from a bare value");
  });

  it("parses a bare single message object (no contacts → no display name)", () => {
    const m = waMessageToBridgeMessage(JSON.stringify(textMessage({ text: { body: "bare msg" } })));
    expect(m.sender?.handle).toBe("16315551234");
    expect(m.sender?.displayName).toBeUndefined();
    expect(m.textBody).toBe("bare msg");
  });

  it("sets threadId from a reply's context.id, and omits it for a non-reply", () => {
    const reply = waMessageToBridgeMessage(
      webhook(textMessage({ context: { from: "15550001111", id: WAMID_PARENT } })),
    );
    expect(reply.threadId).toBe(WAMID_PARENT);
    const root = waMessageToBridgeMessage(webhook(textMessage()));
    expect(root.threadId).toBeUndefined();
  });

  it("drops a self-referential context.id (not a real reply edge)", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage({ context: { from: "x", id: WAMID } })));
    expect(m.threadId).toBeUndefined();
  });

  it("mints a channel-scoped whatsapp person URN that cannot collide with email's", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage()));
    expect(personIriFor(m)).toMatch(/^urn:agentic:person:whatsapp:[A-Za-z0-9_-]+$/);
  });

  it("resolves the display name only from the contact whose wa_id matches the sender", () => {
    const raw = webhook(textMessage({ from: "16315551234" }), {
      contacts: [
        { profile: { name: "Someone Else" }, wa_id: "99999999999" },
        { profile: { name: "Correct Person" }, wa_id: "16315551234" },
      ],
    });
    expect(waMessageToBridgeMessage(raw).sender?.displayName).toBe("Correct Person");
  });
});

// --- multi-message fan-out ---------------------------------------------------

describe("waMessageToBridgeMessage — multi-message delivery fan-out", () => {
  function twoMessageWebhook(): string {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                contacts: [{ profile: { name: "A" }, wa_id: "16315551234" }],
                messages: [
                  textMessage({ id: `${WAMID}AAA`, text: { body: "first" } }),
                  textMessage({ id: `${WAMID}BBB`, text: { body: "second" } }),
                ],
              },
            },
          ],
        },
      ],
    });
  }

  it("parses index 0 by default and warns that the delivery is multi-message", () => {
    const m = waMessageToBridgeMessage(twoMessageWebhook());
    expect(m.textBody).toBe("first");
    expect(m.messageId).toBe(`${WAMID}AAA`);
    expect(m.warnings.some((w) => w.includes("2 messages"))).toBe(true);
  });

  it("selects a later message by messageIndex (the M2.4 fan-out seam)", () => {
    const m = waMessageToBridgeMessage(twoMessageWebhook(), { messageIndex: 1 });
    expect(m.textBody).toBe("second");
    expect(m.messageId).toBe(`${WAMID}BBB`);
  });

  it("shares one delivery-anchor rawSha256 across every message in the batch", () => {
    const raw = twoMessageWebhook();
    const a = waMessageToBridgeMessage(raw, { messageIndex: 0 });
    const b = waMessageToBridgeMessage(raw, { messageIndex: 1 });
    expect(a.rawSha256).toBe(b.rawSha256); // same signed delivery
    expect(a.messageId).not.toBe(b.messageId); // distinct wamids
  });

  it("throws (fail-closed) on an out-of-range messageIndex", () => {
    expect(() => waMessageToBridgeMessage(webhook(textMessage()), { messageIndex: 5 })).toThrow(
      WhatsAppParseError,
    );
  });

  it("treats a negative / non-integer messageIndex as 0", () => {
    expect(waMessageToBridgeMessage(webhook(textMessage()), { messageIndex: -1 }).textBody).toBe(
      "Can we meet at 2026-07-08T14:00:00Z?",
    );
    expect(waMessageToBridgeMessage(webhook(textMessage()), { messageIndex: 1.5 }).textBody).toBe(
      "Can we meet at 2026-07-08T14:00:00Z?",
    );
  });
});

// --- signals: WhatsApp has NO inline capability carrier ----------------------

describe("waMessageToBridgeMessage — no inline capability carrier", () => {
  it("always yields empty, null-prototype signals (never bridge-capable inline)", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage()));
    expect(Object.getPrototypeOf(m.signals)).toBeNull();
    expect(Object.keys(m.signals)).toEqual([]);
    expect(detectBridgeCapability({ headers: m.signals }).capable).toBe(false);
  });

  it("cannot be polluted by a hostile __proto__ payload key", () => {
    // A message object literally carrying a "__proto__" key — JSON.parse makes it an
    // OWN property; we never read arbitrary keys into signals, so it cannot pollute.
    const raw =
      '{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages",' +
      '"value":{"messages":[{"from":"16315551234","id":"' +
      WAMID +
      '","type":"text","timestamp":"1720000000","text":{"body":"hi"},' +
      '"__proto__":{"polluted":"x"}}]}}]}]}';
    expect(raw).toContain("__proto__");
    const m = waMessageToBridgeMessage(raw);
    expect(Object.getPrototypeOf(m.signals)).toBeNull();
    expect(Object.keys(m.signals)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// --- waIdToTelIri (the tel: candidate seam) ----------------------------------

describe("waIdToTelIri — strict-E.164 tel: candidate", () => {
  it("mints a tel: IRI from a valid wa_id (digits, no +)", () => {
    expect(waIdToTelIri("16315551234")).toBe("tel:+16315551234");
    expect(waIdToTelIri("442071838750")).toBe("tel:+442071838750");
  });

  it("tolerates an already-`+`-prefixed value", () => {
    expect(waIdToTelIri("+16315551234")).toBe("tel:+16315551234");
  });

  it("returns undefined for a non-E.164 handle (never an injectable IRI)", () => {
    expect(waIdToTelIri("not-a-number")).toBeUndefined();
    expect(waIdToTelIri("1631555<inject>")).toBeUndefined();
    expect(waIdToTelIri("012345678")).toBeUndefined(); // leading zero → not E.164
    expect(waIdToTelIri("123")).toBeUndefined(); // too short
    expect(waIdToTelIri("1".repeat(20))).toBeUndefined(); // too long (E.164 caps at 15)
    expect(waIdToTelIri("")).toBeUndefined();
    expect(waIdToTelIri(12345 as unknown)).toBeUndefined(); // non-string
  });

  it("the tel: candidate is derivable from a parsed message's sender handle", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage({ from: "16315551234" })));
    expect(waIdToTelIri(m.sender?.handle)).toBe("tel:+16315551234");
  });
});

// --- hostile / fail-closed input --------------------------------------------

describe("waMessageToBridgeMessage — hostile input skips, never crashes", () => {
  const cases: Array<[string, string | Uint8Array]> = [
    ["invalid JSON", "{not json"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON scalar", "42"],
    ["an empty object", "{}"],
    ["a body with no messages", webhook0({ messages: [] })],
    [
      "a statuses/receipt-only change (no messages)",
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "statuses", value: { statuses: [{ id: "x" }] } }] }],
      }),
    ],
    [
      "a non-messages field",
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "message_template_status_update", value: {} }] }],
      }),
    ],
    ["a non-text message type (image)", webhook({ from: "16315551234", id: WAMID, type: "image" })],
    [
      "an interactive reply (never flattened to text)",
      webhook({
        from: "16315551234",
        id: WAMID,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "b1", title: "Yes" } },
      }),
    ],
    ["a missing id (wamid)", webhook({ from: "16315551234", type: "text", text: { body: "x" } })],
    [
      "an out-of-shape wamid",
      webhook({ from: "16315551234", id: "not-a-wamid>", type: "text", text: { body: "x" } }),
    ],
    ["a missing text.body", webhook({ from: "16315551234", id: WAMID, type: "text" })],
    [
      "a non-string text.body",
      webhook({ from: "16315551234", id: WAMID, type: "text", text: { body: 123 } }),
    ],
    [
      "a text object that is not an object",
      webhook({ from: "16315551234", id: WAMID, type: "text", text: "just a string" }),
    ],
  ];
  for (const [label, raw] of cases) {
    it(`refuses ${label} with a WhatsAppParseError (a ChannelParseError)`, () => {
      let thrown: unknown;
      try {
        waMessageToBridgeMessage(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WhatsAppParseError);
      expect(thrown).toBeInstanceOf(ChannelParseError);
    });
  }

  it("throws (fail-closed) on an over-cap webhook, quickly", () => {
    const huge = webhook(textMessage({ text: { body: "x".repeat(1024 * 1024 + 10) } }));
    expect(() => waMessageToBridgeMessage(huge)).toThrow(WhatsAppParseError);
  });

  it("truncates an over-long (but under-cap) body with a warning", () => {
    const m = waMessageToBridgeMessage(
      webhook(textMessage({ text: { body: "y".repeat(200_000) } })),
    );
    expect(m.textBody.length).toBe(100_000);
    expect(m.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
});

describe("waMessageToBridgeMessage — untrusted content hardening", () => {
  it("control-strips terminal-escape sequences from the text (never persisted verbatim)", () => {
    const m = waMessageToBridgeMessage(
      webhook(textMessage({ text: { body: "hi\u0007\u001b[31mred\u0000" } })),
    );
    expect(m.textBody).toBe("hi[31mred");
  });

  it("leaves the sender provisional (anon node) on an out-of-shape wa_id", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage({ from: "not-a-number" })));
    expect(m.sender).toBeUndefined();
    expect(personIriFor(m)).toMatch(/^urn:agentic:person:anon-/);
    expect(m.warnings.some((w) => w.includes("provisional"))).toBe(true);
  });

  it("never mints from an injection-carrying from/wa_id — the handle is dropped", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage({ from: "1631> <urn:evil:s>" })));
    expect(m.sender).toBeUndefined();
    expect(personIriFor(m)).toMatch(/^urn:agentic:person:anon-/);
  });

  it("single-lines + caps a hostile multi-line profile.name", () => {
    const m = waMessageToBridgeMessage(
      webhook(textMessage({ from: "16315551234" }), {
        contacts: [
          {
            profile: { name: `Ada\n\r<script>${"z".repeat(500)}` },
            wa_id: "16315551234",
          },
        ],
      }),
    );
    expect(m.sender?.displayName).not.toContain("\n");
    expect((m.sender?.displayName ?? "").length).toBeLessThanOrEqual(200);
  });

  it("omits the date (with a warning) on an unparseable timestamp", () => {
    const m = waMessageToBridgeMessage(webhook(textMessage({ timestamp: "not-a-timestamp" })));
    expect(m.date).toBeUndefined();
    expect(m.warnings.some((w) => w.includes("timestamp"))).toBe(true);
  });
});

// --- the WhatsAppChannelAdapter through the M2.0 pipeline ---------------------

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

describe("WhatsAppChannelAdapter", () => {
  it("parses via waMessageToBridgeMessage", () => {
    const adapter = new WhatsAppChannelAdapter();
    const m = adapter.parse({ id: WAMID, raw: webhook(textMessage()) });
    expect(m.channel).toBe("whatsapp");
    expect(m.sender?.handle).toBe("16315551234");
    expect(m.messageId).toBe(WAMID);
  });

  it("threads a configured messageIndex through parse", () => {
    const twoMsg = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  textMessage({ id: `${WAMID}AAA`, text: { body: "first" } }),
                  textMessage({ id: `${WAMID}BBB`, text: { body: "second" } }),
                ],
              },
            },
          ],
        },
      ],
    });
    const adapter = new WhatsAppChannelAdapter({ messageIndex: 1 });
    expect(adapter.parse({ id: `${WAMID}BBB`, raw: twoMsg }).textBody).toBe("second");
  });

  it("pullInbound returns the seeded messages (default), or the injected pull", async () => {
    const seeded = new WhatsAppChannelAdapter({ messages: [{ id: "1", raw: "{}" }] });
    expect(await seeded.pullInbound()).toEqual([{ id: "1", raw: "{}" }]);
    const pulled = new WhatsAppChannelAdapter({
      pull: () => Promise.resolve([{ id: "2", raw: "{}" }]),
    });
    expect(await pulled.pullInbound()).toEqual([{ id: "2", raw: "{}" }]);
  });

  it("writes a byte-exact .json anchor + graph + canonical, owner-private in-container", async () => {
    const puts: Put[] = [];
    const raw = webhook(textMessage());
    const adapter = new WhatsAppChannelAdapter({ messages: [{ id: WAMID, raw }] });
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
    expect(graph?.body).toContain('"whatsapp"'); // agentic:channel
    expect(graph?.body).toContain("application/json"); // agentic:rawMediaType
    expect(graph?.body).toContain("urn:agentic:person:whatsapp:"); // channel-scoped sender
    for (const p of puts) expect(p.url.startsWith(CONTAINER)).toBe(true);
  });

  it("records the wa_id as a schema:identifier literal, never a mailto/tel IRI, flagged unverified", async () => {
    const puts: Put[] = [];
    await importInbound({
      adapter: new WhatsAppChannelAdapter({
        messages: [{ id: WAMID, raw: webhook(textMessage()) }],
      }),
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
    expect(idQuad?.object.value).toBe("16315551234");
    expect(
      store.some(
        (q) => q.predicate.value === AGENTIC_IDENTITY_STATUS && q.object.value === "unverified",
      ),
    ).toBe(true);
    // The M2.2 transform-only pipeline records the opaque handle literally; the
    // `schema:telephone` `tel:` edge (via waIdToTelIri) is the M2.4 sender-wiring.
    expect(graph?.body).not.toContain("mailto:");
    expect(graph?.body).not.toContain("tel:");
  });

  it("skips a malformed delivery, never aborting the batch", async () => {
    const puts: Put[] = [];
    const adapter = new WhatsAppChannelAdapter({
      messages: [
        { id: "bad", raw: JSON.stringify({ object: "whatsapp_business_account", entry: [] }) },
        { id: WAMID, raw: webhook(textMessage()) },
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
 * A variant fixture that does NOT force a valid message shape (so the hostile-input
 * table can drive an arbitrary `value` through the full-body envelope).
 */
function webhook0(value: Record<string, unknown>): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value }] }],
  });
}
