/**
 * `sweepPendingInterpretations` — the decoupled, Write-privileged LLM-interpretation
 * sweep (M2.5a, design `docs/M2-DESIGN.md` §3.6 + the M2.5/M3 design §1).
 *
 * The M2.4 webhook path acks in <3 s with DETERMINISTIC interpretations only and marks
 * the graph `agentic:interpretationStatus agentic:Pending`. This worker is the SEPARATE,
 * out-of-band process that:
 *
 *   1. lists the GRAPHS container (`ldp:contains`, parsed with `@jeswr/fetch-rdf`'s
 *      `parseRdf` — the suite RDF rule, never a bespoke parse) and filters the `*.ttl`
 *      graph resources whose status is `agentic:Pending` (the graphs container defaults to
 *      the inbox — single-container layout — or is a distinct §1.5 least-privilege container);
 *   2. for each, reconstructs the {@link BridgeMessage} by RE-PARSING the byte-exact raw
 *      anchor — read from the graph's `schema:url`, guarded within the INBOX container (so
 *      the anchors stay in the inbox even when the graphs live elsewhere), the provenance
 *      ground truth keyed by the reversible {@link slugToMessageId} slug — through the SAME
 *      hardened channel parse the webhook used;
 *   3. runs the slot-contained live-LLM interpreter ({@link LlmInterpreter.interpretDetailed})
 *      + the deterministic pass, carrying the M2.3 reliability discipline verbatim (a
 *      low-confidence datum stays reified/audited, never bare-asserted);
 *   4. CAS-replaces the graph with `If-Match` — two concurrent sweeps race BENIGNLY
 *      (exactly one write wins; the loser's `412` is a logged no-op, never a double-write);
 *   5. bounds the retry: a failed attempt increments `agentic:interpretationAttempts` and,
 *      past the cap, writes the terminal `agentic:InterpretationFailed` — so a permanently
 *      failing resource cannot loop forever.
 *
 * ## Stateless / pod-as-state / hermetic
 *
 * There is NO in-process state — the pod is the only state, so any clock (cron CLI, a
 * scheduled serverless invocation, an opportunistic post-2xx `waitUntil`) can invoke it
 * and two invocations are horizontally safe. Every side-effect is an INJECTED seam
 * (`readFetch`/`writeFetch`/`extractor`/`now`), so the whole worker runs with NO live
 * network and NO credentials under test.
 *
 * ## Isolation (load-bearing, §1.5)
 *
 * The sweep runs as the `bridge-interpreter` identity — `acl:Read` on the inbox anchors +
 * `acl:Read`/`acl:Write` on the mutable GRAPHS container, NEVER `acl:Control` — DISTINCT from
 * the Append-only `bridge-inbound` webhook identity (the least-privilege two-container ACL is
 * authored by {@link import("./acl.js").buildBridgeAclTurtle}). The model-facing (LLM)
 * component and the internet-facing (webhook) component never share a credential or privilege:
 * a compromised sweep cannot alter access (no `Control`), forge source-authenticated inbox
 * items (no channel secrets), NOR rewrite a raw provenance anchor / `.chat.ttl` (no Write on
 * the inbox — its Write is confined to the graphs container, which holds only interpretation
 * graphs). NB `buildBridgeAclTurtle` enforces this by REQUIRING a dedicated graphs container
 * for the interpreter's Write (a single-container layout cannot express "Write graphs but not
 * anchors" in WAC). **CORE follow-up (not wired here):** placing graph resources in that
 * dedicated container (and anchors/chat in the inbox) is a webhook + importInbound + sweep
 * write-LAYOUT change — the sweep today reads/writes graphs and reads anchors in ONE container
 * (the current webhook layout); the two-container split is a maintainer-gated layout migration.
 *
 * ## Containment survives the sweep (§1.4, S2)
 *
 * The extractor stays a pure `text → JSON` function with no fetch/pod/reply capability;
 * model output can only become REIFIED, reliability-capped RDF via
 * `buildAgenticGraph`/`addInterpretation` — a fully-steered model still cannot
 * `auto`-materialise (`SelfReported` cap) nor mark its own output security-clear
 * (`securityBearing` comes from the task class). The `.chat.ttl` canonical resource and the
 * raw anchor are NEVER rewritten — only the graph resource mutates, and only via CAS.
 */
