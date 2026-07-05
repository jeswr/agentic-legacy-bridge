// AUTHORED-BY Claude Fable 5
import { Store } from "n3";
import { describe, expect, it } from "vitest";
import { addInterpretation } from "../reliability.js";
import { buildReply } from "../reply.js";
import {
  AGENTIC_IN_REPLY_TO,
  PROV_WAS_ATTRIBUTED_TO,
  RDF_TYPE,
  SCHEMA_ACCEPT_ACTION,
  SCHEMA_DATE_SENT,
  SCHEMA_PROPOSE_ACTION,
  SCHEMA_START_TIME,
} from "../vocab.js";
import { extractAgenticReply, extractAgenticReplyStructural } from "./agentic-reply.js";
import {
  PROPOSE_TIMES_PATTERN_HASH,
  PROPOSE_TIMES_PATTERN_IRI,
  SENT_AT_PATTERN_HASH,
  SENT_AT_PATTERN_IRI,
} from "./patterns.js";

const CTX = { docIri: "https://pod.example/inbox/m.ttl" };
const RAW_URN = "urn:agentic:raw:abc123";

/** The design §5.4 worked-example block (an AcceptAction from a peer agent). */
const ACCEPT_BLOCK = JSON.stringify({
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://schema.org",
    "https://w3id.org/jeswr/agentic",
  ],
  type: ["VerifiableCredential", "AgenticReply"],
  issuer: "https://jeswr.org/agent",
  credentialSubject: {
    type: "AcceptAction",
    "dct:conformsTo": {
      "@id": "https://w3id.org/jeswr/agentic/patterns/accept-time",
      protocolHash: `sha256:${"ab".repeat(32)}`,
    },
    "agentic:inReplyTo": RAW_URN,
    "schema:dateSent": "2026-07-05T09:12:00Z",
    object: [
      {
        type: "Event",
        name: "Call: Jesse / Alice",
        startTime: "2026-07-08T10:00:00Z",
        endTime: "2026-07-08T10:30:00Z",
      },
    ],
  },
  proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-rdfc-2022" },
});

describe("extractAgenticReplyStructural (unverified — never auto-run)", () => {
  it("extracts the worked-example structure, ALL SelfReported, issuer NEVER asserted", () => {
    const out = extractAgenticReplyStructural([ACCEPT_BLOCK], CTX);
    expect(out.verified).toBe(false);
    expect(out.issuer).toBeUndefined();

    const type = out.interpretations.find((i) => i.predicate === RDF_TYPE);
    expect(type?.object).toEqual({ kind: "iri", value: SCHEMA_ACCEPT_ACTION });
    expect(type?.subject).toBe(`${CTX.docIri}#areply-1`);

    const dateSent = out.interpretations.find((i) => i.predicate === SCHEMA_DATE_SENT);
    expect(dateSent?.object).toMatchObject({ value: "2026-07-05T09:12:00.000Z" });

    const inReplyTo = out.interpretations.find((i) => i.predicate === AGENTIC_IN_REPLY_TO);
    expect(inReplyTo?.object).toEqual({ kind: "iri", value: RAW_URN });

    const start = out.interpretations.find((i) => i.predicate === SCHEMA_START_TIME);
    expect(start?.object).toMatchObject({ value: "2026-07-08T10:00:00.000Z" });

    // The load-bearing trust split: nothing from an UNVERIFIED block may be
    // Calibrated/Verified (classifyReliability would auto-run it).
    for (const interp of out.interpretations) {
      expect(interp.calibration).toBe("SelfReported");
    }
    expect(out.interpretations.find((i) => i.predicate === PROV_WAS_ATTRIBUTED_TO)).toBeUndefined();

    // Pattern conformance surfaces for the (hash → handler) cache.
    expect(out.patterns).toEqual([
      {
        iri: "https://w3id.org/jeswr/agentic/patterns/accept-time",
        protocolHash: `sha256:${"ab".repeat(32)}`,
      },
    ]);
  });

  it("rejects a hostile inReplyTo / malformed hash / non-http conformance", () => {
    const hostile = JSON.stringify({
      type: "AgenticReply",
      credentialSubject: {
        type: "AcceptAction",
        inReplyTo: "urn:agentic:raw:x> <https://x> <https://y> .", // IRIREF breakout
        conformsTo: [
          { "@id": "javascript:alert(1)", protocolHash: `sha256:${"ab".repeat(32)}` },
          { "@id": "https://ok.example/p", protocolHash: "sha256:NOTHEX" },
        ],
      },
    });
    const out = extractAgenticReplyStructural([hostile], CTX);
    expect(out.interpretations.find((i) => i.predicate === AGENTIC_IN_REPLY_TO)).toBeUndefined();
    expect(out.patterns).toEqual([{ iri: "https://ok.example/p" }]); // hash dropped, IRI kept
  });

  it("ignores non-AgenticReply blocks and malformed JSON", () => {
    const out = extractAgenticReplyStructural(
      ["{broken", JSON.stringify({ "@type": "Event" }), "[]"],
      CTX,
    );
    expect(out.interpretations).toEqual([]);
    expect(out.patterns).toEqual([]);
  });
});

