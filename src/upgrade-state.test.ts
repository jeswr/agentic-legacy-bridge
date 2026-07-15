// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import type { UpgradeOffer } from "./negotiate.js";
import {
  assertRelationshipInvariant,
  initialRelationship,
  parseRelationship,
  type RelationshipState,
  serializeRelationship,
  transition,
} from "./upgrade-state.js";

const PERSON = "urn:agentic:person:c2xhY2s6VDpV";
const WEBID = "https://bob.example/profile/card#me";
const CARD = "https://bob.example/agent-card.json";
const AT = new Date("2026-07-05T00:00:00.000Z");

const rdfOffer: UpgradeOffer = {
  targetChannel: "rdf",
  required: false,
  protocolHash: "abc123",
  protocolSource: "https://w3id.org/jeswr/a2a-rdf/v1",
};

/** Drive a fresh relationship up to `card-discovered`. */
function toCardDiscovered(): RelationshipState {
  let s = initialRelationship(PERSON, "email", AT);
  s = expectOk(transition(s, { kind: "bridge-detected" }, AT));
  s = expectOk(transition(s, { kind: "identity-verified", webId: WEBID }, AT));
  s = expectOk(transition(s, { kind: "card-discovered", agentCardUrl: CARD }, AT));
  return s;
}

function expectOk(r: ReturnType<typeof transition>): RelationshipState {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  assertRelationshipInvariant(r.state);
  return r.state;
}

describe("initialRelationship", () => {
  it("creates a legacy-only relationship on the email floor", () => {
    const s = initialRelationship(PERSON, "email", AT);
    expect(s).toMatchObject({ personIri: PERSON, state: "legacy-only", currentChannel: "email" });
    assertRelationshipInvariant(s);
  });

  it("rejects an unsafe personIri", () => {
    expect(() => initialRelationship("not a urn or url", "email", AT)).toThrow();
  });
});

describe("transition — the happy ratchet", () => {
  it("walks legacy-only → … → upgraded, preserving the invariant at each step", () => {
    const card = toCardDiscovered();
    expect(card.state).toBe("card-discovered");
    expect(card.verifiedWebId).toBe(WEBID);
    expect(card.agentCardUrl).toBe(CARD);

    const offered = expectOk(transition(card, { kind: "offer", offer: rdfOffer }, AT));
    expect(offered.state).toBe("offer-pending");
    expect(offered.pendingOffer?.targetChannel).toBe("rdf");

    const upgraded = expectOk(
      transition(
        offered,
        { kind: "offer-response", response: { accept: true, protocolHash: "abc123" } },
        AT,
      ),
    );
    expect(upgraded.state).toBe("upgraded");
    expect(upgraded.currentChannel).toBe("rdf");
    expect(upgraded.upgradedChannel).toBe("rdf");
  });
});