import { type Interpreter } from "./interpret.js";
import { type ExtractionTask, type LlmExtractor } from "./interpret-llm.js";
import type { BridgeMessage } from "./message.js";
/** The default cap on interpret+write outcomes per sweep (bounds model calls + pod writes). */
export declare const DEFAULT_MAX_RESOURCES_PER_SWEEP = 25;
/** The default bounded-retry cap: after this many FAILED attempts a resource is terminal. */
export declare const DEFAULT_MAX_ATTEMPTS = 5;
/** The default cap on a raw-anchor read (1 MiB — mirrors the webhook's per-delivery byte cap). */
export declare const DEFAULT_MAX_RAW_ANCHOR_BYTES: number;
/** The default cap on a single graph read + the container listing read (8 MiB). */
export declare const DEFAULT_MAX_GRAPH_BYTES: number;
/** Options for {@link reparseRawAnchor}. */
export interface ReparseRawAnchorOptions {
    /** The channel the graph recorded (`"slack"` | `"whatsapp"` | `"email"`). */
    readonly channel: string;
    /** The byte-exact raw anchor bytes (the provenance ground truth). */
    readonly raw: string | Uint8Array;
    /**
     * The channel message id recovered from the resource slug ({@link slugToMessageId}) —
     * the WhatsApp fan-out selector (one delivery may carry several messages, each with its
     * OWN slugged graph). Ignored by the 1-delivery-1-message channels (slack/email).
     */
    readonly messageId: string;
    /** The WhatsApp fan-out cap (default {@link MAX_MESSAGES_PER_DELIVERY}). */
    readonly maxMessagesPerDelivery?: number;
}
/**
 * Reconstruct the {@link BridgeMessage} for a Pending resource by RE-PARSING its raw
 * anchor with the SAME hardened channel parse the webhook used — NOT by inverting the
 * graph (§1.3: the raw bytes are the provenance anchor, and re-parsing introduces no
 * second parser + no lossy graph→message mapping). FAIL-CLOSED: returns `undefined` for
 * an unknown channel, an unparseable / hostile anchor, or (WhatsApp) a delivery carrying
 * no message with the recovered id. NEVER throws — the sweep maps `undefined` to a skip.
 */