describe("extractAgenticReply (the injectable verifier seam)", () => {
  it("verified block → Calibrated content + issuer asserted at Verified", async () => {
    const out = await extractAgenticReply([ACCEPT_BLOCK], CTX, {
      verify: (credential) => ({
        verified: true,
        issuer: typeof credential.issuer === "string" ? credential.issuer : undefined,
      }),
    });
    expect(out.verified).toBe(true);
    expect(out.issuer).toBe("https://jeswr.org/agent");

    const start = out.interpretations.find((i) => i.predicate === SCHEMA_START_TIME);
    expect(start?.calibration).toBe("Calibrated");
    expect(start?.confidence).toBe(1);

    const attributed = out.interpretations.find((i) => i.predicate === PROV_WAS_ATTRIBUTED_TO);
    expect(attributed?.object).toEqual({ kind: "iri", value: "https://jeswr.org/agent" });
    expect(attributed?.calibration).toBe("Verified");
  });

  it("a failed / throwing / absent verifier fails closed to unverified", async () => {
    for (const verify of [
      () => ({ verified: false }),
      () => {
        throw new Error("boom");
      },
      undefined,
    ] as const) {
      const out = await extractAgenticReply(
        [ACCEPT_BLOCK],
        CTX,
        verify === undefined ? undefined : { verify },
      );
      expect(out.verified).toBe(false);
      for (const interp of out.interpretations) {
        expect(["SelfReported"]).toContain(interp.calibration);
      }
    }
  });

  it("a verified verdict with a non-http issuer never asserts the issuer", async () => {
    const out = await extractAgenticReply([ACCEPT_BLOCK], CTX, {
      verify: () => ({ verified: true, issuer: "javascript:alert(1)" }),
    });
    expect(out.verified).toBe(true);
    expect(out.issuer).toBeUndefined();
    expect(out.interpretations.find((i) => i.predicate === PROV_WAS_ATTRIBUTED_TO)).toBeUndefined();
  });
});

describe("round-trip: buildReply → extractAgenticReply (the protocol closes the loop)", () => {
  it("our own carrier parses back deterministically, patterns + envelope intact", async () => {
    const built = await buildReply({
      inReplyTo: RAW_URN,
      offeredTimes: [
        { name: "Call", startTime: "2026-07-07T14:00:00Z", endTime: "2026-07-07T14:30:00Z" },
        { name: "Call", startTime: "2026-07-08T10:00:00Z", endTime: "2026-07-08T10:30:00Z" },
      ],
      dateSent: "2026-07-05T09:12:00Z",
      sender: "https://jeswr.org/agent",
      issuer: "https://jeswr.org/agent",
    });
    const out = await extractAgenticReply([built.mimePart.body], CTX);

    // Action type + both offered events extracted.
    const type = out.interpretations.find((i) => i.predicate === RDF_TYPE);
    expect(type?.object).toEqual({ kind: "iri", value: SCHEMA_PROPOSE_ACTION });
    const starts = out.interpretations.filter((i) => i.predicate === SCHEMA_START_TIME);
    expect(starts.map((s) => (s.object.kind === "literal" ? s.object.value : ""))).toEqual([
      "2026-07-07T14:00:00.000Z",
      "2026-07-08T10:00:00.000Z",
    ]);

    // The sent-at envelope + both hash-pinned pattern conformances round-trip.
    const dateSent = out.interpretations.find((i) => i.predicate === SCHEMA_DATE_SENT);
    expect(dateSent?.object).toMatchObject({ value: "2026-07-05T09:12:00.000Z" });
    expect(out.patterns).toEqual([
      { iri: SENT_AT_PATTERN_IRI, protocolHash: SENT_AT_PATTERN_HASH },
      { iri: PROPOSE_TIMES_PATTERN_IRI, protocolHash: PROPOSE_TIMES_PATTERN_HASH },
    ]);

    const inReplyTo = out.interpretations.find((i) => i.predicate === AGENTIC_IN_REPLY_TO);
    expect(inReplyTo?.object).toEqual({ kind: "iri", value: RAW_URN });
  });
});

describe("lowering: the urn inReplyTo object survives addInterpretation", () => {
  it("writes the reply-linkage quad (urn object IRIs accepted, fail-closed elsewhere)", () => {
    const out = extractAgenticReplyStructural([ACCEPT_BLOCK], CTX);
    const inReplyTo = out.interpretations.find((i) => i.predicate === AGENTIC_IN_REPLY_TO);
    const store = new Store();
    const iri = addInterpretation(store, inReplyTo as NonNullable<typeof inReplyTo>, 0, {
      docIri: CTX.docIri,
      rawMessageIri: RAW_URN,
    });
    expect(iri).toBe(`${CTX.docIri}#interp-0`);
    const objects = store.getQuads(
      null,
      "https://w3id.org/jeswr/agentic#assertsObjectIri",
      null,
      null,
    );
    expect(objects).toHaveLength(1);
    expect(objects[0]?.object.value).toBe(RAW_URN);
  });
});
