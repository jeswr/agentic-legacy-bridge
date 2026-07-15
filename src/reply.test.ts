// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it } from "vitest";
import { buildReply, htmlSafeJson } from "./reply.js";

const RAW = "urn:agentic:raw:abc123";

describe("buildReply", () => {
  it("builds an unsigned reply with offered events + onboarding + header", async () => {
    const r = await buildReply({
      inReplyTo: RAW,
      offeredTimes: [
        { name: "Call", startTime: "2026-07-08T14:00:00Z", endTime: "2026-07-08T14:30:00Z" },
      ],
      podCopyUrl: "https://pod.example/replies/1.ttl",
      onboardingUrl: "https://onboard.example/#/from/x",
      issuer: "https://agent.example/#me",
    });
    expect(r.signed).toBe(false);
    expect(r.credential.type).toEqual(["AgenticReply"]); // no VerifiableCredential without a proof
    const subject = r.credential.credentialSubject as Record<string, unknown>;
    expect(subject.inReplyTo).toBe(RAW);
    expect(subject.onboarding).toBe("https://onboard.example/#/from/x");
    expect((subject.object as unknown[]).length).toBe(1);
    expect(r.headers["X-Agentic-Reply"]).toBe("https://pod.example/replies/1.ttl");
    expect(r.onboardingBlock).toContain("https://onboard.example/#/from/x");
    expect(r.humanText).toContain("full agentic (A2A) mode");
    expect(r.mimePart.contentType).toBe("application/ld+json");
  });

  it("prepends a control-stripped, capped answer to the single upgrade recommendation", async () => {
    const r = await buildReply({
      inReplyTo: RAW,
      humanText: `Answer\u0000\u001b[31m${"x".repeat(30_000)}`,
      onboardingUrl: "https://onboard.example/#/t/x",
    });
    expect(r.humanText).toBeDefined();
    expect(r.humanText).not.toContain("\u0000");
    expect(r.humanText).not.toContain("\u001b");
    expect(r.humanText).toContain("[31m");
    expect(r.humanText).toContain("full agentic (A2A) mode");
    expect(r.humanText?.length).toBeLessThan(21_000);
  });

  it("drops invalid offered times + unsafe URLs (fail-closed)", async () => {
    const r = await buildReply({
      inReplyTo: RAW,
      offeredTimes: [{ startTime: "not-a-date" }, { startTime: "2026-07-08T14:00:00Z" }],
      podCopyUrl: "javascript:alert(1)",
      onboardingUrl: "http://ok.example/onboard",
    });
    const subject = r.credential.credentialSubject as Record<string, unknown>;
    expect((subject.object as unknown[]).length).toBe(1);
    expect(r.headers["X-Agentic-Reply"]).toBeUndefined();
    expect(subject.onboarding).toBe("http://ok.example/onboard");
  });

  it("signs via the injectable seam and claims VerifiableCredential only with a proof", async () => {
    const r = await buildReply({
      inReplyTo: RAW,
      issuer: "https://agent.example/#me",
      sign: (cred) => ({
        ...cred,
        proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-rdfc-2022" },
      }),
    });
    expect(r.signed).toBe(true);
    expect(r.credential.type).toEqual(["VerifiableCredential", "AgenticReply"]);
    expect(r.credential.proof).toBeDefined();
  });

  it("stays honest (unsigned) if the signer returns no proof", async () => {
    const r = await buildReply({ inReplyTo: RAW, sign: (cred) => cred });
    expect(r.signed).toBe(false);
    expect(r.credential.type).toEqual(["AgenticReply"]);
  });

  it("rejects an inReplyTo that is not a safe agentic urn", async () => {
    const r = await buildReply({ inReplyTo: "urn:evil:<x>" });
    const subject = r.credential.credentialSubject as Record<string, unknown>;
    expect(subject.inReplyTo).toBeUndefined();
  });

  it("HTML-escapes the inline JSON-LD so it cannot break out of <script>", async () => {
    const r = await buildReply({
      inReplyTo: RAW,
      offeredTimes: [
        { name: "</script><script>alert(1)</script>", startTime: "2026-07-08T14:00:00Z" },
      ],
    });
    expect(r.inlineHtml).toContain('<script type="application/ld+json">');
    // The PAYLOAD region (between the opening tag and the single legitimate closing
    // tag) must carry no raw <script> sequence — the hostile name is escaped.
    const open = r.inlineHtml.indexOf(">") + 1;
    const close = r.inlineHtml.lastIndexOf("</script>");
    const payload = r.inlineHtml.slice(open, close);
    expect(payload).not.toContain("</script>");
    expect(payload).not.toContain("<script>");
    expect(payload).toContain("\\u003c/script\\u003e");
  });
});

describe("htmlSafeJson", () => {
  it("escapes < > & and the JS line separators", () => {
    const raw = JSON.stringify({ a: "</x> \u0026\u2028\u2029" });
    const out = htmlSafeJson(raw);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    // Still valid JSON, and parses back to the original value.
    expect(JSON.parse(out)).toEqual({ a: "</x> \u0026\u2028\u2029" });
  });
});
