// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Store } from "n3";
import { describe, expect, it } from "vitest";
import { parseEmail } from "./email/parse.js";
import { addSenderPerson, personIriFor } from "./sender.js";
import {
  AGENTIC_CANDIDATE_WEB_ID,
  AGENTIC_DKIM_DOMAIN_CLAIM,
  AGENTIC_IDENTITY_STATUS,
  SCHEMA_EMAIL,
  SCHEMA_NAME,
  SCHEMA_PERSON,
} from "./vocab.js";

function parse(headers: string): ReturnType<typeof parseEmail> {
  return parseEmail(`${headers}\r\n\r\nbody`);
}

describe("addSenderPerson", () => {
  it("models a Person with mailto email, name, and unverified status", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(store, parse("From: Jane <jane@Example.COM>"));
    expect(personIri).toMatch(/^urn:agentic:person:/);
    const q = (p: string) => store.getQuads(personIri, p, null, null);
    expect(q(SCHEMA_PERSON).length).toBeGreaterThanOrEqual(0);
    expect(
      store.getQuads(
        personIri,
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        SCHEMA_PERSON,
        null,
      ).length,
    ).toBe(1);
    // Domain lower-cased in the mailto identity key.
    expect(q(SCHEMA_EMAIL)[0]?.object.value).toBe("mailto:jane@example.com");
    expect(q(SCHEMA_NAME)[0]?.object.value).toBe("Jane");
    expect(q(AGENTIC_IDENTITY_STATUS)[0]?.object.value).toBe("unverified");
  });

  it("mints the same person node for the same address (reconcilable)", () => {
    const a = personIriFor(parse("From: A <x@y.com>"));
    const b = personIriFor(parse("From: Different Name <x@Y.com>"));
    expect(a).toBe(b);
  });

  it("mints a provisional anon node when there is no usable address", () => {
    const iri = personIriFor(parse("From: garbage-no-address"));
    expect(iri).toMatch(/^urn:agentic:person:anon-/);
  });

  it("omits schema:email for an invalid address (fail closed)", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(store, parse("From: nope <not an addr>"));
    expect(store.getQuads(personIri, SCHEMA_EMAIL, null, null).length).toBe(0);
  });

  it("attaches candidate WebIDs as UNVERIFIED hints, filtering unsafe ones", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(store, parse("From: a@b.com"), {
      candidateWebIds: [
        "https://id.example/#me",
        "mailto:x@y.com",
        "not a url",
        "https://id.example/#me",
      ],
    });
    const hints = store.getQuads(personIri, AGENTIC_CANDIDATE_WEB_ID, null, null);
    expect(hints.length).toBe(1); // deduped + only the http(s) one
    expect(hints[0]?.object.value).toBe("https://id.example/#me");
  });

  it("records the claimed (unverified) DKIM domain", () => {
    const store = new Store();
    const { personIri } = addSenderPerson(
      store,
      parse("From: a@b.com\r\nDKIM-Signature: v=1; d=mail.example.com; b=x"),
    );
    expect(store.getQuads(personIri, AGENTIC_DKIM_DOMAIN_CLAIM, null, null)[0]?.object.value).toBe(
      "mail.example.com",
    );
  });

  it("never emits an IRIREF-breakout character even from a hostile display name", () => {
    const store = new Store();
    addSenderPerson(store, parse('From: "<script>" <a@b.com>'));
    for (const q of store) {
      expect(q.subject.value).not.toMatch(/[\r\n]/);
      if (q.object.termType === "NamedNode") expect(q.object.value).not.toMatch(/[<>"{}|\\^`]/);
    }
  });
});
