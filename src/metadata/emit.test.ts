// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import { buildActionMetadata } from "./emit.js";
import { SENT_AT_PATTERN_HASH, SENT_AT_PATTERN_IRI } from "./patterns.js";

const SENDER = "https://jeswr.org/agent";

describe("buildActionMetadata (Rule 2 — the outbound sent-at descriptor)", () => {
  it("builds the schema:Message descriptor pinned to the sent-at pattern", async () => {
    const built = await buildActionMetadata({
      sentAt: "2026-07-05T09:12:00Z",
      sender: SENDER,
      issuer: SENDER,
      inReplyTo: "urn:agentic:raw:abc123",
      derivedFrom: "urn:agentic:raw:abc123",
      mandateIri: "https://pod.example/mandates/m1",
      podCopyUrl: "https://pod.example/outbox/r1.ttl",
    });
    expect(built.signed).toBe(false);
    expect(built.credential.type).toEqual(["AgenticReply"]);
    expect(built.credential.issuer).toBe(SENDER);

    const subject = built.credential.credentialSubject as Record<string, unknown>;
    expect(subject.type).toBe("Message");
    expect(subject.dateSent).toBe("2026-07-05T09:12:00.000Z");
    expect(subject.sender).toBe(SENDER);
    expect(subject.wasAttributedTo).toBe(SENDER);
    expect(subject.inReplyTo).toBe("urn:agentic:raw:abc123");
    expect(subject.wasDerivedFrom).toBe("urn:agentic:raw:abc123");
    expect(subject.conformsTo).toEqual([
      { "@id": SENT_AT_PATTERN_IRI, protocolHash: SENT_AT_PATTERN_HASH },
    ]);
    expect(subject.qualifiedAssociation).toEqual({
      type: "Association",
      agent: SENDER,
      hadPlan: "https://pod.example/mandates/m1",
    });

    expect(built.headers["X-Agentic-Reply"]).toBe("https://pod.example/outbox/r1.ttl");
    expect(built.mimePart.contentType).toBe("application/ld+json");
    expect(JSON.parse(built.mimePart.body)).toEqual(built.credential);
  });

  it("throws on a missing / malformed / zone-ambiguous sentAt (our own datum — fail loud)", async () => {
    for (const sentAt of ["", "not a date", "2026-07-05T09:12:00", "2026-07-05"]) {
      await expect(buildActionMetadata({ sentAt })).rejects.toThrow(/sentAt/);
    }
  });

  it("omits unsafe optional fields (fail-closed) instead of emitting them", async () => {
    const built = await buildActionMetadata({
      sentAt: "2026-07-05T09:12:00Z",
      sender: "javascript:alert(1)",
      inReplyTo: "urn:agentic:raw:x> breakout",
      derivedFrom: "ftp://nope",
      mandateIri: "not a url",
      podCopyUrl: "data:text/html,x",
    });
    const subject = built.credential.credentialSubject as Record<string, unknown>;
    expect(subject.sender).toBeUndefined();
    expect(subject.inReplyTo).toBeUndefined();
    expect(subject.wasDerivedFrom).toBeUndefined();
    expect(subject.qualifiedAssociation).toBeUndefined();
    expect(built.headers["X-Agentic-Reply"]).toBeUndefined();
    // The load-bearing datum still lands.
    expect(subject.dateSent).toBe("2026-07-05T09:12:00.000Z");
  });

  it("honours the honest-signing seam (proof attached → signed + VC type)", async () => {
    const signed = await buildActionMetadata({
      sentAt: "2026-07-05T09:12:00Z",
      sign: (credential) => ({ ...credential, proof: { type: "DataIntegrityProof" } }),
    });
    expect(signed.signed).toBe(true);
    expect(signed.credential.type).toEqual(["VerifiableCredential", "AgenticReply"]);

    const dishonest = await buildActionMetadata({
      sentAt: "2026-07-05T09:12:00Z",
      sign: (credential) => credential, // no proof attached
    });
    expect(dishonest.signed).toBe(false);
    expect(dishonest.credential.type).toEqual(["AgenticReply"]);
  });

  it("script-escapes the inline block (no </script> breakout possible)", async () => {
    const built = await buildActionMetadata({ sentAt: "2026-07-05T09:12:00Z" });
    const inner = built.inlineHtml.replace(/^<script type="application\/ld\+json">\n/, "");
    expect(inner.endsWith("\n</script>")).toBe(true);
    expect(inner.slice(0, -"\n</script>".length)).not.toMatch(/[<>]/);
  });
});
