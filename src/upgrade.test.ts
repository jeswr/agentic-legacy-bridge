// AUTHORED-BY Claude Fable 5
import { describe, expect, it, vi } from "vitest";
import type { UpgradeOffer } from "./negotiate.js";
import {
  createGuardedUpgradeTransport,
  createPodRelationshipStore,
  decodeUpgradeResponse,
  discoverCard,
  encodeUpgradeOffer,
  InMemoryRelationshipStore,
  offerAndNegotiate,
  RelationshipConflictError,
  recordBridgeDetected,
  recordIdentityVerified,
  type UpgradeTransport,
} from "./upgrade.js";

const PERSON = "urn:agentic:person:c2xhY2s6VDpV";
const WEBID = "https://bob.example/profile/card#me";
const CARD = "https://bob.example/agent-card.json";
const CONTAINER = "https://alice.example/rel/";
const AT = new Date("2026-07-05T00:00:00.000Z");
const rdfOffer: UpgradeOffer = { targetChannel: "rdf", required: false, protocolHash: "h" };

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a defined value");
  return x;
}

async function driveToCard(store: InMemoryRelationshipStore): Promise<void> {
  await recordBridgeDetected(store, PERSON, AT);
  await recordIdentityVerified(store, PERSON, WEBID, AT);
  await discoverCard(store, PERSON, async () => ({ agentCardUrl: CARD }), AT);
}

describe("InMemoryRelationshipStore — optimistic concurrency (CAS)", () => {
  it("bumps a version on each save and refuses a stale write", async () => {
    const store = new InMemoryRelationshipStore();
    await recordBridgeDetected(store, PERSON, AT); // creates version 1
    const loaded = await store.load(PERSON);
    expect(loaded?.version).toBe("1");

    // A stale save (wrong expectedVersion) conflicts.
    await expect(
      store.save({ ...must(loaded).state, state: "legacy-only" }, "0"),
    ).rejects.toBeInstanceOf(RelationshipConflictError);
  });
});

describe("orchestration — the ratchet is persisted", () => {
  it("drives legacy → verified → card → upgraded through the store", async () => {
    const store = new InMemoryRelationshipStore();
    await driveToCard(store);
    const transport: UpgradeTransport = async () => ({ accept: true, protocolHash: "h" });
    const r = await offerAndNegotiate(store, PERSON, rdfOffer, transport, AT);
    expect(r.ok).toBe(true);
    const loaded = await store.load(PERSON);
    expect(loaded?.state.state).toBe("upgraded");
    expect(loaded?.state.currentChannel).toBe("rdf");
  });
});

describe("orchestration — SSRF gating (verified endpoints only)", () => {
  it("calls the card-discovery seam ONLY with the VERIFIED WebID", async () => {
    const store = new InMemoryRelationshipStore();
    await recordBridgeDetected(store, PERSON, AT);
    await recordIdentityVerified(store, PERSON, WEBID, AT);
    const discover = vi.fn(async () => ({ agentCardUrl: CARD }));
    await discoverCard(store, PERSON, discover, AT);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith(WEBID);
  });

  it("REFUSES discovery before identity-verified (never fetches on an unverified handle)", async () => {
    const store = new InMemoryRelationshipStore();
    await recordBridgeDetected(store, PERSON, AT); // only bridge-detected
    const discover = vi.fn(async () => ({ agentCardUrl: CARD }));
    const r = await discoverCard(store, PERSON, discover, AT);
    expect(r.ok).toBe(false);
    expect(discover).not.toHaveBeenCalled();
  });

  it("targets the offer transport at the VERIFIED card endpoint only", async () => {
    const store = new InMemoryRelationshipStore();
    await driveToCard(store);
    const seen: string[] = [];
    const transport: UpgradeTransport = async ({ target }) => {
      seen.push(target);
      return { accept: false };
    };
    await offerAndNegotiate(store, PERSON, rdfOffer, transport, AT);
    expect(seen).toEqual([CARD]);
  });
});

describe("orchestration — persistence keys on the CANONICAL personIri", () => {
  it("progresses the ratchet when the caller uses a non-canonical HTTP personIri", async () => {
    const store = new InMemoryRelationshipStore();
    // A default-port HTTP IRI canonicalises (safeHttpIri drops :443) — load + save MUST
    // still resolve to the same key, or the state machine gets stuck re-creating initial.
    const nonCanonical = "https://carol.example:443/card#me";
    const b = await recordBridgeDetected(store, nonCanonical, AT);
    expect(b.ok).toBe(true);
    // A second advance with the SAME non-canonical arg must find the bridge-detected
    // state (not re-create legacy-only, which would make identity-verified illegal).
    const v = await recordIdentityVerified(store, nonCanonical, WEBID, AT);
    expect(v.ok).toBe(true);
    const loaded = await store.load(nonCanonical);
    expect(loaded?.state.state).toBe("identity-verified");
    // The persisted personIri is the canonical form.
    expect(loaded?.state.personIri).toBe("https://carol.example/card#me");
  });
});

