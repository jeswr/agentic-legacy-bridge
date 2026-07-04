// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Store } from "n3";
import { describe, expect, it } from "vitest";
import {
  addInterpretation,
  clampConfidence,
  classifyReliability,
  DEFAULT_THRESHOLDS,
  type Interpretation,
} from "./reliability.js";
import {
  AGENTIC_CALIBRATION,
  AGENTIC_CONFIDENCE,
  AGENTIC_INTERPRETATION,
  AGENTIC_INTERPRETATION_METHOD,
  AGENTIC_LLM_INTERPRETATION,
  AGENTIC_SECURITY_BEARING,
  AGENTIC_SELF_REPORTED,
  PROV_WAS_DERIVED_FROM,
} from "./vocab.js";

const DOC = "https://pod.example/inbox/m.ttl";
const RAW = "urn:agentic:raw:abc";

function interp(over: Partial<Interpretation> = {}): Interpretation {
  return {
    subject: `${DOC}#event-1`,
    predicate: "https://schema.org/startTime",
    object: {
      kind: "literal",
      value: "2026-07-08T14:00:00Z",
      datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
    },
    confidence: 0.82,
    method: "LlmInterpretation",
    calibration: "SelfReported",
    ...over,
  };
}

describe("clampConfidence", () => {
  it("clamps out-of-range + non-finite", () => {
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(2)).toBe(1);
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(0.5)).toBe(0.5);
  });
});

describe("addInterpretation", () => {
  it("lowers a reified qualified derivation with provenance + confidence", () => {
    const store = new Store();
    const iri = addInterpretation(store, interp(), 1, {
      docIri: DOC,
      rawMessageIri: RAW,
      interpretingAgentWebId: "https://agent.example/#me",
      mandateIri: "https://agent.example/mandate#m",
    });
    if (iri === undefined) throw new Error("expected an interpretation IRI");
    expect(iri).toBe(`${DOC}#interp-1`);
    expect(
      store.getQuads(
        iri,
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        AGENTIC_INTERPRETATION,
        null,
      ).length,
    ).toBe(1);
    expect(store.getQuads(iri, AGENTIC_CONFIDENCE, null, null)[0]?.object.value).toBe("0.82");
    expect(store.getQuads(iri, PROV_WAS_DERIVED_FROM, RAW, null).length).toBe(1);
  });

  it("drops (fail-closed) an interpretation whose subject IRI is unsafe", () => {
    const store = new Store();
    const out = addInterpretation(store, interp({ subject: "not a url" }), 1, {
      docIri: DOC,
      rawMessageIri: RAW,
    });
    expect(out).toBeUndefined();
    expect([...store].length).toBe(0);
  });

  it("drops an interpretation whose IRI object is unsafe", () => {
    const store = new Store();
    const out = addInterpretation(
      store,
      interp({ object: { kind: "iri", value: "javascript:alert(1)" } }),
      1,
      { docIri: DOC, rawMessageIri: RAW },
    );
    expect(out).toBeUndefined();
  });

  it("marks a security-bearing datum", () => {
    const store = new Store();
    const iri = addInterpretation(store, interp({ securityBearing: true }), 2, {
      docIri: DOC,
      rawMessageIri: RAW,
    });
    if (iri === undefined) throw new Error("expected an interpretation IRI");
    expect(store.getQuads(iri, AGENTIC_SECURITY_BEARING, null, null)[0]?.object.value).toBe("true");
  });

  it("fails closed to the least-trusting method/calibration for an out-of-enum value", () => {
    const store = new Store();
    // An injected interpreter could emit a value outside the enum despite the type;
    // it must NOT reach `namedNode(undefined)`.
    const iri = addInterpretation(
      store,
      interp({
        method: "Bogus" as unknown as Interpretation["method"],
        calibration: "AlsoBogus" as unknown as Interpretation["calibration"],
      }),
      3,
      { docIri: DOC, rawMessageIri: RAW },
    );
    if (iri === undefined) throw new Error("expected an interpretation IRI");
    expect(store.getQuads(iri, AGENTIC_INTERPRETATION_METHOD, null, null)[0]?.object.value).toBe(
      AGENTIC_LLM_INTERPRETATION,
    );
    expect(store.getQuads(iri, AGENTIC_CALIBRATION, null, null)[0]?.object.value).toBe(
      AGENTIC_SELF_REPORTED,
    );
    // No quad may carry an empty/"undefined" IRI.
    for (const q of store) {
      expect(q.object.value).not.toBe("");
      expect(q.object.value).not.toContain("undefined");
    }
  });
});

describe("classifyReliability (§3c gate)", () => {
  it("auto only for high-confidence, well-calibrated, non-security data", () => {
    expect(classifyReliability({ confidence: 0.95, calibration: "Calibrated" })).toBe("auto");
    expect(classifyReliability({ confidence: 0.95, calibration: "Verified" })).toBe("auto");
  });

  it("a high SELF-REPORTED score is never auto (calibration matters)", () => {
    expect(classifyReliability({ confidence: 0.99, calibration: "SelfReported" })).toBe("confirm");
  });

  it("the ambiguous middle → confirm; the tail → audit", () => {
    expect(classifyReliability({ confidence: 0.6, calibration: "Calibrated" })).toBe("confirm");
    expect(classifyReliability({ confidence: 0.2, calibration: "Calibrated" })).toBe("audit");
  });

  it("HARD RULE: a security-bearing datum is NEVER auto, at any confidence", () => {
    expect(
      classifyReliability({ confidence: 1, calibration: "Verified", securityBearing: true }),
    ).toBe("confirm");
    expect(
      classifyReliability({ confidence: 0.1, calibration: "Verified", securityBearing: true }),
    ).toBe("audit");
  });

  it("honours custom thresholds", () => {
    expect(
      classifyReliability(
        { confidence: 0.7, calibration: "Calibrated" },
        { tauAuto: 0.6, tauConfirm: 0.3 },
      ),
    ).toBe("auto");
  });

  it("exposes the documented defaults", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ tauAuto: 0.9, tauConfirm: 0.5 });
  });
});
