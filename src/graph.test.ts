// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Parser } from "n3";
import { describe, expect, it } from "vitest";
import { parseEmail } from "./email/parse.js";
import { buildAgenticGraph } from "./graph.js";
import { deterministicInterpreter } from "./interpret.js";
import { mintUrn } from "./safe-iri.js";

const DOC = "https://pod.example/inbox/m.ttl";
const RAW_RES = "https://pod.example/inbox/m.eml";

function parse(body: string): ReturnType<typeof parseEmail> {
  return parseEmail(
    `From: Jane <jane@example.com>\r\nSubject: Sync\r\nDate: Wed, 08 Jul 2026 09:00:00 +0000\r\n\r\n${body}`,
  );
}

describe("buildAgenticGraph", () => {
  it("builds a parseable Turtle graph with the raw anchor, sender, and interpretations", async () => {
    const message = parse("Let's meet at 2026-07-08T14:00:00Z");
    const rawMessageIri = mintUrn("raw", message.rawSha256);
    const interps = deterministicInterpreter.interpret(message, {
      docIri: DOC,
      now: new Date("2026-07-04T00:00:00Z"),
    });
    const { turtle, personIri, interpretationIris } = await buildAgenticGraph({
      message,
      channel: "email",
      docIri: DOC,
      rawMessageIri,
      rawResourceIri: RAW_RES,
      interpretations: interps,
      interpretingAgentWebId: "https://agent.example/#me",
      mandateIri: "https://agent.example/mandate#m",
    });

    // It must be valid Turtle.
    const quads = new Parser().parse(turtle);
    expect(quads.length).toBeGreaterThan(0);

    expect(turtle).toContain(rawMessageIri);
    expect(turtle).toContain(personIri);
    expect(turtle).toContain("agentic:RawInboundMessage");
    expect(turtle).toContain(`sha256:${message.rawSha256}`);
    expect(turtle).toContain(RAW_RES);
    expect(interpretationIris.length).toBeGreaterThan(0);
    // The interpreting activity carries the mandate + agent.
    expect(turtle).toContain("https://agent.example/mandate#m");
    expect(turtle).toContain("https://agent.example/#me");
  });

  it("produces valid Turtle even with a hostile display name + no interpretations", async () => {
    const message = parse("no times here");
    const rawMessageIri = mintUrn("raw", message.rawSha256);
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "email",
      docIri: DOC,
      rawMessageIri,
    });
    expect(() => new Parser().parse(turtle)).not.toThrow();
  });

  it("fails closed on a rawMessageIri carrying an IRIREF-breakout char (no injection)", async () => {
    const message = parse("hi");
    // A rawMessageIri smuggling `>` + extra triples would break out of the Turtle
    // `<...>` if it reached `namedNode()` unvalidated (it could inject into a `.acl`).
    await expect(
      buildAgenticGraph({
        message,
        channel: "email",
        docIri: DOC,
        rawMessageIri: "urn:agentic:raw:x> <urn:evil:s> <urn:evil:p> <urn:evil:o> .",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("accepts a valid http(s) rawMessageIri (defense-in-depth passthrough)", async () => {
    const message = parse("hi");
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "email",
      docIri: DOC,
      rawMessageIri: "https://pod.example/inbox/m.eml#raw",
    });
    expect(turtle).toContain("https://pod.example/inbox/m.eml#raw");
    expect(() => new Parser().parse(turtle)).not.toThrow();
  });
});

describe("buildAgenticGraph — M2.5a status widening + attempts counter", () => {
  const Agentic = "https://w3id.org/jeswr/agentic#";
  const rawIri = () => mintUrn("raw", parse("hi").rawSha256);

  async function statusObject(
    status: "pending" | "interpreted" | "failed",
  ): Promise<string | undefined> {
    const message = parse("hi");
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "email",
      docIri: DOC,
      rawMessageIri: rawIri(),
      rawResourceIri: RAW_RES,
      interpretationStatus: status,
    });
    return new Parser()
      .parse(turtle)
      .find((q) => q.predicate.value === `${Agentic}interpretationStatus`)?.object.value;
  }

  it("maps the terminal `failed` status to agentic:InterpretationFailed", async () => {
    expect(await statusObject("failed")).toBe(`${Agentic}InterpretationFailed`);
    expect(await statusObject("pending")).toBe(`${Agentic}Pending`);
    expect(await statusObject("interpreted")).toBe(`${Agentic}Interpreted`);
  });

  it("throws (fail-closed) on an out-of-enum interpretationStatus from a JS caller", async () => {
    // A JS caller bypassing the TS type must NOT reach `namedNode(undefined)`.
    await expect(
      buildAgenticGraph({
        message: parse("hi"),
        channel: "email",
        docIri: DOC,
        rawMessageIri: rawIri(),
        // biome-ignore lint/suspicious/noExplicitAny: exercising the untyped JS boundary.
        interpretationStatus: "bogus" as any,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("writes interpretationAttempts as a canonical xsd:integer when supplied", async () => {
    const message = parse("hi");
    const { turtle } = await buildAgenticGraph({
      message,
      channel: "email",
      docIri: DOC,
      rawMessageIri: rawIri(),
      interpretationStatus: "pending",
      interpretationAttempts: 3,
    });
    const q = new Parser()
      .parse(turtle)
      .find((q) => q.predicate.value === `${Agentic}interpretationAttempts`);
    expect(q?.object.value).toBe("3");
    expect(q?.object.termType).toBe("Literal");
    // biome-ignore lint/suspicious/noExplicitAny: reading the literal datatype in a test.
    expect((q?.object as any).datatype?.value).toBe("http://www.w3.org/2001/XMLSchema#integer");
  });

  it("omits the attempts quad by default and for a malformed counter (back-compat: absent ⇒ 0)", async () => {
    const message = parse("hi");
    for (const attempts of [undefined, -1, 1.5, Number.NaN]) {
      const { turtle } = await buildAgenticGraph({
        message,
        channel: "email",
        docIri: DOC,
        rawMessageIri: rawIri(),
        interpretationStatus: "pending",
        ...(attempts !== undefined ? { interpretationAttempts: attempts } : {}),
      });
      expect(turtle).not.toContain("interpretationAttempts");
    }
  });
});
