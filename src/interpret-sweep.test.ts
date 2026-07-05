// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Parser, type Quad } from "n3";
import { describe, expect, it, vi } from "vitest";
import { parseEmailInbound } from "./channel.js";
import { buildAgenticGraph } from "./graph.js";
import { messageSlug, slugToMessageId } from "./import.js";
import { type LlmExtractor, scriptedExtractor } from "./interpret-llm.js";
import {
  reparseRawAnchor,
  type SweepAuditEvent,
  sweepPendingInterpretations,
} from "./interpret-sweep.js";
import type { BridgeMessage } from "./message.js";
import { mintUrn } from "./safe-iri.js";
import { slackEventToBridgeMessage } from "./slack.js";
import { writeMessageCreateOnly } from "./webhook/write.js";
import { parseWhatsAppDelivery } from "./whatsapp.js";

const AGENTIC = "https://w3id.org/jeswr/agentic#";
const SCHEMA = "https://schema.org/";
const PROV = "http://www.w3.org/ns/prov#";
const CONTAINER = "https://pod.example/inbox/";
const INTERPRETER_WEBID = "https://pod.example/agents/interpreter#me";
const MEETING = "2026-07-08T14:00:00Z";

// --- fixtures ----------------------------------------------------------------
function slackEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: "t",
    team_id: "T123",
    type: "event_callback",
    event_id: "Ev1",
    event: {
      type: "message",
      channel: "C111",
      user: "U456",
      ts: "1720000000.000100",
      text: `Can we meet at ${MEETING}?`,
      ...overrides,
    },
  });
}

const WAMID_A = "wamid.HBgLMTYzMTU1NTEyMzQVAgARGBI5QTNDQTVCM0Q0Q0Q2RTk3RTcA";
const WAMID_B = "wamid.HBgLMTYzMTU1NTEyMzQVAgARGBJBNTVDQTAwMDAwMDAwMDAwMDAA";

function waDelivery(messages: Record<string, unknown>[]): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "PNID123" },
              contacts: [{ profile: { name: "Ada" }, wa_id: "16315551234" }],
              messages,
            },
          },
        ],
      },
    ],
  });
}

function waText(id: string, body: string): Record<string, unknown> {
  return { from: "16315551234", id, timestamp: "1720000000", type: "text", text: { body } };
}

function emailRaw(id: string, body: string): string {
  return `From: Jane <jane@example.com>\r\nMessage-ID: <${id}>\r\nSubject: Sync\r\nDate: Wed, 08 Jul 2026 09:00:00 +0000\r\n\r\n${body}`;
}

// --- extractors --------------------------------------------------------------
/** Echoes the flagship ISO datetime back (a Calibrated, re-derivable meeting). */
const echoMeeting: LlmExtractor = scriptedExtractor({
  "meeting-times": () => ({
    items: [{ startTime: MEETING, confidence: 0.9, sourceSpan: `meet at ${MEETING}` }],
  }),
  "action-items": () => ({ items: [] }),
  "reply-polarity": () => ({ items: [] }),
});

/** A clean-empty extractor (model up, nothing to extract) — no warnings, no items. */
const emptyExtractor: LlmExtractor = scriptedExtractor({
  "meeting-times": () => ({ items: [] }),
  "action-items": () => ({ items: [] }),
  "reply-polarity": () => ({ items: [] }),
});

/** A wholly-failing extractor (model/endpoint down) — every task throws. */
const throwingExtractor: LlmExtractor = async () => {
  throw new Error("model endpoint unavailable");
};

// --- a hermetic in-memory pod ------------------------------------------------
interface Stored {
  body: string | Uint8Array;
  etag: string;
  contentType: string;
}
interface FakePodOptions {
  /** Content-negotiate: serve HTML for an RDF read whose Accept does not request RDF. */
  readonly conneg?: boolean;
  /**
   * The ETag style: `"weak"` = `W/"…"`, `"malformed"` = an unquoted bare token — both
   * unusable with `If-Match` strong comparison. Default = a proper strong quoted tag.
   */
  readonly etagStyle?: "weak" | "malformed";
}
function makeFakePod(opts: FakePodOptions = {}) {
  const resources = new Map<string, Stored>();
  const reads: string[] = [];
  const writes: string[] = [];
  const accepts: { url: string; accept: string }[] = [];
  const extraContains: string[] = [];
  let seq = 0;
  const tag = (n: number): string =>
    opts.etagStyle === "weak" ? `W/"e${n}"` : opts.etagStyle === "malformed" ? `e${n}` : `"e${n}"`;
  const nextEtag = () => tag(++seq);
  const wantsRdf = (accept: string | null): boolean =>
    accept !== null && (accept.includes("turtle") || accept.includes("ld+json"));

  const impl = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (method === "GET") {
      reads.push(url);
      const accept = headers.get("accept");
      accepts.push({ url, accept: accept ?? "<none>" });
      const isRdfResource = url.endsWith("/") || url.endsWith(".ttl");
      // A conneg server hands back its HTML view unless RDF is explicitly requested.
      if (opts.conneg && isRdfResource && !wantsRdf(accept)) {
        return new Response("<html><body>human view</body></html>", {
          status: 200,
          headers: { "content-type": "text/html", etag: '"html"' },
        });
      }
      if (url.endsWith("/")) {
        const children = [
          ...[...resources.keys()].filter(
            (k) => k.startsWith(url) && !k.slice(url.length).includes("/"),
          ),
          ...extraContains,
        ];
        const ttl =
          `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<${url}> a ldp:Container` +
          (children.length ? ` ; ldp:contains ${children.map((c) => `<${c}>`).join(", ")}` : "") +
          " .\n";
        return new Response(ttl, {
          status: 200,
          headers: { "content-type": "text/turtle", etag: tag(0) },
        });
      }
      const r = resources.get(url);
      if (r === undefined) return new Response(null, { status: 404 });
      return new Response(typeof r.body === "string" ? r.body : Buffer.from(r.body), {
        status: 200,
        headers: { "content-type": r.contentType, etag: r.etag },
      });
    }
    if (method === "PUT") {
      writes.push(url);
      const inm = headers.get("if-none-match");
      const im = headers.get("if-match");
      const exists = resources.has(url);
      if (inm === "*" && exists) return new Response(null, { status: 412 });
      if (im !== null) {
        const cur = resources.get(url);
        if (cur === undefined || cur.etag !== im) return new Response(null, { status: 412 });
      }
      const etag = nextEtag();
      resources.set(url, {
        body: (init.body ?? "") as string | Uint8Array,
        etag,
        contentType: headers.get("content-type") ?? "text/turtle",
      });
      return new Response(null, { status: exists ? 200 : 201, headers: { etag } });
    }
    return new Response(null, { status: 405 });
  };

  return {
    fetch: impl as unknown as typeof globalThis.fetch,
    resources,
    reads,
    writes,
    accepts,
    extraContains,
    force(url: string, body: string | Uint8Array, contentType = "text/turtle") {
      resources.set(url, { body, etag: `"f${++seq}"`, contentType });
    },
  };
}

