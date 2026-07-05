// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import type { Interpretation } from "../reliability.js";
import {
  RDF_TYPE,
  SCHEMA_DATE_SENT,
  SCHEMA_END_TIME,
  SCHEMA_EVENT,
  SCHEMA_EVENT_CANCELLED,
  SCHEMA_EVENT_STATUS,
  SCHEMA_LOCATION,
  SCHEMA_MESSAGE,
  SCHEMA_NAME,
  SCHEMA_START_TIME,
  SCHEMA_URL,
} from "../vocab.js";
import { extractJsonLdInterpretations, hasSchemaType, isSchemaOrgContext } from "./jsonld.js";

const CTX = { docIri: "https://pod.example/inbox/m.ttl" };

function find(out: readonly Interpretation[], predicate: string): Interpretation | undefined {
  return out.find((i) => i.predicate === predicate);
}

/** A realistic Gmail email-markup EventReservation block. */
const GMAIL_RESERVATION = JSON.stringify({
  "@context": "http://schema.org",
  "@type": "EventReservation",
  reservationNumber: "E123456789",
  reservationFor: {
    "@type": "Event",
    name: "Foo Fighters Concert",
    startDate: "2027-03-04T19:30:00-08:00",
    location: { "@type": "Place", name: "AT&T Park" },
    url: "https://example.com/tickets/123",
  },
});

describe("isSchemaOrgContext / hasSchemaType", () => {
  it("accepts the known schema.org context spellings", () => {
    for (const c of [
      "http://schema.org",
      "https://schema.org",
      "https://schema.org/",
      ["https://schema.org", { extra: "x" }],
      { "@vocab": "https://schema.org/" },
    ]) {
      expect(isSchemaOrgContext(c)).toBe(true);
    }
  });
  it("rejects unknown contexts (closed world — never guessed at)", () => {
    expect(isSchemaOrgContext("https://evil.example/context")).toBe(false);
    expect(isSchemaOrgContext(undefined)).toBe(false);
    expect(isSchemaOrgContext(["https://evil.example/x"])).toBe(false);
  });
  it("matches bare, prefixed and full-IRI type spellings", () => {
    expect(hasSchemaType({ "@type": "Event" }, "Event")).toBe(true);
    expect(hasSchemaType({ type: "schema:Event" }, "Event")).toBe(true);
    expect(hasSchemaType({ "@type": ["https://schema.org/Event"] }, "Event")).toBe(true);
    expect(hasSchemaType({ "@type": "NotAnEvent" }, "Event")).toBe(false);
  });
});

