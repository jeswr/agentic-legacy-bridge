// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Owner-only WAC ACL — everything the bridge writes is OWNER-PRIVATE by default
 * (LEGACY-INTEROP.md §6). Inbound legacy messages are third-party data (the
 * SENDER's words); they are never auto-shared.
 *
 * An ACL is the most dangerous injection sink in the package — a `>` in `ownerWebId`
 * or `container` reaching `n3.Writer`'s un-escaped `<...>` could inject a public
 * `acl:agentClass foaf:Agent` grant, turning the owner-private container PUBLIC. So
 * both inputs MUST be canonical, injection-safe IRIs (validated BEFORE a single quad
 * is built — never a half-safe ACL), and the container must be UNAMBIGUOUS (path
 * ends in `/`, no query/fragment). Ported from `@jeswr/matrix-chat-to-pod`.
 */
import { DataFactory, Store, Writer } from "n3";
import { canonicalContainer, safeHttpIri } from "./safe-iri.js";
import { ACL, RDF_TYPE } from "./vocab.js";
const { namedNode } = DataFactory;
/** The four WAC access modes, as their `acl:` IRIs. */
const ACL_MODE = {
    Read: `${ACL}Read`,
    Write: `${ACL}Write`,
    Append: `${ACL}Append`,
    Control: `${ACL}Control`,
};
/**
 * Add ONE `acl:Authorization` (typed quads only — never hand-concatenated) granting
 * `agent` exactly `modes` over `container` and its descendants (`acl:accessTo` +
 * `acl:default`). `agent` MUST already be a canonical injection-safe IRI (validated by
 * the caller before a single quad is built).
 */
function addAuthorization(store, aclBase, fragment, agent, container, modes) {
    const auth = namedNode(`${aclBase}#${fragment}`);
    store.addQuad(auth, namedNode(RDF_TYPE), namedNode(`${ACL}Authorization`));
    store.addQuad(auth, namedNode(`${ACL}agent`), namedNode(agent));
    store.addQuad(auth, namedNode(`${ACL}accessTo`), namedNode(container));
    store.addQuad(auth, namedNode(`${ACL}default`), namedNode(container));
    for (const mode of modes) {
        store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(ACL_MODE[mode]));
    }
}
/** Serialise an ACL store to Turtle with the `acl:` prefix (n3.Writer, never by hand). */
function serializeAcl(store) {
    const writer = new Writer({ format: "text/turtle", prefixes: { acl: ACL } });
    writer.addQuads([...store]);
    return new Promise((resolve, reject) => {
        writer.end((error, result) => (error ? reject(error) : resolve(result)));
    });
}
/**
 * Build an owner-only WAC ACL Turtle document for `container`, granting the owner
 * `acl:Read`/`acl:Write`/`acl:Control` over the container AND its descendants
 * (`acl:accessTo` + `acl:default`), and NOTHING to anyone else. Built with
 * `n3.Writer` + typed quads — never hand-concatenated. Throws (fail-closed) if
 * either input is not a safe canonical IRI.
 */
export async function buildOwnerOnlyAclTurtle(container, ownerWebId) {
    const safeContainer = canonicalContainer(container);
    if (safeContainer === undefined) {
        throw new Error("owner-only ACL: container must be a safe http(s) container IRI ending in '/' with no query or fragment.");
    }
    const safeOwner = safeHttpIri(ownerWebId);
    if (safeOwner === undefined) {
        throw new Error("owner-only ACL: ownerWebId must be a safe absolute http(s) IRI.");
    }
    const store = new Store();
    addAuthorization(store, `${safeContainer}.acl`, "owner", safeOwner, safeContainer, [
        "Read",
        "Write",
        "Control",
    ]);
    return serializeAcl(store);
}
/**
 * Author the bridge's WAC ACL documents (§1.5 privilege split) across three DISTINCT WebIDs.
 * TWO layouts, matching the sweep's `graphsContainer`:
 *
 * | Identity | inbox (`container`) | graphs (`graphsContainer`, two-container only) |
 * |---|---|---|
 * | owner | Read/Write/Control | Read/Write/Control |
 * | `bridge-inbound` (webhook) | Append | Append |
 * | `bridge-interpreter` (sweep) | Read [+Write single-container] | Read/Write (never Control) |
 *
 * **Two-container (least privilege, `graphsContainer` supplied):** the interpreter — the
 * component that talks to an LLM over the network, the higher-risk surface — gets **NO Write on
 * the inbox**, so it can never rewrite a raw-message provenance anchor or a `.chat.ttl` even if
 * compromised; its Write is confined to the graphs container (which holds NOTHING but the
 * graphs it CAS-replaces). **Single-container (default):** graphs + anchors share `container`,
 * and WAC `acl:default` is subtree-wide, so the interpreter necessarily gets Read+Write on the
 * whole container — anchor-immutability is then a sweep-CODE invariant (it only ever PUTs the
 * graph resource), NOT ACL-enforced. This default MATCHES the sweep's single-container default
 * (both write graphs into `container`); the two-container least-privilege layout is a
 * maintainer-gated write-LAYOUT migration (see `sweepPendingInterpretations`). Either way the
 * webhook stays Append-only and neither bridge identity holds `acl:Control`.
 *
 * The DISTINCT-identity requirement is ENFORCED, not merely documented: WAC authorizations are
 * ADDITIVE (an agent's effective modes are the union of every authorization naming it), so
 * re-using one WebID across two roles would silently collapse the split. Any collision among
 * the (canonicalised) owner / inbound / interpreter WebIDs throws (fail-closed).
 *
 * Built with `n3.Writer` + typed quads — never hand-concatenated.
 *
 * @throws if a container is not a safe canonical container IRI, any supplied WebID is not a
 *   safe absolute http(s) IRI, two roles resolve to the SAME canonical WebID, or
 *   `graphsContainer` equals `container`.
 */
