// AUTHORED-BY Claude Fable 5
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SLACK_MAX_SKEW_SECONDS,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  verifySlackSignature,
} from "./verify-slack.js";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

/** Produce a valid Slack `v0` signature for a (timestamp, body) pair. */
function signSlack(secret: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(`v0:${timestamp}:${body}`);
  return `v0=${mac.digest("hex")}`;
}

function headers(sig: string, ts: string): Record<string, string> {
  return { [SLACK_SIGNATURE_HEADER]: sig, [SLACK_TIMESTAMP_HEADER]: ts };
}

const nowSec = 1_700_000_000;
const nowMs = nowSec * 1000;
const bytes = (s: string) => new TextEncoder().encode(s);

describe("verifySlackSignature — the happy path", () => {
  it("accepts a correctly-signed request", () => {
    const body = '{"type":"event_callback","event":{"type":"message","ts":"1.1","text":"hi"}}';
    const ts = String(nowSec);
    const sig = signSlack(SECRET, ts, body);
    expect(verifySlackSignature(headers(sig, ts), bytes(body), SECRET, nowMs)).toEqual({
      ok: true,
    });
  });

  it("accepts an EMPTY body signed correctly", () => {
    const ts = String(nowSec);
    const sig = signSlack(SECRET, ts, "");
    expect(verifySlackSignature(headers(sig, ts), new Uint8Array(0), SECRET, nowMs)).toEqual({
      ok: true,
    });
  });

  it("is case-insensitive on header names", () => {
    const body = "x";
    const ts = String(nowSec);
    const sig = signSlack(SECRET, ts, body);
    const mixed = { "X-Slack-Signature": sig, "X-Slack-Request-Timestamp": ts };
    expect(verifySlackSignature(mixed, bytes(body), SECRET, nowMs)).toEqual({ ok: true });
  });

  it("accepts a request at exactly the edge of the replay window", () => {
    const body = "edge";
    const ts = String(nowSec - SLACK_MAX_SKEW_SECONDS);
    const sig = signSlack(SECRET, ts, body);
    expect(verifySlackSignature(headers(sig, ts), bytes(body), SECRET, nowMs).ok).toBe(true);
  });
});

describe("verifySlackSignature — bypass attempts are all refused fail-closed", () => {
  const body = "hostile-body";
  const ts = String(nowSec);
  const goodSig = signSlack(SECRET, ts, body);

  it("rejects a signature made with the WRONG secret", () => {
    const forged = signSlack("not-the-secret", ts, body);
    expect(verifySlackSignature(headers(forged, ts), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("rejects a valid signature applied to a DIFFERENT body (tamper)", () => {
    const tampered = bytes(`${body}-tampered`);
    expect(verifySlackSignature(headers(goodSig, ts), tampered, SECRET, nowMs)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("rejects a MISSING signature header", () => {
    expect(
      verifySlackSignature({ [SLACK_TIMESTAMP_HEADER]: ts }, bytes(body), SECRET, nowMs),
    ).toEqual({ ok: false, reason: "missing-signature" });
  });

  it("rejects an empty signature header", () => {
    expect(verifySlackSignature(headers("", ts), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "missing-signature",
    });
  });

  it("rejects a MISSING timestamp header", () => {
    expect(
      verifySlackSignature({ [SLACK_SIGNATURE_HEADER]: goodSig }, bytes(body), SECRET, nowMs),
    ).toEqual({ ok: false, reason: "missing-timestamp" });
  });

  it("rejects a non-numeric timestamp", () => {
    const sig = signSlack(SECRET, "not-a-number", body);
    expect(verifySlackSignature(headers(sig, "not-a-number"), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "bad-timestamp",
    });
  });

  it("rejects a STALE timestamp (replay outside the 5-minute window)", () => {
    const staleTs = String(nowSec - SLACK_MAX_SKEW_SECONDS - 1);
    const sig = signSlack(SECRET, staleTs, body);
    expect(verifySlackSignature(headers(sig, staleTs), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "stale-timestamp",
    });
  });

  it("rejects a FUTURE timestamp beyond the window", () => {
    const futureTs = String(nowSec + SLACK_MAX_SKEW_SECONDS + 1);
    const sig = signSlack(SECRET, futureTs, body);
    expect(verifySlackSignature(headers(sig, futureTs), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "stale-timestamp",
    });
  });

  it("rejects an empty/blank configured secret (never verify-open)", () => {
    expect(verifySlackSignature(headers(goodSig, ts), bytes(body), "", nowMs)).toEqual({
      ok: false,
      reason: "no-secret",
    });
  });

  it("rejects a truncated signature (constant-time length guard)", () => {
    expect(
      verifySlackSignature(headers(goodSig.slice(0, 20), ts), bytes(body), SECRET, nowMs),
    ).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects a signature with the correct length but flipped bits", () => {
    const flipped = `${goodSig.slice(0, -1)}${goodSig.endsWith("0") ? "1" : "0"}`;
    expect(verifySlackSignature(headers(flipped, ts), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("rejects an upper-cased hex signature (expected is lower-hex)", () => {
    const upper = `v0=${goodSig.slice(3).toUpperCase()}`;
    expect(verifySlackSignature(headers(upper, ts), bytes(body), SECRET, nowMs).ok).toBe(false);
  });

  it("rejects a signature missing the v0= prefix", () => {
    const noPrefix = goodSig.slice(3);
    expect(verifySlackSignature(headers(noPrefix, ts), bytes(body), SECRET, nowMs)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });
});
