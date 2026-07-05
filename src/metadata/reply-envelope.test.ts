// AUTHORED-BY Claude Fable 5
/** buildReply's Rule-2 envelope additions (dateSent/sender + hash-pinned conformsTo). */
import { describe, expect, it } from "vitest";
import { buildReply } from "../reply.js";
import {
  PROPOSE_TIMES_PATTERN_HASH,
  PROPOSE_TIMES_PATTERN_IRI,
  SENT_AT_PATTERN_HASH,
  SENT_AT_PATTERN_IRI,
} from "./patterns.js";

describe("buildReply — the sent-at envelope + pattern conformance", () => {
  it("carries dateSent/sender and pins BOTH patterns when times are offered", async () => {
    const built = await buildReply({
      inReplyTo: "urn:agentic:raw:abc",
      offeredTimes: [{ startTime: "2026-07-07T14:00:00Z" }],
      dateSent: "2026-07-05T09:12:00Z",
      sender: "https://jeswr.org/agent",
    });
    const subject = built.credential.credentialSubject as Record<string, unknown>;
    expect(subject.dateSent).toBe("2026-07-05T09:12:00.000Z");
    expect(subject.sender).toBe("https://jeswr.org/agent");
    expect(subject.conformsTo).toEqual([
      { "@id": SENT_AT_PATTERN_IRI, protocolHash: SENT_AT_PATTERN_HASH },
      { "@id": PROPOSE_TIMES_PATTERN_IRI, protocolHash: PROPOSE_TIMES_PATTERN_HASH },
    ]);
  });

  it("pins only propose-times when no dateSent is given", async () => {
    const built = await buildReply({
      inReplyTo: "urn:agentic:raw:abc",
      offeredTimes: [{ startTime: "2026-07-07T14:00:00Z" }],
    });
    const subject = built.credential.credentialSubject as Record<string, unknown>;
    expect(subject.dateSent).toBeUndefined();
    expect(subject.conformsTo).toEqual([
      { "@id": PROPOSE_TIMES_PATTERN_IRI, protocolHash: PROPOSE_TIMES_PATTERN_HASH },
    ]);
  });

  it("stays backward-compatible: no envelope fields → no conformsTo/dateSent/sender keys", async () => {
    const built = await buildReply({ inReplyTo: "urn:agentic:raw:abc" });
    const subject = built.credential.credentialSubject as Record<string, unknown>;
    expect(subject.conformsTo).toBeUndefined();
    expect(subject.dateSent).toBeUndefined();
    expect(subject.sender).toBeUndefined();
  });

  it("drops an invalid dateSent / unsafe sender (fail-closed, reply still builds)", async () => {
    const built = await buildReply({
      inReplyTo: "urn:agentic:raw:abc",
      dateSent: "not a date",
      sender: "javascript:alert(1)",
    });
    const subject = built.credential.credentialSubject as Record<string, unknown>;
    expect(subject.dateSent).toBeUndefined();
    expect(subject.sender).toBeUndefined();
    expect(subject.conformsTo).toBeUndefined();
  });
});
