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
    const auth = namedNode(`${safeContainer}.acl#owner`);
    store.addQuad(auth, namedNode(RDF_TYPE), namedNode(`${ACL}Authorization`));
    store.addQuad(auth, namedNode(`${ACL}agent`), namedNode(safeOwner));
    store.addQuad(auth, namedNode(`${ACL}accessTo`), namedNode(safeContainer));
    store.addQuad(auth, namedNode(`${ACL}default`), namedNode(safeContainer));
    store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`));
    store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`));
    store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`));
    const writer = new Writer({ format: "text/turtle", prefixes: { acl: ACL } });
    writer.addQuads([...store]);
    return new Promise((resolve, reject) => {
        writer.end((error, result) => (error ? reject(error) : resolve(result)));
    });
}
//# sourceMappingURL=acl.js.map