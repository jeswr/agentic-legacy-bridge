// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it } from "vitest";
import { parseEmail } from "./email/parse.js";
import {
  deterministicInterpreter,
  extractIsoDateTimes,
  extractRelativeMeetings,
} from "./interpret.js";
import { AGENTIC_REPLY_POLARITY, SCHEMA_START_TIME } from "./vocab.js";

const DOC = "https://pod.example/inbox/m.ttl";
const NOW = new Date("2026-07-04T00:00:00Z"); // a Saturday

function parse(body: string, subject = "Meeting"): ReturnType<typeof parseEmail> {
  return parseEmail(`From: a@b.com\r\nSubject: ${subject}\r\n\r\n${body}`);
}

describe("extractIsoDateTimes", () => {
  it("extracts + canonicalises valid ISO datetimes", () => {
    expect(extractIsoDateTimes("Let's meet 2026-07-08T14:00:00Z ok?")).toEqual([
      "2026-07-08T14:00:00.000Z",
    ]);
  });
  it("rejects overflow / invalid calendar values", () => {
    expect(extractIsoDateTimes("2026-13-40T25:99:00Z")).toEqual([]);
  });
  it("dedupes repeated instants", () => {
    expect(extractIsoDateTimes("2026-07-08T14:00Z and again 2026-07-08T14:00:00Z")).toEqual([
      "2026-07-08T14:00:00.000Z",
    ]);
  });
});

describe("extractRelativeMeetings", () => {
  it("resolves 'tomorrow at 2pm' against now (UTC)", () => {
    const out = extractRelativeMeetings("can we do tomorrow at 2pm", NOW);
    expect(out[0]?.iso).toBe("2026-07-05T14:00:00.000Z");
    expect(out[0]?.note).toMatch(/timezone/i);
  });
  it("resolves 'next tuesday at 09:30'", () => {
    // 2026-07-04 is Saturday; next Tuesday is 2026-07-07.
    const out = extractRelativeMeetings("how about next Tuesday at 09:30", NOW);
    expect(out[0]?.iso).toBe("2026-07-07T09:30:00.000Z");
  });
  it("ignores an out-of-range hour", () => {
    expect(extractRelativeMeetings("tomorrow at 49", NOW)).toEqual([]);
  });
});

describe("DeterministicInterpreter", () => {
  it("emits high-confidence, CALIBRATED interpretations for explicit ISO times", () => {
    const out = deterministicInterpreter.interpret(parse("Meet at 2026-07-08T14:00:00Z"), {
      docIri: DOC,
      now: NOW,
    });
    const startTime = out.find((i) => i.predicate === SCHEMA_START_TIME);
    expect(startTime?.confidence).toBe(0.95);
    expect(startTime?.calibration).toBe("Calibrated");
    expect(startTime?.method).toBe("Deterministic");
    expect(startTime?.object).toEqual({
      kind: "literal",
      value: "2026-07-08T14:00:00.000Z",
      datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
    });
  });

  it("emits lower-confidence SELF-REPORTED interpretations for relative times", () => {
    const out = deterministicInterpreter.interpret(parse("let's do tomorrow at 3pm"), {
      docIri: DOC,
      now: NOW,
    });
    const startTime = out.find((i) => i.predicate === SCHEMA_START_TIME);
    expect(startTime?.confidence).toBe(0.6);
    expect(startTime?.calibration).toBe("SelfReported");
  });

  it("names the event from the subject and types it schema:Event", () => {
    const out = deterministicInterpreter.interpret(parse("2026-07-08T14:00:00Z", "Project sync"), {
      docIri: DOC,
      now: NOW,
    });
    expect(out.some((i) => i.object.kind === "literal" && i.object.value === "Project sync")).toBe(
      true,
    );
    expect(
      out.some((i) => i.object.kind === "iri" && i.object.value === "https://schema.org/Event"),
    ).toBe(true);
  });

  it("detects an affirmative reply polarity (self-reported, never auto)", () => {
    const out = deterministicInterpreter.interpret(parse("Yes"), { docIri: DOC, now: NOW });
    const pol = out.find((i) => i.predicate === AGENTIC_REPLY_POLARITY);
    expect(pol?.object).toEqual({ kind: "literal", value: "affirmative" });
    expect(pol?.calibration).toBe("SelfReported");
  });

  it("ignores quoted-reply history when interpreting", () => {
    const out = deterministicInterpreter.interpret(
      parse("> old 2026-01-01T00:00:00Z\nno new time here"),
      { docIri: DOC, now: NOW },
    );
    expect(out.find((i) => i.predicate === SCHEMA_START_TIME)).toBeUndefined();
  });

  it("bounds the number of interpretations on a pathological body", () => {
    const many = Array.from(
      { length: 500 },
      (_, i) => `2026-07-08T${String(i % 24).padStart(2, "0")}:00:00Z`,
    ).join(" ");
    const out = deterministicInterpreter.interpret(parse(many), { docIri: DOC, now: NOW });
    const events = out.filter((i) => i.predicate === SCHEMA_START_TIME);
    expect(events.length).toBeLessThanOrEqual(16);
  });
});