export async function buildBridgeAclTurtle(options) {
    const safeContainer = canonicalContainer(options.container);
    if (safeContainer === undefined) {
        throw new Error("bridge ACL: container must be a safe http(s) container IRI ending in '/' with no query or fragment.");
    }
    const safeOwner = safeHttpIri(options.ownerWebId);
    if (safeOwner === undefined) {
        throw new Error("bridge ACL: ownerWebId must be a safe absolute http(s) IRI.");
    }
    let safeInbound;
    if (options.inboundWebId !== undefined) {
        safeInbound = safeHttpIri(options.inboundWebId);
        if (safeInbound === undefined) {
            throw new Error("bridge ACL: inboundWebId must be a safe absolute http(s) IRI.");
        }
    }
    let safeInterpreter;
    if (options.interpreterWebId !== undefined) {
        safeInterpreter = safeHttpIri(options.interpreterWebId);
        if (safeInterpreter === undefined) {
            throw new Error("bridge ACL: interpreterWebId must be a safe absolute http(s) IRI.");
        }
    }
    let safeGraphs;
    if (options.graphsContainer !== undefined) {
        safeGraphs = canonicalContainer(options.graphsContainer);
        if (safeGraphs === undefined) {
            throw new Error("bridge ACL: graphsContainer must be a safe http(s) container IRI ending in '/' with no query or fragment.");
        }
        if (safeGraphs === safeContainer) {
            throw new Error("bridge ACL: graphsContainer must be DISTINCT from container (the graphs container isolates the interpreter's Write from the immutable anchors).");
        }
    }
    // Fail closed on ANY role collision (canonical equality) — the additive-WAC privilege
    // escalation (§1.5). Each supplied role MUST be a distinct WebID.
    if (safeInbound !== undefined && safeInbound === safeOwner) {
        throw new Error("bridge ACL: inboundWebId must differ from ownerWebId (privilege split).");
    }
    if (safeInterpreter !== undefined && safeInterpreter === safeOwner) {
        throw new Error("bridge ACL: interpreterWebId must differ from ownerWebId (privilege split).");
    }
    if (safeInbound !== undefined && safeInbound === safeInterpreter) {
        throw new Error("bridge ACL: inboundWebId must differ from interpreterWebId (the model-facing and internet-facing components must not share an identity).");
    }
    // TWO-CONTAINER when a distinct graphsContainer is supplied — the interpreter gets Read-only
    // on the inbox (least privilege: anchors immutable to it). SINGLE-CONTAINER otherwise — the
    // interpreter necessarily gets Read+Write on the one container (graphs and anchors share it,
    // and WAC `acl:default` is subtree-wide, so "Write graphs but not anchors" is inexpressible);
    // this MATCHES the sweep's single-container default (its Write target is this container).
    // Anchor-immutability is then a sweep-CODE invariant (it only ever PUTs the graph resource);
    // full ACL-enforced anchor-immutability is the two-container mode (a maintainer-gated
    // write-LAYOUT migration — see `sweepPendingInterpretations`).
    const twoContainer = safeGraphs !== undefined;
    const interpreterInboxModes = twoContainer ? ["Read"] : ["Read", "Write"];
    // --- inbox ACL: owner RWC, inbound Append, interpreter Read(+Write in single-container) ---
    const inboxBase = `${safeContainer}.acl`;
    const inboxStore = new Store();
    addAuthorization(inboxStore, inboxBase, "owner", safeOwner, safeContainer, [
        "Read",
        "Write",
        "Control",
    ]);
    if (safeInbound !== undefined) {
        addAuthorization(inboxStore, inboxBase, "inbound", safeInbound, safeContainer, ["Append"]);
    }
    if (safeInterpreter !== undefined) {
        // NEVER Control. Read-only in the two-container layout (anchors immutable); Read+Write in
        // the single-container layout (the graphs it CAS-replaces live in this container).
        addAuthorization(inboxStore, inboxBase, "interpreter", safeInterpreter, safeContainer, interpreterInboxModes);
    }
    const inbox = await serializeAcl(inboxStore);
    if (safeGraphs === undefined || safeInterpreter === undefined) {
        return { inbox };
    }
    // --- graphs ACL: owner RWC, inbound Append (creates the initial Pending graph),
    //     interpreter Read+Write (CAS-replace) — NEVER Control ---
    const graphsBase = `${safeGraphs}.acl`;
    const graphsStore = new Store();
    addAuthorization(graphsStore, graphsBase, "owner", safeOwner, safeGraphs, [
        "Read",
        "Write",
        "Control",
    ]);
    if (safeInbound !== undefined) {
        addAuthorization(graphsStore, graphsBase, "inbound", safeInbound, safeGraphs, ["Append"]);
    }
    addAuthorization(graphsStore, graphsBase, "interpreter", safeInterpreter, safeGraphs, [
        "Read",
        "Write",
    ]);
    const graphs = await serializeAcl(graphsStore);
    return { inbox, graphs };
}
//# sourceMappingURL=acl.js.map