// AUTHORED-BY Claude Fable 5
/** Rule-1 structured-part surfacing: text/calendar + application/ld+json + inline
 *  <script type="application/ld+json"> collection out of the hardened MIME walk. */
import { describe, expect, it } from "vitest";
import { parseEmail } from "./parse.js";

const BOUNDARY = "b0undary";

function multipart(parts: ReadonlyArray<{ type: string; body: string; extra?: string }>): string {
  return [
    "From: alice@example.com",
    "Subject: Invite",
    `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
    "",
    ...parts.flatMap((p) => [
      `--${BOUNDARY}`,
      `Content-Type: ${p.type}${p.extra ?? ""}`,
      "",
      p.body,
    ]),
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

const LD_BLOCK =
  '{"@context":"https://schema.org","@type":"Event","startDate":"2026-07-08T14:00:00Z"}';
const ICS =
  "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nDTSTART:20260708T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";

describe("parseEmail — structured metadata parts", () => {
  it("collects text/calendar and application/ld+json parts ALONGSIDE the text body", () => {
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "You are invited." },
        { type: "text/html", body: "<p>You are invited.</p>" },
        { type: "text/calendar; method=REQUEST", body: ICS },
        { type: "application/ld+json", body: LD_BLOCK },
      ]),
    );
    expect(msg.textBody.trim()).toBe("You are invited.");
    expect(msg.calendarParts).toHaveLength(1);
    expect(msg.calendarParts?.[0]).toContain("DTSTART:20260708T140000Z");
    expect(msg.jsonLdBlocks).toHaveLength(1);
    expect(msg.jsonLdBlocks?.[0]).toBe(LD_BLOCK);
  });

  it('extracts <script type="application/ld+json"> blocks from the html part', () => {
    const html = `<html><body><p>hi</p><script type="application/ld+json">${LD_BLOCK}</script></body></html>`;
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "hi" },
        { type: "text/html", body: html },
      ]),
    );
    expect(msg.jsonLdBlocks).toHaveLength(1);
    expect(msg.jsonLdBlocks?.[0]).toBe(LD_BLOCK);
  });

  it("omits the fields entirely when nothing structured exists", () => {
    const msg = parseEmail("From: a@b.com\r\nSubject: hi\r\n\r\nplain body");
    expect(msg.jsonLdBlocks).toBeUndefined();
    expect(msg.calendarParts).toBeUndefined();
  });

  it("skips non-ld+json scripts, unterminated blocks, and oversized blocks", () => {
    const html = [
      "<script>var x = 1;</script>",
      `<script type="application/ld+json">${"x".repeat(70 * 1024)}</script>`, // oversized
      '<script type="application/ld+json">{"a":1}', // unterminated → dropped
    ].join("");
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "hi" },
        { type: "text/html", body: html },
      ]),
    );
    expect(msg.jsonLdBlocks).toBeUndefined();
    expect(msg.warnings.some((w) => /JSON-LD script block exceeded/.test(w))).toBe(true);
  });

  it("caps the number of collected blocks and calendar parts", () => {
    const html = Array.from(
      { length: 20 },
      (_, i) => `<script type="application/ld+json">{"i":${i}}</script>`,
    ).join("");
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "hi" },
        { type: "text/html", body: html },
        ...Array.from({ length: 10 }, () => ({ type: "text/calendar", body: ICS })),
      ]),
    );
    expect(msg.jsonLdBlocks?.length).toBeLessThanOrEqual(8);
    expect(msg.calendarParts?.length).toBeLessThanOrEqual(4);
  });

  it("decodes a base64 text/calendar part", () => {
    const b64 = Buffer.from(ICS, "utf8").toString("base64");
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "hi" },
        { type: "text/calendar", body: b64, extra: "\r\nContent-Transfer-Encoding: base64" },
      ]),
    );
    expect(msg.calendarParts?.[0]).toContain("BEGIN:VEVENT");
  });

  it("stays linear on a <script flood (no catastrophic scan)", () => {
    const flood = "<script".repeat(50_000);
    const startedAt = Date.now();
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "hi" },
        { type: "text/html", body: flood },
      ]),
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(msg.jsonLdBlocks).toBeUndefined();
  });

  it("keeps collecting structured parts even though text/plain came FIRST", () => {
    // Regression: the old walk stopped at the first text/plain, which would have
    // missed the calendar/ld+json siblings in a multipart/alternative.
    const msg = parseEmail(
      multipart([
        { type: "text/plain", body: "first" },
        { type: "text/calendar", body: ICS },
      ]),
    );
    expect(msg.textBody.trim()).toBe("first");
    expect(msg.calendarParts).toHaveLength(1);
  });
});