type FakePod = ReturnType<typeof makeFakePod>;

/** Seed one Pending resource exactly as the M2.4 webhook writes it (real writer). */
async function seedPending(
  pod: FakePod,
  args: { message: BridgeMessage; raw: string; baseUrlFor?: (k: string) => string },
): Promise<{ docUrl: string; slug: string }> {
  const result = await writeMessageCreateOnly({
    message: args.message,
    raw: args.raw,
    container: CONTAINER,
    writeFetch: pod.fetch,
    markPendingInterpretation: true,
    ...(args.baseUrlFor !== undefined ? { baseUrlFor: args.baseUrlFor } : {}),
  });
  const key = args.message.messageId ?? args.message.rawSha256;
  const base = args.baseUrlFor ? args.baseUrlFor(key) : `${CONTAINER}${result.slug}`;
  return { docUrl: `${base}.ttl`, slug: result.slug };
}

function quadsOf(pod: FakePod, url: string): Quad[] {
  const r = pod.resources.get(url);
  if (r === undefined) throw new Error(`no resource at ${url}`);
  return new Parser().parse(
    typeof r.body === "string" ? r.body : Buffer.from(r.body).toString("utf8"),
  );
}

function collect(): { events: SweepAuditEvent[]; onEvent: (e: SweepAuditEvent) => void } {
  const events: SweepAuditEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

// =============================================================================
describe("reparseRawAnchor (bead a1) — channel-dispatching raw → BridgeMessage", () => {
  it("reconstructs a Slack message from its raw event", () => {
    const raw = slackEvent();
    const m = reparseRawAnchor({ channel: "slack", raw, messageId: "C111:1720000000.000100" });
    expect(m?.channel).toBe("slack");
    expect(m?.messageId).toBe("C111:1720000000.000100");
    expect(m?.textBody).toContain(MEETING);
  });

  it("reconstructs the RIGHT WhatsApp message from a multi-message delivery by wamid", () => {
    const raw = waDelivery([waText(WAMID_A, "first"), waText(WAMID_B, `meet ${MEETING}`)]);
    const a = reparseRawAnchor({ channel: "whatsapp", raw, messageId: WAMID_A });
    const b = reparseRawAnchor({ channel: "whatsapp", raw, messageId: WAMID_B });
    expect(a?.messageId).toBe(WAMID_A);
    expect(a?.textBody).toBe("first");
    expect(b?.messageId).toBe(WAMID_B);
    expect(b?.textBody).toContain(MEETING);
  });

  it("fails closed when no WhatsApp message carries the recovered id", () => {
    const raw = waDelivery([waText(WAMID_A, "hi")]);
    expect(reparseRawAnchor({ channel: "whatsapp", raw, messageId: WAMID_B })).toBeUndefined();
  });

  it("reconstructs an email message from its raw bytes", () => {
    const raw = emailRaw("m1@example.com", `meet ${MEETING}`);
    const m = reparseRawAnchor({ channel: "email", raw, messageId: "m1@example.com" });
    expect(m?.channel).toBe("email");
    expect(m?.textBody).toContain(MEETING);
  });

  it("fails closed on an unknown channel and on hostile/malformed anchors", () => {
    expect(
      reparseRawAnchor({ channel: "carrier-pigeon", raw: "{}", messageId: "x" }),
    ).toBeUndefined();
    expect(reparseRawAnchor({ channel: "slack", raw: "not json", messageId: "x" })).toBeUndefined();
    expect(reparseRawAnchor({ channel: "whatsapp", raw: "{}", messageId: "x" })).toBeUndefined();
    expect(reparseRawAnchor({ channel: "whatsapp", raw: "[]", messageId: "y" })).toBeUndefined();
  });

  it("refuses a WhatsApp delivery over the fan-out cap (fail closed)", () => {
    const many = Array.from({ length: 5 }, (_, i) => waText(`${WAMID_A}${i}`, "x"));
    const raw = waDelivery(many);
    expect(
      reparseRawAnchor({
        channel: "whatsapp",
        raw,
        messageId: `${WAMID_A}0`,
        maxMessagesPerDelivery: 2,
      }),
    ).toBeUndefined();
  });
});

describe("slugToMessageId — the reversible-slug integrity guard", () => {
  it("round-trips messageSlug for arbitrary ids", () => {
    for (const id of ["C111:1720000000.000100", WAMID_A, "m1@example.com", "a/b+c=d"]) {
      expect(slugToMessageId(messageSlug(id))).toBe(id);
    }
  });
  it("fails closed on a bad prefix, bad base64, or non-string", () => {
    expect(slugToMessageId("nope-abc")).toBeUndefined();
    expect(slugToMessageId("alb-not+valid")).toBeUndefined(); // `+` not in the url alphabet
    expect(slugToMessageId("alb-")).toBeUndefined();
    expect(slugToMessageId(undefined)).toBeUndefined();
  });
});

// =============================================================================
describe("sweepPendingInterpretations — happy paths (CAS If-Match, all channels)", () => {
  it("sweeps a Slack Pending resource → Interpreted, adding the LLM interpretation", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    const originalReceived = quadsOf(pod, docUrl).find(
      (q) => q.predicate.value === `${SCHEMA}dateReceived`,
    )?.object.value;

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      writeFetch: pod.fetch,
      extractor: echoMeeting,
      interpretingAgentWebId: INTERPRETER_WEBID,
      onEvent,
    });

    expect(result.pending).toBe(1);
    expect(result.interpreted).toBe(1);
    expect(result.skipped + result.conflicted + result.failed + result.retried).toBe(0);

    const quads = quadsOf(pod, docUrl);
    // Status flipped to Interpreted.
    const status = quads.find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`);
    expect(status?.object.value).toBe(`${AGENTIC}Interpreted`);
    // The LLM interpretation is present (an LlmInterpretation method quad).
    expect(
      quads.some(
        (q) =>
          q.predicate.value === `${AGENTIC}interpretationMethod` &&
          q.object.value === `${AGENTIC}LlmInterpretation`,
      ),
    ).toBe(true);
    // Provenance: attributed to the bridge-interpreter identity.
    expect(
      quads.some(
        (q) =>
          q.predicate.value === `${PROV}wasAssociatedWith` && q.object.value === INTERPRETER_WEBID,
      ),
    ).toBe(true);
    // The ORIGINAL received time is preserved (not overwritten with the sweep time).
    expect(quads.find((q) => q.predicate.value === `${SCHEMA}dateReceived`)?.object.value).toBe(
      originalReceived,
    );
    // Interpreted resources carry no retry counter.
    expect(quads.some((q) => q.predicate.value === `${AGENTIC}interpretationAttempts`)).toBe(false);
    // The raw anchor + chat resource were NEVER rewritten (only the graph mutated).
    expect(pod.writes.filter((u) => u.endsWith(".json")).length).toBe(1); // the seed write only
    expect(pod.writes.filter((u) => u.endsWith(".chat.ttl")).length).toBe(1);
    expect(pod.writes.filter((u) => u.endsWith(".ttl") && !u.endsWith(".chat.ttl")).length).toBe(2); // seed + sweep
    // No ACL was ever written by the sweep (Control-free).
    expect(pod.writes.some((u) => u.endsWith(".acl"))).toBe(false);
    // A privacy-safe interpreted counter fired.
    expect(events.some((e) => e.kind === "interpreted")).toBe(true);
  });

  it("sweeps an email Pending resource → Interpreted (channel dispatch)", async () => {
    const pod = makeFakePod();
    const raw = emailRaw("m2@example.com", `meet ${MEETING}`);
    const message = parseEmailInbound({ id: "m2@example.com", raw });
    const { docUrl } = await seedPending(pod, { message, raw });
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
  });

  it("sweeps each message of a multi-message WhatsApp delivery, matched by wamid", async () => {
    const pod = makeFakePod();
    const raw = waDelivery([waText(WAMID_A, `meet ${MEETING}`), waText(WAMID_B, "yes")]);
    const delivery = parseWhatsAppDelivery(raw);
    for (let i = 0; i < delivery.total; i++) {
      await seedPending(pod, { message: delivery.messageAt(i), raw });
    }
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    expect(result.pending).toBe(2);
    expect(result.interpreted).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("marks a no-extractable-content message Interpreted (model up, nothing to add)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent({ text: "thanks!" });
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: emptyExtractor,
    });
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
  });
});

// =============================================================================
describe("sweepPendingInterpretations — attack surface (fail-closed)", () => {
  it("a concurrent-sweep lost CAS is a benign no-op (no double-write)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    // A competing writer commits BETWEEN the sweep's GET and PUT, bumping the ETag so the
    // sweep's If-Match fails (412). Its content must survive untouched.
    let raced = false;
    const competing = "@prefix agentic: <https://w3id.org/jeswr/agentic#> .\n# concurrent winner\n";
    const writeFetch = (async (url: string | URL, init: RequestInit = {}) => {
      if (!raced && String(url) === docUrl && (init.method ?? "GET").toUpperCase() === "PUT") {
        raced = true;
        pod.force(docUrl, competing);
      }
      return pod.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;

    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      writeFetch,
      extractor: echoMeeting,
    });
    expect(result.conflicted).toBe(1);
    expect(result.interpreted).toBe(0);
    // The concurrent winner's bytes were NOT clobbered (no double-write / no lost update).
    const stored = pod.resources.get(docUrl);
    expect(typeof stored?.body === "string" ? stored.body : "").toBe(competing);
  });

  it("a tampered anchor (parses to a DIFFERENT id) is refused by the slug round-trip", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    const before = pod.resources.get(docUrl)?.body;

    // Swap the raw anchor for a valid Slack event with a DIFFERENT ts → different messageId
    // than the slug encodes. The reconstruction must not be attributed to this resource.
    const rawUrl = docUrl.replace(/\.ttl$/, ".json");
    pod.force(
      rawUrl,
      slackEvent({ ts: "1799999999.999999", text: "attacker text" }),
      "application/json",
    );

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "slug-mismatch")).toBe(true);
    // The graph was NOT rewritten.
    expect(pod.resources.get(docUrl)?.body).toBe(before);
  });

  it("a corrupted anchor (same id, different bytes) is refused by the digest guard", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    const before = pod.resources.get(docUrl)?.body;

    // Same ts/channel (⇒ same messageId ⇒ slug still round-trips) but different text ⇒ the
    // bytes no longer hash to the digest the graph committed to → digest-mismatch.
    const rawUrl = docUrl.replace(/\.ttl$/, ".json");
    pod.force(rawUrl, slackEvent({ text: "swapped body, same id" }), "application/json");

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    expect(result.skipped).toBe(1);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "digest-mismatch")).toBe(true);
    expect(pod.resources.get(docUrl)?.body).toBe(before);
  });

  it("a hostile model name cannot inject RDF/IRIs into the written graph (slot containment)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    const injectingExtractor: LlmExtractor = scriptedExtractor({
      "meeting-times": () => ({
        items: [
          {
            startTime: MEETING,
            confidence: 0.99,
            sourceSpan: `meet at ${MEETING}`,
            name: "Evil> ] . <urn:attacker:s> <urn:attacker:p> <urn:attacker:o> . <#x",
          },
        ],
      }),
      "action-items": () => ({ items: [] }),
      "reply-polarity": () => ({ items: [] }),
    });

    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: injectingExtractor,
    });
    expect(result.interpreted).toBe(1);
    const quads = quadsOf(pod, docUrl); // parses cleanly (no Turtle breakout)
    // No attacker triple was injected: `urn:attacker:*` NEVER appears as a NamedNode term
    // (subject/predicate/object) — only, harmlessly, INSIDE a literal's lexical value.
    const attackerAsIri = quads.some(
      (q) =>
        (q.subject.termType === "NamedNode" && q.subject.value.includes("urn:attacker")) ||
        (q.predicate.termType === "NamedNode" && q.predicate.value.includes("urn:attacker")) ||
        (q.object.termType === "NamedNode" && q.object.value.includes("urn:attacker")),
    );
    expect(attackerAsIri).toBe(false);
    // The hostile string landed INSIDE one asserted-object LITERAL (never as triples).
    const hostileLiteral = quads.find(
      (q) =>
        q.predicate.value === `${AGENTIC}assertsObject` &&
        q.object.termType === "Literal" &&
        q.object.value.includes("urn:attacker:s"),
    );
    expect(hostileLiteral).toBeDefined();
    expect(hostileLiteral?.object.termType).toBe("Literal");
    // The descriptive name is capped SelfReported, never bare-asserted / auto.
    const nameInterp = hostileLiteral?.subject.value;
    expect(
      quads.some(
        (q) =>
          q.subject.value === nameInterp &&
          q.predicate.value === `${AGENTIC}calibration` &&
          q.object.value === `${AGENTIC}SelfReported`,
      ),
    ).toBe(true);
  });

  it("a low-confidence (unsourced) datum stays reified/audited, never bare-asserted", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    // sourceSpan does NOT appear in the body ⇒ calibrate → AUDIT_FLOOR / SelfReported.
    const unsourced: LlmExtractor = scriptedExtractor({
      "meeting-times": () => ({
        items: [
          { startTime: MEETING, confidence: 0.99, sourceSpan: "a span not in the body at all" },
        ],
      }),
      "action-items": () => ({ items: [] }),
      "reply-polarity": () => ({ items: [] }),
    });
    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: unsourced,
    });
    const quads = quadsOf(pod, docUrl);
    // The datum is reified under an agentic:Interpretation with a low confidence, and
    // schema:startTime NEVER appears as a bare predicate on the event subject.
    const llmInterp = quads.find(
      (q) =>
        q.predicate.value === `${AGENTIC}interpretationMethod` &&
        q.object.value === `${AGENTIC}LlmInterpretation`,
    )?.subject.value;
    expect(llmInterp).toBeDefined();
    const conf = quads.find(
      (q) => q.subject.value === llmInterp && q.predicate.value === `${AGENTIC}confidence`,
    );
    expect(Number(conf?.object.value)).toBeLessThanOrEqual(0.3);
    // No bare `<...#llm-meeting-1> schema:startTime` assertion exists anywhere.
    expect(
      quads.some(
        (q) =>
          q.predicate.value === `${SCHEMA}startTime` && q.subject.value.includes("llm-meeting"),
      ),
    ).toBe(false);
  });

  it("never fetches an out-of-container ldp:contains target (SSRF guard)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    await seedPending(pod, { message, raw });
    // A hostile listing entry pointing off-origin — the sweep must NEVER GET it.
    pod.extraContains.push("https://evil.example/exfil.ttl");
    pod.extraContains.push("https://pod.example/other/escape.ttl");

    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    expect(pod.reads.some((u) => u.startsWith("https://evil.example/"))).toBe(false);
    expect(pod.reads.some((u) => u.startsWith("https://pod.example/other/"))).toBe(false);
  });

  it("skips a resource with an un-reversible slug (fail closed), still sweeps the good one", async () => {
    const pod = makeFakePod();
    const good = slackEvent();
    await seedPending(pod, { message: slackEventToBridgeMessage(good), raw: good });
    // A second Pending resource written to a bad-slug URL (`+` is not the url alphabet).
    const bad = slackEvent({ ts: "1720000001.000200", text: `meet ${MEETING}` });
    await seedPending(pod, {
      message: slackEventToBridgeMessage(bad),
      raw: bad,
      baseUrlFor: () => `${CONTAINER}alb-invalid+slug`,
    });

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    expect(result.interpreted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "bad-slug")).toBe(true);
  });
});

