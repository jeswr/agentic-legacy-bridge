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
