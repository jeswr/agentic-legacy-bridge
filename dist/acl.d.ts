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
//# sourceMappingURL=acl.d.ts.map