export declare function reparseRawAnchor(options: ReparseRawAnchorOptions): BridgeMessage | undefined;
/** A privacy-safe sweep audit event (COUNTERS only — never a payload, slug, id, or body). */
export type SweepAuditEvent = {
    readonly kind: "listed";
    readonly count: number;
} | {
    readonly kind: "interpreted";
    readonly channel: string;
} | {
    readonly kind: "conflict";
} | {
    readonly kind: "retry";
    readonly attempts: number;
} | {
    readonly kind: "failed";
    readonly attempts: number;
} | {
    readonly kind: "skipped";
    readonly reason: SweepSkipReason;
} | {
    readonly kind: "error";
};
/** The FIXED enum of fail-closed skip reasons (never message content — audit-safe). */
export type SweepSkipReason = "no-etag" | "no-strong-etag" | "missing-channel" | "missing-media-type" | "missing-digest" | "unsafe-raw-url" | "raw-fetch-failed" | "bad-slug" | "reconstruct-failed" | "slug-mismatch" | "digest-mismatch" | "write-failed";
/** Options for {@link sweepPendingInterpretations}. */
export interface SweepPendingInterpretationsOptions {
    /**
     * The owner-locked INBOX container holding the raw-message anchors + chat resources
     * (validated at entry; must end `/`). The sweep READS raw anchors from here (their URL is
     * read from each graph's `schema:url`, guarded to be within this container).
     */
    readonly container: string;
    /**
     * The container holding the interpretation GRAPH resources the sweep LISTS + CAS-replaces
     * (must end `/`). Defaults to {@link container} (the current single-container webhook
     * layout). Set to a DISTINCT container to run the §1.5 least-privilege two-container layout,
     * where the interpreter holds Write only here (never over the inbox anchors) — this pairs
     * with `buildBridgeAclTurtle`'s `graphsContainer`. NB the webhook must ALSO write graphs
     * here for the two-container layout (a maintainer-gated write-LAYOUT follow-up); the sweep
     * simply lists/writes wherever this points.
     */
    readonly graphsContainer?: string;
    /**
     * The `bridge-interpreter` authed pod `fetch` for READS (container listing, graphs, raw
     * anchors) — `acl:Read`. Injectable so the sweep is hermetic; NOT SSRF-guarded (the pod
     * is the user's own trusted origin), but every read is redirect-refused + scope-guarded.
     */
    readonly readFetch: typeof globalThis.fetch;
    /**
     * The `bridge-interpreter` authed pod `fetch` for the CAS graph replace — `acl:Write`
     * (NEVER `acl:Control`). Defaults to {@link readFetch}. Injectable/hermetic.
     */
    readonly writeFetch?: typeof globalThis.fetch;
    /**
     * The injected LLM extractor seam — a PURE `text → JSON` function (capability
     * starvation). In prod this is `createHttpLlmExtractor` (https-only, guarded, capped);
     * in tests a `scriptedExtractor`. The sweep grants it NOTHING new: no fetch, no pod
     * handle, no reply path.
     */
    readonly extractor: LlmExtractor;
    /** The opaque model tag written as `agentic:model` (default `"llm:unspecified"`). */
    readonly model?: string;
    /** The extraction-task registry (default {@link import("./interpret-llm.js").DEFAULT_TASKS}). */
    readonly tasks?: readonly ExtractionTask[];
    /** Opt-in k-sample agreement (forwarded to {@link LlmInterpreter}). */
    readonly kSamples?: number;
    /** The k-sample agreement threshold (forwarded to {@link LlmInterpreter}). */
    readonly kAgreementThreshold?: number;
    /** Per-task extractor timeout in ms (forwarded to {@link LlmInterpreter}). */
    readonly perTaskTimeoutMs?: number;
    /** The `bridge-interpreter` WebID (`prov:wasAssociatedWith` on each interpretation). */
    readonly interpretingAgentWebId?: string;
    /** The ODRL mandate the interpreter acts under (`prov:hadPlan`). */
    readonly mandateIri?: string;
    /**
     * Re-supply UNVERIFIED candidate WebIDs for the sender (offline directory lookups only,
     * NEVER a payload URL). Unioned with the candidates already recorded on the graph so a
     * rebuild never DROPS a previously-recorded candidate (each is re-validated on write).
     */
    readonly candidateWebIdsFor?: (message: BridgeMessage) => readonly string[] | undefined;
    /** The deterministic reference interpreter (default {@link deterministicInterpreter}; injectable for tests). */
    readonly deterministicInterpreter?: Interpreter;
    /**
     * Max INTERPRET+WRITE outcomes per sweep (default {@link DEFAULT_MAX_RESOURCES_PER_SWEEP}).
     * The bound counts only resources that consumed a model call + pod write
     * (`interpreted`/`retried`/`failed`/`conflict`), NOT candidates examined and NOT skips —
     * non-pending AND permanently-skipping Pending resources are scanned past for free, so
     * neither can starve valid Pending resources later in the listing.
     */
    readonly maxResourcesPerSweep?: number;
    /** The bounded-retry cap (default {@link DEFAULT_MAX_ATTEMPTS}); a positive integer. */
    readonly maxAttempts?: number;
    /** Cap on a raw-anchor READ in bytes (default {@link DEFAULT_MAX_RAW_ANCHOR_BYTES}); a positive integer. */
    readonly maxRawAnchorBytes?: number;
    /** Cap on a graph + container-listing READ in bytes (default {@link DEFAULT_MAX_GRAPH_BYTES}); a positive integer. */
    readonly maxGraphBytes?: number;
    /** The WhatsApp fan-out cap for raw-anchor re-parse (default {@link MAX_MESSAGES_PER_DELIVERY}). */
    readonly maxMessagesPerDelivery?: number;
    /** Fallback "now" for re-interpretation when the graph records no `schema:dateReceived`. */
    readonly now?: Date;
    /** A privacy-safe audit sink (counters only — never payloads/secrets). */
    readonly onEvent?: (event: SweepAuditEvent) => void;
}
/** The outcome of one {@link sweepPendingInterpretations} run. */
export interface SweepResult {
    /** `*.ttl` candidate graph resources GET+examined this sweep (incl. those scanned past). */
    readonly examined: number;
    /** Examined resources whose status was `agentic:Pending` (encountered — skips included). */
    readonly pending: number;
    /** Pending resources successfully re-interpreted AND CAS-won. */
    readonly interpreted: number;
    /** Pending resources whose CAS lost to a concurrent writer (`412`) — a benign no-op. */
    readonly conflicted: number;
    /** Pending resources rewritten `pending(+1)` after a failed attempt (under the cap). */
    readonly retried: number;
    /** Pending resources marked terminal `agentic:InterpretationFailed` (cap reached). */
    readonly failed: number;
    /** Pending resources fail-closed skipped (bad slug / digest mismatch / reconstruct failure / …). */
    readonly skipped: number;
}
/**
 * Run one decoupled interpretation sweep over `container`. Pure of in-process state,
 * fail-closed per resource (one bad resource never aborts the run), and horizontally safe
 * (every graph mutation is `If-Match` CAS). See the module docstring for the full contract.
 *
 * @throws only if `container` is not a safe canonical container IRI, or the container
 *   LISTING itself cannot be read (a genuine operational failure of the whole sweep).
 */
export declare function sweepPendingInterpretations(options: SweepPendingInterpretationsOptions): Promise<SweepResult>;
//# sourceMappingURL=interpret-sweep.d.ts.map