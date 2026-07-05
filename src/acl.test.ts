// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Parser, type Quad } from "n3";
import { describe, expect, it } from "vitest";
import { buildBridgeAclTurtle, buildOwnerOnlyAclTurtle } from "./acl.js";

const ACL = "http://www.w3.org/ns/auth/acl#";

const CONTAINER = "https://pod.example/inbox/";
const OWNER = "https://pod.example/profile/card#me";
const INBOUND = "https://pod.example/agents/inbound#me";
const INTERPRETER = "https://pod.example/agents/interpreter#me";

/** The set of `acl:mode` local names granted to `agent` in an ACL Turtle document. */
function modesFor(ttl: string, agent: string): Set<string> {
  const quads: Quad[] = new Parser().parse(ttl);
  // The authorization node granting this agent.
  const authNode = quads.find(
    (q) => q.predicate.value === `${ACL}agent` && q.object.value === agent,
  )?.subject.value;
  if (authNode === undefined) return new Set();
  const modes = new Set<string>();
  for (const q of quads) {
    if (q.subject.value === authNode && q.predicate.value === `${ACL}mode`) {
      modes.add(q.object.value.replace(ACL, ""));
    }
  }
  return modes;
}

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

const GRAPHS = "https://pod.example/graphs/";
const bridgeAcl = () =>
  buildBridgeAclTurtle({
    container: CONTAINER,
    ownerWebId: OWNER,
    inboundWebId: INBOUND,
    interpreterWebId: INTERPRETER,
    graphsContainer: GRAPHS,
  });

