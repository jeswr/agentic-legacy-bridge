// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it } from "vitest";
import {
  asChannel,
  decideUpgrade,
  detectBridgeCapability,
  highestMutualChannel,
} from "./negotiate.js";

describe("asChannel", () => {
  it("narrows known channels only", () => {
    expect(asChannel("rdf")).toBe("rdf");
    expect(asChannel("smoke-signal")).toBeUndefined();
    expect(asChannel(42)).toBeUndefined();
  });
});

describe("detectBridgeCapability", () => {
  it("detects capability from the X-Agentic-Reply header + reads channels", () => {
    const cap = detectBridgeCapability({
      headers: {
        "X-Agentic-Reply": "https://pod.example/replies/1.ttl",
        "X-Agentic-Channels": "rdf, a2a, bogus",
      },
    });
    expect(cap.capable).toBe(true);
    expect(cap.podCopyUrl).toBe("https://pod.example/replies/1.ttl");
    expect(cap.channels).toEqual(["rdf", "a2a", "email"]); // ordered, filtered, email floor
  });

  it("detects capability from an AgenticReply JSON-LD block", () => {
    const cap = detectBridgeCapability({
      jsonLd: { type: ["VerifiableCredential", "AgenticReply"] },
    });
    expect(cap.capable).toBe(true);
    expect(cap.channels).toEqual(["email"]);
  });

  it("reports not-capable + email floor for a plain message", () => {
    const cap = detectBridgeCapability({ headers: { subject: "hi" } });
    expect(cap.capable).toBe(false);
    expect(cap.channels).toEqual(["email"]);
    expect(cap.podCopyUrl).toBeUndefined();
  });

  it("drops an unsafe X-Agentic-Reply URL", () => {
    const cap = detectBridgeCapability({ headers: { "X-Agentic-Reply": "javascript:x" } });
    expect(cap.podCopyUrl).toBeUndefined();
  });
});

describe("highestMutualChannel", () => {
  it("picks the highest mutually-supported channel", () => {
    expect(highestMutualChannel(["rdf", "a2a"], ["dpop-sk", "a2a"])).toBe("a2a");
    expect(highestMutualChannel(["rdf"], ["rdf", "a2a"])).toBe("rdf");
  });
  it("falls back to email (always supported)", () => {
    expect(highestMutualChannel([], [])).toBe("email");
    expect(highestMutualChannel(["rdf"], ["dpop-sk"])).toBe("email");
  });
});

describe("decideUpgrade (fail-closed)", () => {
  it("upgrades on accept with matching (or no) hash", () => {
    expect(
      decideUpgrade({ targetChannel: "rdf", required: false }, { accept: true }, "email"),
    ).toEqual({
      kind: "upgrade",
      channel: "rdf",
    });
    expect(
      decideUpgrade(
        { targetChannel: "rdf", protocolHash: "h1", required: false },
        { accept: true, protocolHash: "h1" },
        "email",
      ),
    ).toEqual({ kind: "upgrade", channel: "rdf" });
  });

  it("aborts on a hash mismatch even when accepted", () => {
    expect(
      decideUpgrade(
        { targetChannel: "rdf", protocolHash: "h1", required: true },
        { accept: true, protocolHash: "h2" },
        "email",
      ).kind,
    ).toBe("abort");
  });

  it("aborts when a REQUIRED upgrade is declined (no silent prose downgrade)", () => {
    expect(
      decideUpgrade({ targetChannel: "rdf", required: true }, { accept: false }, "email").kind,
    ).toBe("abort");
  });

  it("stays at the current channel when a non-required upgrade is declined", () => {
    expect(
      decideUpgrade({ targetChannel: "rdf", required: false }, { accept: false }, "a2a"),
    ).toEqual({ kind: "stay", channel: "a2a" });
  });
});
