// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import {
  hashPatternDocument,
  KNOWN_PATTERN_HASHES,
  knownPatternHash,
  PROPOSE_TIMES_PATTERN_HASH,
  PROPOSE_TIMES_PATTERN_IRI,
  PROPOSE_TIMES_PATTERN_TURTLE,
  SENT_AT_PATTERN_HASH,
  SENT_AT_PATTERN_IRI,
  SENT_AT_PATTERN_TURTLE,
  verifyPatternDocument,
} from "./patterns.js";

describe("pattern hashes (Rule 3 — content addressing)", () => {
  it("the committed sent-at hash matches a recompute from the shape text", async () => {
    expect(await hashPatternDocument(SENT_AT_PATTERN_TURTLE)).toBe(SENT_AT_PATTERN_HASH);
  });
  it("the committed propose-times hash matches a recompute", async () => {
    expect(await hashPatternDocument(PROPOSE_TIMES_PATTERN_TURTLE)).toBe(
      PROPOSE_TIMES_PATTERN_HASH,
    );
  });
  it("hashes have the a2a-rdf sha256:<64 lowercase hex> shape", () => {
    for (const hash of [SENT_AT_PATTERN_HASH, PROPOSE_TIMES_PATTERN_HASH]) {
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(SENT_AT_PATTERN_HASH).not.toBe(PROPOSE_TIMES_PATTERN_HASH);
  });
  it("the hash pins the GRAPH, not the serialisation (RDFC-1.0 invariance)", async () => {
    // Same triples, different prose: comments + blank lines + spacing changes.
    const reformatted = `${SENT_AT_PATTERN_TURTLE}\n# a comment that is not a triple\n`;
    expect(await hashPatternDocument(reformatted)).toBe(SENT_AT_PATTERN_HASH);
  });
  it("a changed GRAPH changes the hash", async () => {
    const tampered = SENT_AT_PATTERN_TURTLE.replace('"sent-at"', '"sent-at-tampered"');
    expect(await hashPatternDocument(tampered)).not.toBe(SENT_AT_PATTERN_HASH);
  });
});

describe("verifyPatternDocument (fail-closed)", () => {
  it("accepts the genuine document", async () => {
    expect(await verifyPatternDocument(SENT_AT_PATTERN_TURTLE, SENT_AT_PATTERN_HASH)).toBe(true);
  });
  it("rejects a mismatched hash", async () => {
    expect(await verifyPatternDocument(SENT_AT_PATTERN_TURTLE, PROPOSE_TIMES_PATTERN_HASH)).toBe(
      false,
    );
  });
  it("never throws: malformed Turtle / malformed hash → false", async () => {
    expect(await verifyPatternDocument("not turtle at all <<<", SENT_AT_PATTERN_HASH)).toBe(false);
    expect(await verifyPatternDocument(SENT_AT_PATTERN_TURTLE, "sha256:nothex")).toBe(false);
    expect(await verifyPatternDocument(SENT_AT_PATTERN_TURTLE, "md5:abc")).toBe(false);
  });
});

describe("knownPatternHash (the pre-cached shape table)", () => {
  it("ships both patterns pre-cached", () => {
    expect(knownPatternHash(SENT_AT_PATTERN_IRI)).toBe(SENT_AT_PATTERN_HASH);
    expect(knownPatternHash(PROPOSE_TIMES_PATTERN_IRI)).toBe(PROPOSE_TIMES_PATTERN_HASH);
    expect(KNOWN_PATTERN_HASHES.size).toBe(2);
  });
  it("returns undefined for an unknown pattern", () => {
    expect(knownPatternHash("https://evil.example/patterns/fake")).toBeUndefined();
  });
});