describe("transition — fail-closed security rules", () => {
  it("GATES discovery on verification (card-discovered is illegal before identity-verified)", () => {
    const s = expectOk(
      transition(initialRelationship(PERSON, "email", AT), { kind: "bridge-detected" }, AT),
    );
    const r = transition(s, { kind: "card-discovered", agentCardUrl: CARD }, AT);
    expect(r.ok).toBe(false);
  });

  it("refuses identity-verified with an unsafe WebID", () => {
    const s = expectOk(
      transition(initialRelationship(PERSON, "email", AT), { kind: "bridge-detected" }, AT),
    );
    const r = transition(s, { kind: "identity-verified", webId: "javascript:alert(1)" }, AT);
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses card-discovered with an unsafe card URL", () => {
    let s = expectOk(
      transition(initialRelationship(PERSON, "email", AT), { kind: "bridge-detected" }, AT),
    );
    s = expectOk(transition(s, { kind: "identity-verified", webId: WEBID }, AT));
    const r = transition(s, { kind: "card-discovered", agentCardUrl: "ftp://evil/card" }, AT);
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses an offer that targets the email floor (not an upgrade)", () => {
    const card = toCardDiscovered();
    const r = transition(
      card,
      { kind: "offer", offer: { targetChannel: "email", required: false } },
      AT,
    );
    expect(r).toMatchObject({ ok: false });
  });

  it.each([
    { ...rdfOffer, protocolHash: "" },
    { ...rdfOffer, protocolHash: "x".repeat(257) },
    { ...rdfOffer, protocolHash: "ok\nspoof" },
    { ...rdfOffer, protocolSource: "javascript:alert(1)" },
  ])("refuses malformed or unsafe offer fields", (offer) => {
    expect(transition(toCardDiscovered(), { kind: "offer", offer }, AT)).toMatchObject({
      ok: false,
    });
  });

  it("ABORTS on accept + protocol-hash mismatch", () => {
    const offered = expectOk(
      transition(toCardDiscovered(), { kind: "offer", offer: rdfOffer }, AT),
    );
    const r = expectOk(
      transition(
        offered,
        { kind: "offer-response", response: { accept: true, protocolHash: "WRONG" } },
        AT,
      ),
    );
    expect(r.state).toBe("aborted");
    expect(r.abortReason).toMatch(/hash/i);
  });

  it("ABORTS on decline of a REQUIRED (security-bearing) offer", () => {
    const requiredOffer: UpgradeOffer = { targetChannel: "rdf", required: true };
    const offered = expectOk(
      transition(toCardDiscovered(), { kind: "offer", offer: requiredOffer }, AT),
    );
    const r = expectOk(
      transition(offered, { kind: "offer-response", response: { accept: false } }, AT),
    );
    expect(r.state).toBe("aborted");
  });

  it("STAYS at card-discovered on decline of an OPTIONAL offer (floor still works)", () => {
    const offered = expectOk(
      transition(toCardDiscovered(), { kind: "offer", offer: rdfOffer }, AT),
    );
    const r = expectOk(
      transition(offered, { kind: "offer-response", response: { accept: false } }, AT),
    );
    expect(r.state).toBe("card-discovered");
    expect(r.currentChannel).toBe("email");
  });

  it("falls back to the floor on a NON-security transport failure", () => {
    const offered = expectOk(
      transition(toCardDiscovered(), { kind: "offer", offer: rdfOffer }, AT),
    );
    const upgraded = expectOk(
      transition(
        offered,
        { kind: "offer-response", response: { accept: true, protocolHash: "abc123" } },
        AT,
      ),
    );
    const r = expectOk(
      transition(upgraded, { kind: "transport-failure", securityBearing: false }, AT),
    );
    expect(r.state).toBe("card-discovered");
    expect(r.currentChannel).toBe("email"); // floor restored
  });

  it("NEVER silently falls back a SECURITY-bearing transport failure — it aborts + surfaces", () => {
    const offered = expectOk(
      transition(toCardDiscovered(), { kind: "offer", offer: rdfOffer }, AT),
    );
    const upgraded = expectOk(
      transition(
        offered,
        { kind: "offer-response", response: { accept: true, protocolHash: "abc123" } },
        AT,
      ),
    );
    const r = expectOk(
      transition(upgraded, { kind: "transport-failure", securityBearing: true }, AT),
    );
    expect(r.state).toBe("aborted");
    expect(r.abortReason).toMatch(/security-bearing/i);
  });

  it("allows an owner revocation from a post-verification state (→ bridge-detected)", () => {
    const card = toCardDiscovered();
    const r = expectOk(transition(card, { kind: "revoke-verification" }, AT));
    expect(r.state).toBe("bridge-detected");
    expect(r.verifiedWebId).toBeUndefined();
    expect(r.agentCardUrl).toBeUndefined();
  });

  it("allows a retry offer from aborted (an abort ends an exchange, not the relationship)", () => {
    const offered = expectOk(
      transition(
        toCardDiscovered(),
        { kind: "offer", offer: { targetChannel: "rdf", required: true } },
        AT,
      ),
    );
    const aborted = expectOk(
      transition(offered, { kind: "offer-response", response: { accept: false } }, AT),
    );
    expect(aborted.state).toBe("aborted");
    const retry = expectOk(transition(aborted, { kind: "offer", offer: rdfOffer }, AT));
    expect(retry.state).toBe("offer-pending");
  });
});

