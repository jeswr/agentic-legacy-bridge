// AUTHORED-BY Claude Fable 5
/** End-to-end Rule 1: parsed email → StructuredMetadataInterpreter / the full pass. */
import { describe, expect, it } from "vitest";
import { parseEmail } from "../email/parse.js";
import { deterministicInterpreter } from "../interpret.js";
import { buildReply } from "../reply.js";
import { RDF_TYPE, SCHEMA_PROPOSE_ACTION, SCHEMA_START_TIME } from "../vocab.js";
import {
  composeInterpreters,
  extractStructuredMetadata,
  structuredMetadataInterpreter,
} from "./interpreter.js";
import { SENT_AT_PATTERN_IRI } from "./patterns.js";

const CTX = { docIri: "https://pod.example/inbox/m.ttl", now: new Date("2026-07-04T00:00:00Z") };
const BOUNDARY = "b0undary";

const ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "DTSTART:20260708T140000Z",
  "SUMMARY:Sync call",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const LD_EVENT =
  '{"@context":"https://schema.org","@type":"Event","name":"Dinner","startDate":"2026-07-09T18:00:00Z"}';

function inviteEmail(): ReturnType<typeof parseEmail> {
  return parseEmail(
    [
      "From: alice@example.com",
      "Subject: Invite",
      `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
      "",
      `--${BOUNDARY}`,
      "Content-Type: text/plain",
      "",
      "Shall we also meet 2026-07-10T09:00:00Z?",
      `--${BOUNDARY}`,
      "Content-Type: text/html",
      "",
      `<html><script type="application/ld+json">${LD_EVENT}</script></html>`,
      `--${BOUNDARY}`,
      "Content-Type: text/calendar",
      "",
      ICS,
      `--${BOUNDARY}--`,
      "",
    ].join("\r\n"),
  );
}

describe("StructuredMetadataInterpreter (the sync Interpreter seam)", () => {
  it("extracts BOTH the JSON-LD event and the iCal event from one parsed email", () => {
    const out = structuredMetadataInterpreter.interpret(inviteEmail(), CTX);
    const starts = out
      .filter((i) => i.predicate === SCHEMA_START_TIME)
      .map((i) => (i.object.kind === "literal" ? i.object.value : ""));
    expect(starts).toContain("2026-07-09T18:00:00.000Z"); // JSON-LD
    expect(starts).toContain("2026-07-08T14:00:00.000Z"); // iCal
    for (const i of out) {
      expect(i.method).toBe("Deterministic");
    }
  });

  it("yields nothing on a plain-text-only message", () => {
    const msg = parseEmail("From: a@b.com\r\n\r\njust words, no metadata");
    expect(structuredMetadataInterpreter.interpret(msg, CTX)).toEqual([]);
  });
});

describe("composeInterpreters (structured first, prose fallback last)", () => {
  it("concatenates structured metadata with the textual deterministic reference", () => {
    const composed = composeInterpreters(structuredMetadataInterpreter, deterministicInterpreter);
    const out = composed.interpret(inviteEmail(), CTX);
    const starts = out
      .filter((i) => i.predicate === SCHEMA_START_TIME)
      .map((i) => (i.object.kind === "literal" ? i.object.value : ""));
    // Structured (JSON-LD + iCal) AND the prose-extracted ISO time all land.
    expect(starts).toContain("2026-07-09T18:00:00.000Z");
    expect(starts).toContain("2026-07-08T14:00:00.000Z");
    expect(starts).toContain("2026-07-10T09:00:00.000Z");
  });
});

describe("extractStructuredMetadata (the full verifier-aware pass)", () => {
  it("runs the AgenticReply extractor with the injected verifier and surfaces patterns", async () => {
    const built = await buildReply({
      inReplyTo: "urn:agentic:raw:abc",
      offeredTimes: [{ startTime: "2026-07-07T14:00:00Z" }],
      dateSent: "2026-07-05T09:12:00Z",
      issuer: "https://jeswr.org/agent",
      sign: (credential) => ({ ...credential, proof: { type: "DataIntegrityProof" } }),
    });
    // Deliver our own signed carrier back through the email path.
    const raw = [
      "From: agent@example.com",
      "Subject: Re: times",
      "Content-Type: text/html",
      "",
      `<html><body>${built.inlineHtml}</body></html>`,
      "",
    ].join("\r\n");
    const msg = parseEmail(raw);
    expect(msg.jsonLdBlocks).toHaveLength(1);

    const result = await extractStructuredMetadata(msg, CTX, {
      verify: (credential) => ({
        verified: "proof" in credential,
        issuer: typeof credential.issuer === "string" ? credential.issuer : undefined,
      }),
    });
    expect(result.agenticReplyVerified).toBe(true);
    expect(result.issuer).toBe("https://jeswr.org/agent");
    expect(result.patterns.map((p) => p.iri)).toContain(SENT_AT_PATTERN_IRI);
    const type = result.interpretations.find((i) => i.predicate === RDF_TYPE);
    expect(type?.object).toEqual({ kind: "iri", value: SCHEMA_PROPOSE_ACTION });
    expect(type?.calibration).toBe("Calibrated"); // verified → auto-lane-eligible
  });

  it("without a verifier the same carrier stays SelfReported", async () => {
    const built = await buildReply({
      inReplyTo: "urn:agentic:raw:abc",
      offeredTimes: [{ startTime: "2026-07-07T14:00:00Z" }],
    });
    const msg = parseEmail(
      `From: agent@example.com\r\nContent-Type: text/html\r\n\r\n<html>${built.inlineHtml}</html>\r\n`,
    );
    const result = await extractStructuredMetadata(msg, CTX);
    expect(result.agenticReplyVerified).toBe(false);
    const type = result.interpretations.find((i) => i.predicate === RDF_TYPE);
    expect(type?.calibration).toBe("SelfReported");
  });
});
