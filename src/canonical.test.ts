// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it } from "vitest";
import { emailToCanonical, serializeCanonical } from "./canonical.js";
import { parseEmail } from "./email/parse.js";

function parse(headers: string, body: string): ReturnType<typeof parseEmail> {
  return parseEmail(`${headers}\r\n\r\n${body}`);
}

describe("emailToCanonical", () => {
  it("maps body to text/plain content with the sender-claimed date", () => {
    const c = emailToCanonical(parse("Date: Wed, 08 Jul 2026 14:00:00 +0000", "hello"));
    expect(c.content).toBe("hello");
    expect(c.mediaType).toBe("text/plain");
    expect(c.published).toBe("2026-07-08T14:00:00.000Z");
  });

  it("never sets a verified author (no WebID assumed from From:)", () => {
    const c = emailToCanonical(parse("From: a@b.com", "hi"));
    expect(c.author).toBeUndefined();
  });

  it("always text/plain even when the source was HTML", () => {
    const c = emailToCanonical(parse("Content-Type: text/html", "<b>hi</b>"));
    expect(c.mediaType).toBe("text/plain");
    expect(c.content).not.toContain("<b>");
  });
});

describe("serializeCanonical", () => {
  it("serialises to an AS2 Turtle resource via solid-chat-interop", async () => {
    const ttl = await serializeCanonical(
      parse("From: a@b.com", "hello there"),
      "https://pod.example/inbox/m.chat.ttl",
    );
    expect(ttl).toContain("hello there");
    expect(typeof ttl).toBe("string");
    expect(ttl.length).toBeGreaterThan(0);
  });
});