describe("transition — illegal transitions are refused fail-closed", () => {
  const legacy = initialRelationship(PERSON, "email", AT);
  const cases: Array<[string, ReturnType<typeof transition>]> = [
    [
      "identity-verified from legacy-only",
      transition(legacy, { kind: "identity-verified", webId: WEBID }, AT),
    ],
    ["offer from legacy-only", transition(legacy, { kind: "offer", offer: rdfOffer }, AT)],
    [
      "offer-response from legacy-only",
      transition(legacy, { kind: "offer-response", response: { accept: true } }, AT),
    ],
    ["transport-failure from legacy-only", transition(legacy, { kind: "transport-failure" }, AT)],
    [
      "revoke-verification from legacy-only",
      transition(legacy, { kind: "revoke-verification" }, AT),
    ],
    [
      "bridge-detected from card-discovered",
      transition(toCardDiscovered(), { kind: "bridge-detected" }, AT),
    ],
    [
      "transport-failure from card-discovered",
      transition(toCardDiscovered(), { kind: "transport-failure" }, AT),
    ],
  ];
  for (const [name, result] of cases) {
    it(`rejects ${name}`, () => {
      expect(result.ok).toBe(false);
    });
  }
});

describe("serialize / parse round-trip (pod persistence)", () => {
  const Resource = "https://alice.example/rel/bob.ttl";

  async function roundTrip(state: RelationshipState): Promise<RelationshipState | undefined> {
    const turtle = await serializeRelationship(state, Resource);
    return parseRelationship(turtle, Resource);
  }

  it("round-trips an identity-verified state", async () => {
    let s = expectOk(
      transition(initialRelationship(PERSON, "email", AT), { kind: "bridge-detected" }, AT),
    );
    s = expectOk(transition(s, { kind: "identity-verified", webId: WEBID }, AT));
    expect(await roundTrip(s)).toEqual(s);
  });

  it("round-trips every pending-offer binding", async () => {
    const offered = expectOk(
      transition(
        toCardDiscovered(),
        {
          kind: "offer",
          offer: {
            targetChannel: "a2a",
            required: true,
            protocolHash: "h1",
            protocolSource: "https://example.test/protocol/v1",
          },
        },
        AT,
      ),
    );
    const back = await roundTrip(offered);
    expect(back?.state).toBe("offer-pending");
    expect(back?.pendingOffer).toMatchObject({
      targetChannel: "a2a",
      required: true,
      protocolHash: "h1",
      protocolSource: "https://example.test/protocol/v1",
    });
  });

  it("round-trips an upgraded state", async () => {
    const offered = expectOk(
      transition(toCardDiscovered(), { kind: "offer", offer: rdfOffer }, AT),
    );
    const upgraded = expectOk(
      transition(
        offered,
        { kind: "offer-response", response: { accept: true, protocolHash: "abc123" } },
        AT,
      ),
    );
    const back = await roundTrip(upgraded);
    expect(back?.state).toBe("upgraded");
    expect(back?.upgradedChannel).toBe("rdf");
    expect(back?.currentChannel).toBe("rdf");
  });

  it("returns undefined for an unknown/blank state document (fail-closed)", () => {
    expect(parseRelationship("", "https://alice.example/rel/bob.ttl")).toBeUndefined();
    expect(parseRelationship("<x> <y> <z> .", "https://alice.example/rel/bob.ttl")).toBeUndefined();
  });

  it("refuses to serialise to an unsafe resource URL", async () => {
    await expect(serializeRelationship(toCardDiscovered(), "javascript:evil")).rejects.toThrow();
  });
});