describe("createGuardedUpgradeTransport — https-only, no payload-picked target", () => {
  it("aborts + throws when the peer response exceeds the size cap", async () => {
    const bigBody = "x".repeat(2000);
    const fetchImpl = (async () => new Response(bigBody, { status: 200 })) as typeof fetch;
    const transport = createGuardedUpgradeTransport({ fetch: fetchImpl, maxResponseBytes: 100 });
    await expect(transport({ target: CARD, payload: {} })).rejects.toThrow(/size cap/);
  });

  it("refuses a non-https target before any fetch", async () => {
    const fetchSpy = vi.fn();
    const transport = createGuardedUpgradeTransport({ fetch: fetchSpy as unknown as typeof fetch });
    await expect(transport({ target: "http://bob.example/x", payload: {} })).rejects.toThrow(
      /https/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an unsafe target before any fetch", async () => {
    const fetchSpy = vi.fn();
    const transport = createGuardedUpgradeTransport({ fetch: fetchSpy as unknown as typeof fetch });
    await expect(transport({ target: "not a url", payload: {} })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs JSON to a valid https target and parses the response", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(CARD);
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("agentic-upgrade-offer");
      return new Response(JSON.stringify({ accept: true }), { status: 200 });
    }) as typeof fetch;
    const transport = createGuardedUpgradeTransport({ fetch: fetchImpl });
    const out = await transport({ target: CARD, payload: encodeUpgradeOffer(rdfOffer) });
    expect(out).toEqual({ accept: true });
  });

  it("refuses to follow a redirect", async () => {
    const fetchImpl = (async () => new Response(null, { status: 302 })) as typeof fetch;
    const transport = createGuardedUpgradeTransport({ fetch: fetchImpl });
    await expect(transport({ target: CARD, payload: {} })).rejects.toThrow(/redirect/);
  });
});

describe("decodeUpgradeResponse — fail-closed", () => {
  it("accepts only a strict boolean accept:true", () => {
    expect(decodeUpgradeResponse({ accept: true })).toEqual({ accept: true });
    expect(decodeUpgradeResponse({ accept: true, protocolHash: "h" })).toEqual({
      accept: true,
      protocolHash: "h",
    });
  });

  it("treats anything else as a decline", () => {
    expect(decodeUpgradeResponse({ accept: "true" })).toEqual({ accept: false });
    expect(decodeUpgradeResponse({})).toEqual({ accept: false });
    expect(decodeUpgradeResponse(null)).toEqual({ accept: false });
    expect(decodeUpgradeResponse("accept")).toEqual({ accept: false });
    expect(decodeUpgradeResponse({ accept: 1 })).toEqual({ accept: false });
  });

  it("drops a non-string protocolHash", () => {
    expect(decodeUpgradeResponse({ accept: true, protocolHash: 5 })).toEqual({ accept: true });
  });
});

describe("createPodRelationshipStore — pod round-trip with CAS", () => {
  class FakePod {
    readonly store = new Map<string, { body: string; etag: string }>();
    fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const m = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (m === "GET") {
        const e = this.store.get(u);
        if (e === undefined) return new Response(null, { status: 404 });
        return new Response(e.body, { status: 200, headers: { etag: e.etag } });
      }
      if (m === "PUT") {
        const existing = this.store.get(u);
        if (headers["if-none-match"] === "*" && existing !== undefined) {
          return new Response(null, { status: 412 });
        }
        if (
          headers["if-match"] !== undefined &&
          (existing === undefined || existing.etag !== headers["if-match"])
        ) {
          return new Response(null, { status: 412 });
        }
        const nextNum = existing === undefined ? 1 : Number(existing.etag.slice(1)) + 1;
        const etag = `v${nextNum}`;
        this.store.set(u, { body: String(init?.body), etag });
        return new Response(null, { status: 201, headers: { etag } });
      }
      return new Response(null, { status: 405 });
    }) as typeof fetch;
  }

  it("saves (create), loads with a version, and re-saves with If-Match", async () => {
    const pod = new FakePod();
    const store = createPodRelationshipStore({ container: CONTAINER, writeFetch: pod.fetch });

    // In-memory drive, then persist to the pod.
    const mem = new InMemoryRelationshipStore();
    await driveToCard(mem);
    const card = must(await mem.load(PERSON)).state;

    await store.save(card); // create (If-None-Match: *)
    const loaded = await store.load(PERSON);
    expect(loaded?.state.state).toBe("card-discovered");
    expect(loaded?.version).toBe("v1");

    // A CAS re-save with the loaded version succeeds.
    await store.save({ ...card, currentChannel: "email" }, loaded?.version);
    expect((await store.load(PERSON))?.version).toBe("v2");
  });

  it("rejects a stale save with a conflict (If-Match mismatch → 412)", async () => {
    const pod = new FakePod();
    const store = createPodRelationshipStore({ container: CONTAINER, writeFetch: pod.fetch });
    const mem = new InMemoryRelationshipStore();
    await driveToCard(mem);
    const card = must(await mem.load(PERSON)).state;
    await store.save(card);
    await expect(store.save(card, "v-stale")).rejects.toBeInstanceOf(RelationshipConflictError);
  });

  it("returns undefined for a missing relationship (404)", async () => {
    const pod = new FakePod();
    const store = createPodRelationshipStore({ container: CONTAINER, writeFetch: pod.fetch });
    expect(await store.load(PERSON)).toBeUndefined();
  });
});