// =============================================================================
describe("sweepPendingInterpretations — bounded retry (pod-as-state)", () => {
  it("increments attempts and stays Pending on a wholly-failed LLM pass (retry)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: throwingExtractor,
      maxAttempts: 3,
      onEvent,
    });
    expect(result.retried).toBe(1);
    expect(result.interpreted).toBe(0);
    const quads = quadsOf(pod, docUrl);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)?.object.value,
    ).toBe(`${AGENTIC}Pending`);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationAttempts`)?.object.value,
    ).toBe("1");
    expect(events.some((e) => e.kind === "retry" && e.attempts === 1)).toBe(true);
  });

  it("reaches the terminal InterpretationFailed at the cap (no infinite loop)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    // Three failing sweeps with cap=3: 0→1 (retry), 1→2 (retry), 2→3≥cap (failed).
    for (let i = 0; i < 3; i++) {
      await sweepPendingInterpretations({
        container: CONTAINER,
        readFetch: pod.fetch,
        extractor: throwingExtractor,
        maxAttempts: 3,
      });
    }
    const quads = quadsOf(pod, docUrl);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)?.object.value,
    ).toBe(`${AGENTIC}InterpretationFailed`);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationAttempts`)?.object.value,
    ).toBe("3");

    // A terminal (failed) resource is NEVER re-swept.
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxAttempts: 3,
    });
    expect(result.pending).toBe(0);
  });

  it("resumes a Pending(+1) resource to Interpreted once the model recovers", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: throwingExtractor,
      maxAttempts: 5,
    });
    // The model recovers — the still-Pending(+1) resource is picked up and completed.
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxAttempts: 5,
    });
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
  });

  it("a partial pass persists NO LLM datum (retry-until-clean); a clean pass persists all", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    // meeting-times succeeds; action-items throws (a transient per-task outage); reply clean.
    const partial: LlmExtractor = async ({ task }) => {
      if (task === "meeting-times") {
        return {
          items: [{ startTime: MEETING, confidence: 0.9, sourceSpan: `meet at ${MEETING}` }],
        };
      }
      if (task === "action-items") throw new Error("action extractor timeout");
      return { items: [] };
    };
    const first = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: partial,
      maxAttempts: 5,
    });
    // A warning ⇒ the resource stays Pending (retry), NOT prematurely finalized.
    expect(first.retried).toBe(1);
    expect(first.interpreted).toBe(0);
    const quads = quadsOf(pod, docUrl);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)?.object.value,
    ).toBe(`${AGENTIC}Pending`);
    // No LLM datum is persisted on a non-clean pass — so a later retry can never DROP an
    // earlier pass's partial result (the all-or-nothing invariant that closed the round-2
    // finding). Only the deterministic interpretations (webhook-written) remain.
    expect(
      quads.some(
        (q) =>
          q.predicate.value === `${AGENTIC}interpretationMethod` &&
          q.object.value === `${AGENTIC}LlmInterpretation`,
      ),
    ).toBe(false);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationAttempts`)?.object.value,
    ).toBe("1");

    // Next tick the failed task recovers ⇒ a CLEAN pass finalizes to Interpreted and persists
    // the COMPLETE LLM set atomically.
    const second = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxAttempts: 5,
    });
    expect(second.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).some(
        (q) =>
          q.predicate.value === `${AGENTIC}interpretationMethod` &&
          q.object.value === `${AGENTIC}LlmInterpretation`,
      ),
    ).toBe(true);
  });
});

// =============================================================================
describe("sweepPendingInterpretations — bounds + selectivity", () => {
  it("does not re-sweep an already-Interpreted resource (S4 monotonicity)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    await seedPending(pod, { message, raw });
    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    // A second sweep finds nothing Pending.
    const second = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    expect(second.pending).toBe(0);
    expect(second.interpreted).toBe(0);
  });

  it("skips a Pending resource without an ETag (CAS impossible → fail closed)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    // A no-ETag read fetch (some legacy servers omit it) — the CAS write is impossible.
    const noEtagFetch = (async (url: string | URL, init: RequestInit = {}) => {
      const res = await pod.fetch(url, init);
      if ((init.method ?? "GET").toUpperCase() === "GET" && String(url) === docUrl) {
        const h = new Headers(res.headers);
        h.delete("etag");
        return new Response(await res.text(), { status: res.status, headers: h });
      }
      return res;
    }) as unknown as typeof globalThis.fetch;

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: noEtagFetch,
      writeFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "no-etag")).toBe(true);
  });

  it("respects maxResourcesPerSweep (the rest wait for the next tick)", async () => {
    const pod = makeFakePod();
    for (let i = 0; i < 4; i++) {
      const raw = slackEvent({ ts: `172000000${i}.000100`, text: `meet ${MEETING}` });
      await seedPending(pod, { message: slackEventToBridgeMessage(raw), raw });
    }
    const first = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxResourcesPerSweep: 2,
    });
    expect(first.examined).toBe(2);
    expect(first.interpreted).toBe(2);
    // The remaining two are still Pending and swept next tick.
    const second = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxResourcesPerSweep: 10,
    });
    expect(second.interpreted).toBe(2);
  });

  it("does NOT starve a pending resource behind a prefix of non-pending ones (roborev)", async () => {
    const pod = makeFakePod();
    // Seed + fully interpret THREE resources (they become non-pending), THEN add a pending
    // one AFTER them in the stable listing. With a budget of 1 on EXAMINED candidates this
    // pending resource would never be reached; with the budget on PENDING PROCESSED it is.
    for (let i = 0; i < 3; i++) {
      const r = slackEvent({ ts: `172000010${i}.000100`, text: `meet ${MEETING}` });
      await seedPending(pod, { message: slackEventToBridgeMessage(r), raw: r });
    }
    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    // Now 3 Interpreted; add a 4th, still-Pending resource at the END of the listing.
    const late = slackEvent({ ts: "1720000199.000100", text: `meet ${MEETING}` });
    const { docUrl } = await seedPending(pod, {
      message: slackEventToBridgeMessage(late),
      raw: late,
    });

    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxResourcesPerSweep: 1, // a tiny budget — must still reach the late pending resource
    });
    expect(result.examined).toBe(4); // scanned PAST the 3 non-pending
    expect(result.pending).toBe(1);
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
  });

  it("a permanently-skipping Pending resource does NOT consume the budget (no starvation)", async () => {
    const pod = makeFakePod();
    // A BAD Pending resource FIRST in the listing: corrupt its raw anchor (same id ⇒ slug
    // still round-trips, different bytes ⇒ digest-mismatch) so it skips on EVERY sweep.
    const bad = slackEvent({ ts: "1720000050.000100", text: `meet ${MEETING}` });
    const { docUrl: badUrl } = await seedPending(pod, {
      message: slackEventToBridgeMessage(bad),
      raw: bad,
    });
    pod.force(
      badUrl.replace(/\.ttl$/, ".json"),
      slackEvent({ ts: "1720000050.000100", text: "corrupted body, same id" }),
      "application/json",
    );
    // A VALID Pending resource AFTER it in the listing.
    const good = slackEvent({ ts: "1720000051.000100", text: `meet ${MEETING}` });
    const { docUrl: goodUrl } = await seedPending(pod, {
      message: slackEventToBridgeMessage(good),
      raw: good,
    });

    // With a budget of 1: the permanent skip must NOT consume it — the valid resource is
    // still reached and interpreted (the round-2 starvation-via-budget finding).
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxResourcesPerSweep: 1,
    });
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, goodUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
  });

  it("content-negotiates for RDF — a conneg (HTML-defaulting) server does not abort the sweep", async () => {
    // This pod returns its HTML view for an RDF read UNLESS the Accept header requests RDF.
    const pod = makeFakePod({ conneg: true });
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });

    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    // The sweep sent an RDF Accept, so it got Turtle (not HTML) and interpreted normally.
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
    // Every RDF read (the container + the .ttl graph) carried an RDF Accept header.
    const rdfReads = pod.accepts.filter((a) => a.url.endsWith("/") || a.url.endsWith(".ttl"));
    expect(rdfReads.length).toBeGreaterThan(0);
    expect(rdfReads.every((a) => a.accept.includes("turtle") || a.accept.includes("ld+json"))).toBe(
      true,
    );
  });

  it.each([
    "weak",
    "malformed",
  ] as const)("skips a %s-ETag resource BEFORE the model call (no perpetual-412 budget burn)", async (etagStyle) => {
    // A server that returns only non-strong validators (`W/"…"` weak, or an unquoted bare
    // token) — neither usable with `If-Match` strong comparison.
    const pod = makeFakePod({ etagStyle });
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    await seedPending(pod, { message, raw });

    let extractorCalls = 0;
    const spy: LlmExtractor = async () => {
      extractorCalls++;
      return { items: [] };
    };
    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: spy,
      onEvent,
    });
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0);
    // Fail-closed BEFORE any model call — a non-strong validator never burns model budget.
    expect(extractorCalls).toBe(0);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "no-strong-etag")).toBe(true);
  });

  it("a CAS write-failure CONSUMES the budget (a write-failing pod can't burn model calls)", async () => {
    const pod = makeFakePod();
    // Two valid Pending resources.
    for (let i = 0; i < 2; i++) {
      const r = slackEvent({ ts: `172000030${i}.000100`, text: `meet ${MEETING}` });
      await seedPending(pod, { message: slackEventToBridgeMessage(r), raw: r });
    }
    // A write-fetch whose graph PUTs always fail (500) — the model runs but the write fails.
    const failingWrite = (async (url: string | URL, init: RequestInit = {}) => {
      if ((init.method ?? "GET").toUpperCase() === "PUT" && String(url).endsWith(".ttl")) {
        return new Response(null, { status: 500 });
      }
      return pod.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;

    let extractorCalls = 0;
    const spy: LlmExtractor = async () => {
      extractorCalls++;
      return { items: [] };
    };
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      writeFetch: failingWrite,
      extractor: spy,
      maxResourcesPerSweep: 1, // a write-failure MUST consume this budget
    });
    // Only ONE resource was EXAMINED (the write-failure consumed the budget and stopped the
    // sweep) — the model did NOT run for the 2nd pending resource despite the write failures.
    expect(result.examined).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0);
    expect(extractorCalls).toBeGreaterThan(0); // the model DID run for the one processed
  });

  it("a THROWN write error (post-model) also consumes the budget", async () => {
    const pod = makeFakePod();
    for (let i = 0; i < 2; i++) {
      const r = slackEvent({ ts: `172000040${i}.000100`, text: `meet ${MEETING}` });
      await seedPending(pod, { message: slackEventToBridgeMessage(r), raw: r });
    }
    // A write-fetch that THROWS on the graph PUT (a network error after the model ran).
    const throwingWrite = (async (url: string | URL, init: RequestInit = {}) => {
      if ((init.method ?? "GET").toUpperCase() === "PUT" && String(url).endsWith(".ttl")) {
        throw new Error("network down");
      }
      return pod.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;

    let extractorCalls = 0;
    const spy: LlmExtractor = async () => {
      extractorCalls++;
      return { items: [] };
    };
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      writeFetch: throwingWrite,
      extractor: spy,
      maxResourcesPerSweep: 1,
    });
    expect(result.examined).toBe(1); // the thrown write is budget-consuming, not a free skip
    expect(result.skipped).toBe(1);
    expect(extractorCalls).toBeGreaterThan(0);
  });

  it("treats a MALFORMED interpretationAttempts literal as 0 (canonical-integer only)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const slug = messageSlug(message.messageId as string);
    const docUrl = `${CONTAINER}${slug}.ttl`;
    const rawUrl = `${CONTAINER}${slug}.json`;
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "slack",
      docIri: docUrl,
      rawMessageIri: mintUrn("raw", message.rawSha256),
      rawResourceIri: rawUrl,
      rawMediaType: "application/json",
      interpretations: [],
      interpretationStatus: "pending",
      interpretationAttempts: 42,
    });
    // Corrupt the counter (serialised as the bare Turtle integer `42`) to a non-canonical
    // value that `parseInt` would have accepted as 42.
    const corrupted = turtle.replace(
      /agentic:interpretationAttempts 42\b/,
      'agentic:interpretationAttempts "42abc"',
    );
    expect(corrupted).toContain('"42abc"');
    pod.force(docUrl, corrupted);
    pod.force(rawUrl, raw, "application/json");

    // A failed attempt must increment from 0 (malformed ⇒ 0), i.e. become "1" — NOT "43".
    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: throwingExtractor,
      maxAttempts: 5,
    });
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationAttempts`)
        ?.object.value,
    ).toBe("1");
  });

  it("ignores a WRONG-DATATYPE interpretationAttempts (valid lexical, xsd:string ⇒ 0)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const slug = messageSlug(message.messageId as string);
    const docUrl = `${CONTAINER}${slug}.ttl`;
    const rawUrl = `${CONTAINER}${slug}.json`;
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "slack",
      docIri: docUrl,
      rawMessageIri: mintUrn("raw", message.rawSha256),
      rawResourceIri: rawUrl,
      rawMediaType: "application/json",
      interpretations: [],
      interpretationStatus: "pending",
      interpretationAttempts: 7,
    });
    // A plain STRING "999" (a valid integer LEXICAL but datatype xsd:string, not xsd:integer)
    // must NOT be trusted as a near-cap counter — it reads as 0.
    const tampered = turtle.replace(
      /agentic:interpretationAttempts 7\b/,
      'agentic:interpretationAttempts "999"',
    );
    expect(tampered).toContain('"999"');
    pod.force(docUrl, tampered);
    pod.force(rawUrl, raw, "application/json");

    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: throwingExtractor,
      maxAttempts: 5,
    });
    // Read as 0 (wrong datatype), incremented to "1" — NOT "1000", and NOT prematurely failed.
    const quads = quadsOf(pod, docUrl);
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationAttempts`)?.object.value,
    ).toBe("1");
    expect(
      quads.find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)?.object.value,
    ).toBe(`${AGENTIC}Pending`);
  });

  it("does not count an unrelated (anchorless) .ttl as a Pending skip (not-pending)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    await seedPending(pod, { message: slackEventToBridgeMessage(raw), raw });
    // An unrelated `.ttl` with no bridge anchor — must be `not-pending`, never a Pending skip.
    pod.force(
      `${CONTAINER}unrelated.ttl`,
      "@prefix ex: <https://example.org/> .\n<#a> ex:p ex:o .\n",
    );

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    expect(result.interpreted).toBe(1);
    expect(result.pending).toBe(1); // only the real one — the unrelated .ttl is not counted
    expect(result.skipped).toBe(0);
    expect(events.some((e) => e.kind === "skipped")).toBe(false);
  });

  it("FAILS CLOSED on a present-but-out-of-inbox schema:url (never derives a sibling)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const slug = messageSlug(message.messageId as string);
    const docUrl = `${CONTAINER}${slug}.ttl`;
    const siblingAnchor = `${CONTAINER}${slug}.json`; // a VALID sibling anchor DOES exist
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "slack",
      docIri: docUrl,
      rawMessageIri: mintUrn("raw", message.rawSha256),
      rawResourceIri: "https://evil.example/anchor.json", // schema:url points OUTSIDE the inbox
      rawMediaType: "application/json",
      interpretations: [],
      interpretationStatus: "pending",
    });
    pod.force(docUrl, turtle);
    pod.force(siblingAnchor, raw, "application/json");

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    // A tampered pointer fails closed — it is NOT swept via the derived sibling.
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "unsafe-raw-url")).toBe(true);
    // The out-of-inbox pointer is never fetched (SSRF), and the sibling was never used.
    expect(pod.reads.some((u) => u.startsWith("https://evil.example/"))).toBe(false);
    expect(pod.reads).not.toContain(siblingAnchor);
  });

  it("FAILS CLOSED on a schema:url that is a LITERAL (not a NamedNode) — never derives a sibling", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const slug = messageSlug(message.messageId as string);
    const docUrl = `${CONTAINER}${slug}.ttl`;
    const siblingAnchor = `${CONTAINER}${slug}.json`; // a VALID sibling anchor DOES exist
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "slack",
      docIri: docUrl,
      rawMessageIri: mintUrn("raw", message.rawSha256),
      rawResourceIri: siblingAnchor,
      rawMediaType: "application/json",
      interpretations: [],
      interpretationStatus: "pending",
    });
    // Tamper the provenance pointer into a LITERAL (a present-but-invalid `schema:url`).
    const tampered = turtle.replace(/schema:url <[^>]*>/, 'schema:url "tampered-not-a-url"');
    expect(tampered).toContain('schema:url "tampered-not-a-url"');
    pod.force(docUrl, tampered);
    pod.force(siblingAnchor, raw, "application/json");

    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent,
    });
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0); // NOT swept via the derived sibling
    expect(events.some((e) => e.kind === "skipped" && e.reason === "unsafe-raw-url")).toBe(true);
    expect(pod.reads).not.toContain(siblingAnchor); // the sibling was never fetched
  });

  it("a THROWING onEvent callback cannot abort the sweep (observability is isolated)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const { docUrl } = await seedPending(pod, { message: slackEventToBridgeMessage(raw), raw });
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      onEvent: () => {
        throw new Error("telemetry sink down");
      },
    });
    // The throwing audit callback is swallowed — the sweep still interprets + writes.
    expect(result.interpreted).toBe(1);
    expect(
      quadsOf(pod, docUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
  });

  it("operates in the TWO-CONTAINER layout: graphs in graphsContainer, anchor read-only in the inbox", async () => {
    const pod = makeFakePod();
    const graphsC = "https://pod.example/graphs/"; // a SIBLING graphs container
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const slug = messageSlug(message.messageId as string);
    const anchorUrl = `${CONTAINER}${slug}.json`; // anchor lives in the INBOX
    const graphUrl = `${graphsC}${slug}.ttl`; // graph lives in the GRAPHS container
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "slack",
      docIri: graphUrl,
      rawMessageIri: mintUrn("raw", message.rawSha256),
      rawResourceIri: anchorUrl, // schema:url points at the inbox anchor
      rawMediaType: "application/json",
      interpretations: [],
      interpretationStatus: "pending",
    });
    pod.force(graphUrl, turtle);
    pod.force(anchorUrl, raw, "application/json");

    const result = await sweepPendingInterpretations({
      container: CONTAINER, // inbox (anchors)
      graphsContainer: graphsC, // graphs
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    expect(result.interpreted).toBe(1);
    // The graph (in the graphs container) was CAS-replaced to Interpreted.
    expect(
      quadsOf(pod, graphUrl).find((q) => q.predicate.value === `${AGENTIC}interpretationStatus`)
        ?.object.value,
    ).toBe(`${AGENTIC}Interpreted`);
    // The raw anchor (in the inbox) was READ but NEVER written by the sweep (immutable).
    expect(pod.writes).not.toContain(anchorUrl);
    expect(pod.writes).toContain(graphUrl); // only the graph was written
  });

  it("does NOT parse a graph as JSON-LD — no remote @context SSRF (Turtle-only)", async () => {
    const pod = makeFakePod();
    // A JSON-LD body referencing a REMOTE @context. If the sweep let `parseRdf` dispatch on the
    // ld+json content-type, the JSON-LD parser would dereference it via its OWN global fetch
    // (bypassing the injected guarded readFetch) — an SSRF. The sweep forces a Turtle parse, so
    // this body simply fails to parse and the resource is skipped; the context is never fetched.
    const jsonld = JSON.stringify({
      "@context": "https://evil.example/malicious-context.jsonld",
      "@id": "urn:agentic:raw:x",
      "@type": "https://w3id.org/jeswr/agentic#RawInboundMessage",
    });
    pod.force(`${CONTAINER}alb-jsonld.ttl`, jsonld, "application/ld+json");

    // Any GLOBAL fetch (the JSON-LD parser's context loader path) is blocked + observed.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 599 }));
    try {
      const result = await sweepPendingInterpretations({
        container: CONTAINER,
        readFetch: pod.fetch,
        extractor: echoMeeting,
      });
      expect(result.interpreted).toBe(0); // the JSON-LD body is not Turtle → skipped
      const hitEvil = fetchSpy.mock.calls.some(([u]) => String(u).includes("evil.example"));
      expect(hitEvil).toBe(false); // the remote @context was NEVER dereferenced (no SSRF)
    } finally {
      fetchSpy.mockRestore();
    }
    expect(pod.reads.some((u) => u.includes("evil.example"))).toBe(false);
  });

  it("BOUNDS the raw-anchor read — an over-cap anchor is skipped (no unbounded read)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    await seedPending(pod, { message: slackEventToBridgeMessage(raw), raw });
    const { events, onEvent } = collect();
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxRawAnchorBytes: 5, // the slack-event anchor is far larger than 5 bytes ⇒ refused
      onEvent,
    });
    expect(result.skipped).toBe(1);
    expect(result.interpreted).toBe(0);
    expect(events.some((e) => e.kind === "skipped" && e.reason === "raw-fetch-failed")).toBe(true);
  });

  it("BOUNDS the graph read — an over-cap .ttl is skipped, not materialised unbounded", async () => {
    const pod = makeFakePod();
    // A large `.ttl` (well over the cap) — the read is refused BEFORE parse; the listing (tiny)
    // stays under the cap so the sweep runs.
    pod.force(`${CONTAINER}alb-huge.ttl`, `# ${"x".repeat(4000)}\n`);
    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      maxGraphBytes: 1000, // the huge graph exceeds this; the small container listing does not
    });
    expect(result.interpreted).toBe(0);
    expect(result.skipped).toBe(1); // the over-cap graph read throws → free skip
  });

  it("does NOT sweep a graph with MULTIPLE interpretationStatus values (S4, fail-closed)", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const slug = messageSlug(message.messageId as string);
    const docUrl = `${CONTAINER}${slug}.ttl`;
    const rawUrl = `${CONTAINER}${slug}.json`;
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "slack",
      docIri: docUrl,
      rawMessageIri: mintUrn("raw", message.rawSha256),
      rawResourceIri: rawUrl,
      rawMediaType: "application/json",
      interpretations: [],
      interpretationStatus: "pending",
    });
    // Inject a SECOND, terminal status value — a tampered/malformed graph. RDF is unordered, so
    // the sweep must NOT resolve `Pending` by encounter order and re-sweep a terminal resource.
    const multi = turtle.replace("agentic:Pending", "agentic:Pending, agentic:Interpreted");
    expect(multi).toContain("agentic:Interpreted");
    pod.force(docUrl, multi);
    pod.force(rawUrl, raw, "application/json");

    const result = await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
    });
    expect(result.pending).toBe(0); // multi-status ⇒ not-pending (fail closed)
    expect(result.interpreted).toBe(0);
  });

  it("rejects an unsafe container / graphsContainer (fail closed)", async () => {
    const pod = makeFakePod();
    await expect(
      sweepPendingInterpretations({
        container: "https://pod.example/inbox",
        readFetch: pod.fetch,
        extractor: echoMeeting,
      }),
    ).rejects.toThrow();
    await expect(
      sweepPendingInterpretations({
        container: CONTAINER,
        graphsContainer: "https://pod.example/graphs", // no trailing slash
        readFetch: pod.fetch,
        extractor: echoMeeting,
      }),
    ).rejects.toThrow();
  });

  it("carries the reliability envelope through: the LLM datum is a full reified interpretation", async () => {
    const pod = makeFakePod();
    const raw = slackEvent();
    const message = slackEventToBridgeMessage(raw);
    const { docUrl } = await seedPending(pod, { message, raw });
    await sweepPendingInterpretations({
      container: CONTAINER,
      readFetch: pod.fetch,
      extractor: echoMeeting,
      model: "test-model:v1",
    });
    const quads = quadsOf(pod, docUrl);
    const interp = quads.find(
      (q) =>
        q.predicate.value === `${AGENTIC}interpretationMethod` &&
        q.object.value === `${AGENTIC}LlmInterpretation`,
    )?.subject.value;
    // confidence + calibration + reified subject/predicate/object all present.
    for (const p of ["confidence", "calibration", "assertsSubject", "assertsPredicate"]) {
      expect(
        quads.some((q) => q.subject.value === interp && q.predicate.value === `${AGENTIC}${p}`),
      ).toBe(true);
    }
    // The opaque model tag is recorded on the activity.
    expect(
      quads.some(
        (q) => q.predicate.value === `${AGENTIC}model` && q.object.value === "test-model:v1",
      ),
    ).toBe(true);
  });
});