describe("buildBridgeAclTurtle — the M2.5a least-privilege two-container split (§1.5)", () => {
  it("gives the interpreter Read-ONLY on the inbox anchors, Read+Write on the graphs container", async () => {
    const { inbox, graphs } = await bridgeAcl();
    // The load-bearing least-privilege property: NO Write on the inbox (immutable anchors),
    // Read+Write on the graphs container ONLY, NEVER Control on either.
    expect(modesFor(inbox, INTERPRETER)).toEqual(new Set(["Read"]));
    expect(modesFor(graphs as string, INTERPRETER)).toEqual(new Set(["Read", "Write"]));
    for (const doc of [inbox, graphs as string]) {
      expect(modesFor(doc, INTERPRETER).has("Control")).toBe(false);
      expect(modesFor(doc, INTERPRETER).has("Append")).toBe(false);
    }
  });

  it("the interpreter has NO Write on the inbox (a raw anchor / chat is immutable to it)", async () => {
    const { inbox } = await bridgeAcl();
    expect(modesFor(inbox, INTERPRETER).has("Write")).toBe(false);
  });

  it("grants the inbound webhook identity APPEND ONLY on BOTH containers", async () => {
    const { inbox, graphs } = await bridgeAcl();
    expect(modesFor(inbox, INBOUND)).toEqual(new Set(["Append"]));
    expect(modesFor(graphs as string, INBOUND)).toEqual(new Set(["Append"]));
  });

  it("keeps the owner at full Read/Write/Control on BOTH containers", async () => {
    const { inbox, graphs } = await bridgeAcl();
    expect(modesFor(inbox, OWNER)).toEqual(new Set(["Read", "Write", "Control"]));
    expect(modesFor(graphs as string, OWNER)).toEqual(new Set(["Read", "Write", "Control"]));
  });

  it("uses THREE DISTINCT WebIDs (webhook and sweep never share an identity)", async () => {
    const { inbox } = await bridgeAcl();
    const quads: Quad[] = new Parser().parse(inbox);
    const agents = new Set(
      quads.filter((q) => q.predicate.value === `${ACL}agent`).map((q) => q.object.value),
    );
    expect(agents).toEqual(new Set([OWNER, INBOUND, INTERPRETER]));
    // Never public.
    expect(inbox).not.toContain("agentClass");
    expect(inbox).not.toContain("foaf:Agent");
  });

  it("returns ONLY the inbox ACL (owner-only) when no bridge identity is supplied", async () => {
    const { inbox, graphs } = await buildBridgeAclTurtle({
      container: CONTAINER,
      ownerWebId: OWNER,
    });
    expect(graphs).toBeUndefined();
    const agents = new Parser()
      .parse(inbox)
      .filter((q) => q.predicate.value === `${ACL}agent`)
      .map((q) => q.object.value);
    expect(agents).toEqual([OWNER]);
  });

  it("SINGLE-CONTAINER default: no graphsContainer ⇒ interpreter Read+Write on the one container", async () => {
    // Matches the sweep's single-container default (its Write target is this container).
    const { inbox, graphs } = await buildBridgeAclTurtle({
      container: CONTAINER,
      ownerWebId: OWNER,
      inboundWebId: INBOUND,
      interpreterWebId: INTERPRETER,
    });
    expect(graphs).toBeUndefined();
    expect(modesFor(inbox, INTERPRETER)).toEqual(new Set(["Read", "Write"]));
    expect(modesFor(inbox, INTERPRETER).has("Control")).toBe(false);
    expect(modesFor(inbox, INBOUND)).toEqual(new Set(["Append"]));
    expect(modesFor(inbox, OWNER)).toEqual(new Set(["Read", "Write", "Control"]));
  });

  it("REJECTS graphsContainer === container (no isolation, fail closed)", async () => {
    await expect(
      buildBridgeAclTurtle({
        container: CONTAINER,
        ownerWebId: OWNER,
        interpreterWebId: INTERPRETER,
        graphsContainer: CONTAINER,
      }),
    ).rejects.toThrow();
  });

  it("fail-closed on an unsafe container / graphsContainer / WebID", async () => {
    await expect(
      buildBridgeAclTurtle({ container: "https://pod.example/inbox", ownerWebId: OWNER }),
    ).rejects.toThrow();
    await expect(
      buildBridgeAclTurtle({ container: CONTAINER, ownerWebId: "not-an-iri" }),
    ).rejects.toThrow();
    await expect(
      buildBridgeAclTurtle({
        container: CONTAINER,
        ownerWebId: OWNER,
        interpreterWebId: "ftp://x/#me",
        graphsContainer: GRAPHS,
      }),
    ).rejects.toThrow();
    await expect(
      buildBridgeAclTurtle({
        container: CONTAINER,
        ownerWebId: OWNER,
        interpreterWebId: INTERPRETER,
        graphsContainer: "https://pod.example/graphs", // not a container (no trailing /)
      }),
    ).rejects.toThrow();
  });

  it("REJECTS a role collision — the additive-WAC privilege escalation (fail closed)", async () => {
    // inbound === interpreter ⇒ the internet-facing + model-facing components share an id.
    await expect(
      buildBridgeAclTurtle({
        container: CONTAINER,
        ownerWebId: OWNER,
        inboundWebId: INBOUND,
        interpreterWebId: INBOUND,
        graphsContainer: GRAPHS,
      }),
    ).rejects.toThrow();
    // interpreter === owner ⇒ the interpreter would inherit Control via the owner grant.
    await expect(
      buildBridgeAclTurtle({
        container: CONTAINER,
        ownerWebId: OWNER,
        interpreterWebId: OWNER,
        graphsContainer: GRAPHS,
      }),
    ).rejects.toThrow();
    // inbound === owner ⇒ the append-only isolation is defeated.
    await expect(
      buildBridgeAclTurtle({ container: CONTAINER, ownerWebId: OWNER, inboundWebId: OWNER }),
    ).rejects.toThrow();
  });

  it("allows three distinct WebIDs that share a profile document (different fragments)", async () => {
    const { inbox, graphs } = await buildBridgeAclTurtle({
      container: CONTAINER,
      ownerWebId: "https://pod.example/profile/card#me",
      inboundWebId: "https://pod.example/profile/card#inbound",
      interpreterWebId: "https://pod.example/profile/card#interpreter",
      graphsContainer: GRAPHS,
    });
    expect(modesFor(inbox, "https://pod.example/profile/card#inbound")).toEqual(
      new Set(["Append"]),
    );
    expect(modesFor(inbox, "https://pod.example/profile/card#interpreter")).toEqual(
      new Set(["Read"]),
    );
    expect(modesFor(graphs as string, "https://pod.example/profile/card#interpreter")).toEqual(
      new Set(["Read", "Write"]),
    );
  });
});
