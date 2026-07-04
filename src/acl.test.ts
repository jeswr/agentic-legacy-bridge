// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Parser } from "n3";
import { describe, expect, it } from "vitest";
import { buildOwnerOnlyAclTurtle } from "./acl.js";

const ACL = "http://www.w3.org/ns/auth/acl#";

const CONTAINER = "https://pod.example/inbox/";
const OWNER = "https://pod.example/profile/card#me";

describe("buildOwnerOnlyAclTurtle", () => {
  it("grants the owner Read/Write/Control over the container + descendants, nothing public", async () => {
    const ttl = await buildOwnerOnlyAclTurtle(CONTAINER, OWNER);
    expect(ttl).toContain(`acl:agent <${OWNER}>`);
    expect(ttl).toContain(`acl:accessTo <${CONTAINER}>`);
    expect(ttl).toContain(`acl:default <${CONTAINER}>`);
    expect(ttl).toContain("acl:Read");
    expect(ttl).toContain("acl:Write");
    expect(ttl).toContain("acl:Control");
    // Never public.
    expect(ttl).not.toContain("foaf:Agent");
    expect(ttl).not.toContain("agentClass");
  });

  it("rejects an unsafe container (fail-closed)", async () => {
    await expect(buildOwnerOnlyAclTurtle("https://pod.example/inbox", OWNER)).rejects.toThrow();
    await expect(
      buildOwnerOnlyAclTurtle("https://pod.example/inbox/?x=/", OWNER),
    ).rejects.toThrow();
  });

  it("rejects an owner WebID whose AUTHORITY carries a breakout char", async () => {
    // `>` in the authority makes the URL unparseable → fail-closed reject.
    await expect(buildOwnerOnlyAclTurtle(CONTAINER, "https://x>y/#me")).rejects.toThrow();
  });

  it("NEUTRALISES an owner WebID injection in the fragment (no public-grant breakout)", async () => {
    // A `>`/`;` in the fragment is percent-encoded (not a breakout) so the whole
    // hostile string lands INSIDE one `acl:agent` IRI — never as separate triples.
    // Assert on the parsed GRAPH structure (the substring appears only within the IRI).
    const ttl = await buildOwnerOnlyAclTurtle(
      CONTAINER,
      "https://x/#me> ; acl:agentClass foaf:Agent ; <#o> a <",
    );
    const quads = new Parser().parse(ttl);
    // No public-grant triple was injected.
    expect(quads.some((q) => q.predicate.value === `${ACL}agentClass`)).toBe(false);
    expect(quads.some((q) => q.object.value === "http://xmlns.com/foaf/0.1/Agent")).toBe(false);
    // Exactly one acl:agent, and its object is a single encoded IRI containing the breakout.
    const agents = quads.filter((q) => q.predicate.value === `${ACL}agent`);
    expect(agents.length).toBe(1);
    expect(agents[0]?.object.value).toContain("%3E");
  });
});
