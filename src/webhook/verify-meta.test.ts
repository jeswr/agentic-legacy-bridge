// AUTHORED-BY Claude Fable 5
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  META_SIGNATURE_HEADER,
  metaVerificationChallenge,
  verifyMetaSignature,
} from "./verify-meta.js";

const APP_SECRET = "meta-app-secret-abc123";
const VERIFY_TOKEN = "my-verify-token-xyz";

function signMeta(secret: string, body: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(body);
  return `sha256=${mac.digest("hex")}`;
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("verifyMetaSignature — the happy path + tamper resistance", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts a correctly-signed delivery", () => {
    const sig = signMeta(APP_SECRET, body);
    expect(verifyMetaSignature({ [META_SIGNATURE_HEADER]: sig }, bytes(body), APP_SECRET)).toEqual({
      ok: true,
    });
  });

  it("is case-insensitive on the header name", () => {
    const sig = signMeta(APP_SECRET, body);
    expect(verifyMetaSignature({ "X-Hub-Signature-256": sig }, bytes(body), APP_SECRET)).toEqual({
      ok: true,
    });
  });

  it("rejects the WRONG app secret", () => {
    const forged = signMeta("wrong-secret", body);
    expect(
      verifyMetaSignature({ [META_SIGNATURE_HEADER]: forged }, bytes(body), APP_SECRET),
    ).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects a valid signature on a TAMPERED body", () => {
    const sig = signMeta(APP_SECRET, body);
    expect(
      verifyMetaSignature({ [META_SIGNATURE_HEADER]: sig }, bytes(`${body} `), APP_SECRET),
    ).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects a MISSING signature header", () => {
    expect(verifyMetaSignature({}, bytes(body), APP_SECRET)).toEqual({
      ok: false,
      reason: "missing-signature",
    });
  });

  it("rejects an empty configured app secret (never verify-open)", () => {
    const sig = signMeta(APP_SECRET, body);
    expect(verifyMetaSignature({ [META_SIGNATURE_HEADER]: sig }, bytes(body), "")).toEqual({
      ok: false,
      reason: "no-secret",
    });
  });

  it("rejects a signature missing the sha256= prefix", () => {
    const raw = signMeta(APP_SECRET, body).slice("sha256=".length);
    expect(verifyMetaSignature({ [META_SIGNATURE_HEADER]: raw }, bytes(body), APP_SECRET)).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });
});

describe("metaVerificationChallenge — the GET registration handshake", () => {
  it("echoes the challenge when mode + token match", () => {
    const query = {
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    };
    expect(metaVerificationChallenge(query, VERIFY_TOKEN)).toEqual({
      ok: true,
      challenge: "1158201444",
    });
  });

  it("REFUSES a wrong verify token (no echo — no reflected-content oracle)", () => {
    const query = {
      "hub.mode": "subscribe",
      "hub.verify_token": "attacker-guess",
      "hub.challenge": "evil",
    };
    expect(metaVerificationChallenge(query, VERIFY_TOKEN)).toEqual({ ok: false });
  });

  it("REFUSES when hub.mode is not subscribe", () => {
    const query = {
      "hub.mode": "unsubscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "c",
    };
    expect(metaVerificationChallenge(query, VERIFY_TOKEN)).toEqual({ ok: false });
  });

  it("REFUSES a missing challenge", () => {
    const query = { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN };
    expect(metaVerificationChallenge(query, VERIFY_TOKEN)).toEqual({ ok: false });
  });

  it("REFUSES undefined query", () => {
    expect(metaVerificationChallenge(undefined, VERIFY_TOKEN)).toEqual({ ok: false });
  });

  it("REFUSES a blank configured verify token", () => {
    const query = {
      "hub.mode": "subscribe",
      "hub.verify_token": "",
      "hub.challenge": "c",
    };
    expect(metaVerificationChallenge(query, "")).toEqual({ ok: false });
  });

  it("caps an absurdly long challenge", () => {
    const query = {
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "A".repeat(10_000),
    };
    const r = metaVerificationChallenge(query, VERIFY_TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.challenge.length).toBeLessThanOrEqual(2048);
  });
});