describe("extractJsonLdInterpretations (Rule 1a)", () => {
  it("maps a Gmail EventReservation at confidence 1.0 / Calibrated / Deterministic", () => {
    const out = extractJsonLdInterpretations([GMAIL_RESERVATION], CTX);
    const type = find(out, RDF_TYPE);
    expect(type?.object).toEqual({ kind: "iri", value: SCHEMA_EVENT });
    expect(type?.subject).toBe(`${CTX.docIri}#md-event-1`);
    const start = find(out, SCHEMA_START_TIME);
    expect(start?.object).toMatchObject({ kind: "literal", value: "2027-03-05T03:30:00.000Z" });
    expect(start?.confidence).toBe(1);
    expect(start?.calibration).toBe("Calibrated");
    expect(start?.method).toBe("Deterministic");
    expect(find(out, SCHEMA_NAME)?.object).toMatchObject({ value: "Foo Fighters Concert" });
    expect(find(out, SCHEMA_LOCATION)?.object).toMatchObject({ value: "AT&T Park" });
    expect(find(out, SCHEMA_URL)?.object).toEqual({
      kind: "iri",
      value: "https://example.com/tickets/123",
    });
  });

  it("maps a plain Event with startDate/endDate and eventStatus", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Standup",
      startDate: "2026-07-08T14:00:00Z",
      endDate: "2026-07-08T14:30:00Z",
      eventStatus: "https://schema.org/EventCancelled",
    });
    const out = extractJsonLdInterpretations([block], CTX);
    expect(find(out, SCHEMA_END_TIME)?.object).toMatchObject({ value: "2026-07-08T14:30:00.000Z" });
    expect(find(out, SCHEMA_EVENT_STATUS)?.object).toEqual({
      kind: "iri",
      value: SCHEMA_EVENT_CANCELLED,
    });
  });

  it("maps a schema:Message dateSent envelope (the inbound sent-at)", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Message",
      dateSent: "2026-07-05T09:12:00Z",
    });
    const out = extractJsonLdInterpretations([block], CTX);
    expect(find(out, RDF_TYPE)?.object).toEqual({ kind: "iri", value: SCHEMA_MESSAGE });
    expect(find(out, SCHEMA_DATE_SENT)?.object).toMatchObject({
      value: "2026-07-05T09:12:00.000Z",
    });
  });

  it("downgrades a zone-less time to 0.6/SelfReported with a note — never a confident instant", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      startDate: "2026-07-08T14:00:00",
    });
    const out = extractJsonLdInterpretations([block], CTX);
    const start = find(out, SCHEMA_START_TIME);
    expect(start?.confidence).toBe(0.6);
    expect(start?.calibration).toBe("SelfReported");
    expect(start?.note).toMatch(/timezone/i);
  });

  it("skips unknown contexts, AgenticReply carriers, and malformed JSON — fail-closed", () => {
    const wrongContext = JSON.stringify({
      "@context": "https://evil.example/ctx",
      "@type": "Event",
      startDate: "2026-07-08T14:00:00Z",
    });
    const agenticReply = JSON.stringify({
      "@context": "https://schema.org",
      type: ["AgenticReply"],
      credentialSubject: {},
    });
    expect(extractJsonLdInterpretations([wrongContext], CTX)).toEqual([]);
    expect(extractJsonLdInterpretations([agenticReply], CTX)).toEqual([]);
    expect(extractJsonLdInterpretations(["{not json", '"a string"', "42"], CTX)).toEqual([]);
    expect(extractJsonLdInterpretations(undefined, CTX)).toEqual([]);
  });

  it("drops hostile field values without aborting the rest (drop-the-field rule)", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "ok\u0007name", // BEL control char stripped by sanitisation
      startDate: "2026-02-31T10:00:00Z", // calendar overflow → dropped
      url: "javascript:alert(1)", // non-http(s) → dropped
      location: 42, // wrong type → dropped
      eventStatus: "https://evil.example/EventCancelled", // unknown status → dropped
    });
    const out = extractJsonLdInterpretations([block], CTX);
    expect(find(out, RDF_TYPE)).toBeDefined(); // the event itself still lands
    expect(find(out, SCHEMA_START_TIME)).toBeUndefined();
    expect(find(out, SCHEMA_URL)).toBeUndefined();
    expect(find(out, SCHEMA_LOCATION)).toBeUndefined();
    expect(find(out, SCHEMA_EVENT_STATUS)).toBeUndefined();
    expect(find(out, SCHEMA_NAME)?.object).toMatchObject({ value: "okname" });
  });

  it("survives a __proto__-keyed block without pollution", () => {
    const block =
      '{"@context":"https://schema.org","@type":"Event","__proto__":{"polluted":1},"startDate":"2026-07-08T14:00:00Z"}';
    const out = extractJsonLdInterpretations([block], CTX);
    expect(find(out, SCHEMA_START_TIME)).toBeDefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("caps events across blocks and nodes (a 100-event array cannot flood)", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      "@type": "Event",
      startDate: `2026-07-08T${String(i % 24).padStart(2, "0")}:00:00Z`,
    }));
    const block = JSON.stringify(events.map((e) => ({ "@context": "https://schema.org", ...e })));
    const out = extractJsonLdInterpretations([block], CTX);
    const types = out.filter((i) => i.predicate === RDF_TYPE);
    expect(types.length).toBeLessThanOrEqual(16);
  });

  it("reads nodes from a @graph wrapper", () => {
    const block = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "Event", startDate: "2026-07-08T14:00:00Z" }],
    });
    const out = extractJsonLdInterpretations([block], CTX);
    expect(find(out, SCHEMA_START_TIME)).toBeDefined();
  });
});

describe("never-throw hardening regressions", () => {
  it("a deeply nested @context array cannot overflow the stack (depth-bounded)", () => {
    let deep = '"https://schema.org"';
    for (let i = 0; i < 20_000; i++) deep = `[${deep}]`;
    const block = `{"@context":${deep},"@type":"Event","startDate":"2026-07-08T14:00:00Z"}`;
    // Fail-closed: the pathological context is simply not recognised — no throw.
    expect(extractJsonLdInterpretations([block], { docIri: "https://pod.example/m.ttl" })).toEqual(
      [],
    );
  });

  it("caps Message nodes like Event nodes (a flood cannot exceed the cap)", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      "@context": "https://schema.org",
      "@type": "Message",
      dateSent: `2026-07-08T${String(i % 24).padStart(2, "0")}:00:00Z`,
    }));
    const out = extractJsonLdInterpretations(
      messages.map((m) => JSON.stringify(m)),
      { docIri: "https://pod.example/m.ttl" },
    );
    const types = out.filter((i) => i.predicate === RDF_TYPE);
    expect(types.length).toBeLessThanOrEqual(16);
  });
});
