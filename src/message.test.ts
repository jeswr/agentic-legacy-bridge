// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import { parseEmail } from "./email/parse.js";
import {
  asBridgeMessage,
  type BridgeMessage,
  isBridgeMessage,
  toBridgeMessage,
} from "./message.js";
import { detectBridgeCapability } from "./negotiate.js";
import { safeMediaType, safeTelIri } from "./safe-iri.js";

const RAW = [
  "From: Jane <jane@Example.COM>",
  "Subject: Project sync",
  "Date: Wed, 08 Jul 2026 09:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "In-Reply-To: <m0@example.com>",
  "DKIM-Signature: v=1; d=mail.example.com; b=x",
  "",
  "Can we meet at 2026-07-08T14:00:00Z?",
].join("\r\n");

describe("toBridgeMessage", () => {
  it("maps a parsed email 1:1 onto the channel-neutral shape", () => {
    const email = parseEmail(RAW);
    const m = toBridgeMessage(email);
    expect(m.channel).toBe("email");
    expect(m.sender?.handle).toBe("jane@Example.COM");
    expect(m.sender?.displayName).toBe("Jane");
    expect(m.textBody).toBe(email.textBody);
    expect(m.subject).toBe("Project sync");
    expect(m.date).toBe(email.date);
    expect(m.messageId).toBe("m1@example.com");
    expect(m.threadId).toBe("m0@example.com");
    expect(m.dkimDomainClaim).toBe("mail.example.com");
    expect(m.rawSha256).toBe(email.rawSha256);
    expect(m.rawByteLength).toBe(email.rawByteLength);
    expect(m.rawMediaType).toBe("message/rfc822");
    expect(m.warnings).toEqual(email.warnings);
  });

  it("omits sender when the email has no parseable From", () => {
    const m = toBridgeMessage(parseEmail("Subject: hi\r\n\r\nbody"));
    expect(m.sender).toBeUndefined();
  });

  it("folds headers into signals with lower-cased keys, FIRST occurrence winning", () => {
    const m = toBridgeMessage(
      parseEmail(
        "From: a@b.com\r\nX-Agentic-Channels: rdf,a2a\r\nX-Agentic-Channels: email-only-override\r\n\r\nhi",
      ),
    );
    expect(m.signals["x-agentic-channels"]).toBe("rdf,a2a"); // the duplicate cannot override
  });

  it("signals feed detectBridgeCapability as the channel-neutral header map", () => {
    const m = toBridgeMessage(
      parseEmail(
        "From: a@b.com\r\nX-Agentic-Channels: rdf\r\nX-Agentic-Reply: https://pod.example/copy.ttl\r\n\r\nhi",
      ),
    );
    const cap = detectBridgeCapability({ headers: m.signals });
    expect(cap.capable).toBe(true);
    expect(cap.channels).toContain("rdf");
    expect(cap.podCopyUrl).toBe("https://pod.example/copy.ttl");
  });

  it("a hostile __proto__ header cannot pollute the signals prototype chain", () => {
    const m = toBridgeMessage(parseEmail("From: a@b.com\r\n__proto__: evil\r\n\r\nhi"));
    // Own property only — never the prototype.
    expect(Object.getPrototypeOf(m.signals)).toBeNull();
    expect(Object.hasOwn(m.signals, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("freezes signals (the parsed message is immutable)", () => {
    const m = toBridgeMessage(parseEmail(RAW));
    expect(Object.isFrozen(m.signals)).toBe(true);
  });
});

describe("isBridgeMessage / asBridgeMessage", () => {
  const bridge: BridgeMessage = {
    channel: "slack",
    textBody: "hi",
    signals: {},
    rawSha256: "a".repeat(64),
    rawByteLength: 2,
    rawMediaType: "application/json",
    warnings: [],
  };

  it("discriminates the union", () => {
    expect(isBridgeMessage(bridge)).toBe(true);
    expect(isBridgeMessage(parseEmail(RAW))).toBe(false);
  });

  it("passes a BridgeMessage through unchanged and converts an EmailMessage", () => {
    expect(asBridgeMessage(bridge)).toBe(bridge);
    const converted = asBridgeMessage(parseEmail(RAW));
    expect(converted.channel).toBe("email");
    expect(converted.rawMediaType).toBe("message/rfc822");
  });
});

describe("safeTelIri", () => {
  it("accepts strict E.164 and mints a tel: IRI", () => {
    expect(safeTelIri("+447700900123")).toBe("tel:+447700900123");
    expect(safeTelIri(" +14155552671 ")).toBe("tel:+14155552671");
  });

  it("rejects everything else (fail-closed)", () => {
    expect(safeTelIri("447700900123")).toBeUndefined(); // no +
    expect(safeTelIri("+0447700900123")).toBeUndefined(); // leading zero
    expect(safeTelIri("+44 7700 900123")).toBeUndefined(); // separators
    expect(safeTelIri("+44-7700-900123")).toBeUndefined();
    expect(safeTelIri("+123456")).toBeUndefined(); // too short
    expect(safeTelIri(`+1${"2".repeat(15)}`)).toBeUndefined(); // 16 digits — over E.164
    expect(safeTelIri("+44770090012a")).toBeUndefined(); // letters
    expect(safeTelIri("+4477009>evil")).toBeUndefined(); // IRIREF breakout attempt
    expect(safeTelIri(42)).toBeUndefined();
    expect(safeTelIri(undefined)).toBeUndefined();
  });
});

describe("safeMediaType", () => {
  it("accepts and canonicalises a plausible type/subtype", () => {
    expect(safeMediaType("message/rfc822")).toBe("message/rfc822");
    expect(safeMediaType(" Application/JSON ")).toBe("application/json");
  });

  it("rejects malformed values (fail-closed)", () => {
    expect(safeMediaType("noslash")).toBeUndefined();
    expect(safeMediaType("a/b/c")).toBeUndefined();
    expect(safeMediaType('evil">/x')).toBeUndefined();
    expect(safeMediaType(`${"a".repeat(80)}/x`)).toBeUndefined(); // over-length
    expect(safeMediaType("")).toBeUndefined();
    expect(safeMediaType(7)).toBeUndefined();
  });
});
