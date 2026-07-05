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
/**
 * Build an owner-only WAC ACL Turtle document for `container`, granting the owner
 * `acl:Read`/`acl:Write`/`acl:Control` over the container AND its descendants
 * (`acl:accessTo` + `acl:default`), and NOTHING to anyone else. Built with
 * `n3.Writer` + typed quads — never hand-concatenated. Throws (fail-closed) if
 * either input is not a safe canonical IRI.
 */
export declare function buildOwnerOnlyAclTurtle(container: string, ownerWebId: string): Promise<string>;
/** Options for {@link buildBridgeAclTurtle}. */
export interface BridgeAclOptions {
    /**
     * The INBOX container (must end `/`, no query/fragment) — holds the IMMUTABLE raw-message
     * anchors + `.chat.ttl` canonical resources. The interpreter is granted `acl:Read` ONLY
     * here, so it can never rewrite a provenance anchor.
     */
    readonly container: string;
    /** The pod OWNER — granted full `Read`/`Write`/`Control` on every container. */
    readonly ownerWebId: string;
    /**
     * The INBOUND webhook identity (`bridge-inbound`) — granted `acl:Append` ONLY. It can
     * create new resources (the raw anchor, chat, and the initial `Pending` graph) but can
     * NEVER read, modify, or delete anything already there (tamper-evidence by construction,
     * M2.5a §1.5). Omit to leave it ungranted.
     */
    readonly inboundWebId?: string;
    /**
     * The decoupled-sweep identity (`bridge-interpreter`) — never `acl:Control`. Its Write scope
     * depends on the layout (see {@link graphsContainer}): TWO-CONTAINER ⇒ `acl:Read` on the
     * inbox + `acl:Read`/`acl:Write` on the graphs container (anchors immutable to it — least
     * privilege); SINGLE-CONTAINER ⇒ `acl:Read`/`acl:Write` on the one container (graphs +
     * anchors share it, so anchor-immutability is a sweep-CODE invariant, matching the sweep's
     * single-container default). A DISTINCT WebID from {@link inboundWebId}.
     */
    readonly interpreterWebId?: string;
    /**
     * OPTIONAL dedicated MUTABLE-GRAPHS container (must end `/`, distinct from {@link container})
     * enabling the §1.5 LEAST-PRIVILEGE two-container layout: it holds ONLY the interpretation
     * graphs the sweep CAS-replaces, so granting the interpreter container-wide Write HERE gives
     * it no power over any immutable anchor (which stay in {@link container}, Read-only to it).
     * Omitted ⇒ the single-container layout (the interpreter gets Read+Write on {@link container}
     * — the current webhook layout). NB wiring the two-container write path (webhook writes graphs
     * here, anchors/chat in the inbox; the sweep's `graphsContainer` set to match) is a
     * write-LAYOUT migration tracked as a CORE follow-up (see the sweep module doc).
     */
    readonly graphsContainer?: string;
}
/** The two ACL documents authored by {@link buildBridgeAclTurtle}. */
export interface BridgeAclDocuments {
    /**
     * The `<container>.acl` Turtle (inbox: owner RWC, inbound Append, interpreter Read-only in
     * the two-container layout / Read+Write in the single-container layout).
     */
    readonly inbox: string;
    /**
     * The `<graphsContainer>.acl` Turtle (graphs: owner RWC, inbound Append, interpreter
     * Read+Write). Present iff both {@link BridgeAclOptions.interpreterWebId} and
     * {@link BridgeAclOptions.graphsContainer} were supplied.
     */
    readonly graphs?: string;
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
export declare function buildBridgeAclTurtle(options: BridgeAclOptions): Promise<BridgeAclDocuments>;
//# sourceMappingURL=acl.d.ts.map