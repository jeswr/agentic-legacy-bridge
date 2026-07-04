/**
 * `importInbound` — the (thin) orchestration that pulls inbound messages from a
 * {@link ChannelAdapter}, parses + interprets each, and writes them OWNER-PRIVATE
 * into a Solid pod (LEGACY-INTEROP.md §7 `importInbound`).
 *
 * Per message it writes three resources under an owner-locked container:
 *  - `<slug>.eml`      — the byte-exact raw bytes (the provenance anchor; the
 *                        extension follows the channel's `rawMediaType` — `.eml`
 *                        for `message/rfc822`, `.json` for event payloads);
 *  - `<slug>.ttl`      — the agentic graph (raw anchor + sender Person + the §3b
 *                        reliability-tagged interpretations);
 *  - `<slug>.chat.ttl` — the `@jeswr/solid-chat-interop` CanonicalMessage (for /chat).
 *
 * M2.0: the pipeline is CHANNEL-NEUTRAL — each raw message is parsed by the
 * adapter's own hardened `parse` into a `BridgeMessage` (email is the first
 * adapter, behaving exactly as M1's hard-coded `parseEmail` did).
 *
 * The owner-only ACL is written FIRST (the container is locked BEFORE any content
 * lands in it — the fail-closed precedent). Every write goes through the caller's
 * INJECTABLE authed `fetch` (the pod is the user's own trusted origin), sets
 * `redirect: "manual"` and refuses a 3xx, and is scope-guarded strictly within the
 * configured container. A malformed message is SKIPPED (never aborts the batch); a
 * write failure THROWS (never silently loses data).
 */
import type { ChannelAdapter } from "./channel.js";
import { type Interpreter } from "./interpret.js";
import type { BridgeMessage } from "./message.js";
/** Options for {@link importInbound}. */
export interface ImportInboundOptions {
    /** The channel adapter to pull inbound messages from. */
    readonly adapter: ChannelAdapter;
    /**
     * An authenticated Solid `fetch` for the POD writes (DPoP/Bearer). Injectable so
     * the importer is unit-testable without a live server; the caller owns its auth.
     * NOT routed through the SSRF guard — the pod is the user's own trusted origin.
     */
    readonly writeFetch: typeof globalThis.fetch;
    /** The owner-locked pod container to write into (must end with `/`, no query/fragment). */
    readonly container: string;
    /** The owner WebID granted full control by the default owner-only ACL. */
    readonly ownerWebId: string;
    /** The interpreter to use (defaults to the hermetic deterministic reference). */
    readonly interpreter?: Interpreter;
    /** The interpreting agent's WebID (`prov:wasAssociatedWith` on each interpretation). */
    readonly interpretingAgentWebId?: string;
    /** The ODRL mandate the interpreting agent acts under (`prov:hadPlan`). */
    readonly mandateIri?: string;
    /** Supply UNVERIFIED candidate WebIDs for a sender (already discovered elsewhere). */
    readonly candidateWebIdsFor?: (message: BridgeMessage) => readonly string[] | undefined;
    /** Write the owner-only ACL first (default `true`). */
    readonly writeAcl?: boolean;
    /** "Now" for the interpreter's relative-date resolution (deterministic tests). */
    readonly now?: Date;
    /** Override the base (extension-less) in-pod URL for a message id. */
    readonly baseUrlFor?: (id: string) => string;
}
/** The outcome of an {@link importInbound} run. */
export interface ImportInboundResult {
    /** Number of messages fully written. */
    readonly written: number;
    /** Total interpretation nodes written across all messages. */
    readonly interpretations: number;
    /** Number of messages skipped (unparseable / unsafe slug). */
    readonly skipped: number;
}
/**
 * Import a channel's inbound messages into a Solid pod (owner-private). Returns a
 * count summary. See the module doc for the write layout + fail-closed posture.
 *
 * @throws if `container` is not a safe container IRI, `writeAcl` is set without an
 *   `ownerWebId`, or any pod write fails (redirect / non-2xx).
 */
export declare function importInbound(options: ImportInboundOptions): Promise<ImportInboundResult>;
//# sourceMappingURL=import.d.ts.map