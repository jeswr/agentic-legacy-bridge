// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
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
import { parseRdf } from "@jeswr/fetch-rdf";
import { DataFactory } from "n3";
import { parseEmailInbound } from "./channel.js";
import { EmailParseError } from "./email/index.js";
import { ChannelParseError } from "./errors.js";
import { buildAgenticGraph } from "./graph.js";
import { assertNoRedirect, assertWritableUrl, messageSlug, rawExtensionFor, slugToMessageId, } from "./import.js";
import { deterministicInterpreter } from "./interpret.js";
import { LlmInterpreter } from "./interpret-llm.js";
import { canonicalContainer, isWithinBase, mintUrn, safeHttpIri, safeMediaType, } from "./safe-iri.js";
import { SlackParseError, slackEventToBridgeMessage } from "./slack.js";
import { AGENTIC_CANDIDATE_WEB_ID, AGENTIC_CHANNEL, AGENTIC_INTERPRETATION_ATTEMPTS, AGENTIC_INTERPRETATION_STATUS, AGENTIC_PENDING, AGENTIC_RAW_DIGEST, AGENTIC_RAW_INBOUND_MESSAGE, AGENTIC_RAW_MEDIA_TYPE, LDP_CONTAINS, RDF_TYPE, SCHEMA_DATE_RECEIVED, SCHEMA_SENDER, SCHEMA_URL, XSD_INTEGER, } from "./vocab.js";
import { MAX_MESSAGES_PER_DELIVERY, parseWhatsAppDelivery, WhatsAppParseError, } from "./whatsapp.js";
const { namedNode } = DataFactory;
/** The default cap on interpret+write outcomes per sweep (bounds model calls + pod writes). */
export const DEFAULT_MAX_RESOURCES_PER_SWEEP = 25;
/** The default bounded-retry cap: after this many FAILED attempts a resource is terminal. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** The default cap on a raw-anchor read (1 MiB — mirrors the webhook's per-delivery byte cap). */
export const DEFAULT_MAX_RAW_ANCHOR_BYTES = 1024 * 1024;
/** The default cap on a single graph read + the container listing read (8 MiB). */
export const DEFAULT_MAX_GRAPH_BYTES = 8 * 1024 * 1024;
/**
 * Reconstruct the {@link BridgeMessage} for a Pending resource by RE-PARSING its raw
 * anchor with the SAME hardened channel parse the webhook used — NOT by inverting the
 * graph (§1.3: the raw bytes are the provenance anchor, and re-parsing introduces no
 * second parser + no lossy graph→message mapping). FAIL-CLOSED: returns `undefined` for
 * an unknown channel, an unparseable / hostile anchor, or (WhatsApp) a delivery carrying
 * no message with the recovered id. NEVER throws — the sweep maps `undefined` to a skip.
 */
export function reparseRawAnchor(options) {
    const { channel, raw, messageId } = options;
    try {
        switch (channel) {
            case "slack":
                // The raw anchor IS the delivery body (1 delivery ⇒ 1 message); re-parse directly.
                return slackEventToBridgeMessage(raw);
            case "whatsapp": {
                // The raw anchor is the FULL delivery body (which may fan out to several
                // messages, each with its own slug). Parse once, then select the message whose
                // wamid equals the recovered id — never trust an index, always match the id.
                const cap = options.maxMessagesPerDelivery ?? MAX_MESSAGES_PER_DELIVERY;
                const delivery = parseWhatsAppDelivery(raw, cap);
                if (delivery.total === 0 || delivery.capped)
                    return undefined;
                for (let i = 0; i < delivery.total; i++) {
                    let candidate;
                    try {
                        candidate = delivery.messageAt(i);
                    }
                    catch (err) {
                        if (err instanceof WhatsAppParseError)
                            continue; // a non-text entry — skip it
                        throw err;
                    }
                    if (candidate.messageId === messageId)
                        return candidate;
                }
                return undefined; // no message in the delivery carries the recovered id
            }
            case "email":
                // The email raw anchor is the full RFC 5322 message; `parseEmailInbound` derives
                // the message purely from `raw` (the `id` is not consulted), so the reconstruction
                // is a pure function of the byte-exact anchor.
                return parseEmailInbound({ id: messageId, raw });
            default:
                return undefined; // unknown channel — fail closed
        }
    }
    catch (err) {
        if (err instanceof SlackParseError ||
            err instanceof WhatsAppParseError ||
            err instanceof EmailParseError ||
            err instanceof ChannelParseError) {
            return undefined; // a hostile / malformed anchor — fail closed
        }
        throw err;
    }
}
/**
 * Run one decoupled interpretation sweep over `container`. Pure of in-process state,
 * fail-closed per resource (one bad resource never aborts the run), and horizontally safe
 * (every graph mutation is `If-Match` CAS). See the module docstring for the full contract.
 *
 * @throws only if `container` is not a safe canonical container IRI, or the container
 *   LISTING itself cannot be read (a genuine operational failure of the whole sweep).
 */
export async function sweepPendingInterpretations(options) {
    const container = canonicalContainer(options.container);
    if (container === undefined) {
        throw new Error("sweep: container must be a safe http(s) container IRI ending in '/' with no query or fragment.");
    }
    // The graphs container defaults to the inbox (single-container layout). A distinct value is
    // the §1.5 least-privilege two-container layout (interpreter Write confined here).
    const graphsContainer = options.graphsContainer !== undefined ? canonicalContainer(options.graphsContainer) : container;
    if (graphsContainer === undefined) {
        throw new Error("sweep: graphsContainer must be a safe http(s) container IRI ending in '/' with no query or fragment.");
    }
    const readFetch = options.readFetch;
    const writeFetch = options.writeFetch ?? options.readFetch;
    const maxResources = Number.isInteger(options.maxResourcesPerSweep) && options.maxResourcesPerSweep > 0
        ? options.maxResourcesPerSweep
        : DEFAULT_MAX_RESOURCES_PER_SWEEP;
    const cap = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
        ? options.maxAttempts
        : DEFAULT_MAX_ATTEMPTS;
    const maxRawAnchorBytes = Number.isInteger(options.maxRawAnchorBytes) && options.maxRawAnchorBytes > 0
        ? options.maxRawAnchorBytes
        : DEFAULT_MAX_RAW_ANCHOR_BYTES;
    const maxGraphBytes = Number.isInteger(options.maxGraphBytes) && options.maxGraphBytes > 0
        ? options.maxGraphBytes
        : DEFAULT_MAX_GRAPH_BYTES;
    // A THROWING audit callback must never change sweep behaviour or abort it after side
    // effects (a roborev finding) — observability is best-effort, isolated from the pod writes.
    const emit = (event) => {
        try {
            options.onEvent?.(event);
        }
        catch {
            /* an audit/telemetry failure is swallowed — it cannot affect the sweep. */
        }
    };
    // 1. List the GRAPHS container (this GET failing is a whole-sweep failure — it throws).
    const listing = await readGraph(readFetch, graphsContainer, maxGraphBytes);
    const candidates = graphResourceCandidates(listing.dataset, graphsContainer);
    emit({ kind: "listed", count: candidates.length });
    const tally = {
        examined: 0,
        pending: 0,
        interpreted: 0,
        conflicted: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
    };
    // The budget (`maxResources`) counts ONLY resources on which the expensive interpret+write
    // work was done (`interpreted`/`retried`/`failed`/`conflict`) — NOT candidates examined and
    // NOT skips. This separates the interpretation budget from malformed-resource scan handling
    // (a roborev finding): a stable prefix of non-pending resources OR of permanently-SKIPPING
    // Pending graphs (bad-slug / digest-mismatch / a transiently-missing anchor) is scanned PAST
    // for free — never consuming the budget — so it can never starve valid Pending resources
    // later in the listing. The GET-to-check-status + integrity checks are cheap; the bound
    // protects the model calls + pod writes. (A pathologically large container makes the
    // portable LDP full-scan itself costly — that is the deferred SPARQL/index optimisation's
    // job, NOT a scan cap, which without a rotating cursor would re-introduce this starvation;
    // a permanently-malformed Pending resource is re-scanned each tick until the owner
    // remediates it — bounded by container size, never a budget sink.)
    let budgetUsed = 0;
    for (const docUrl of candidates) {
        if (budgetUsed >= maxResources)
            break; // budget reached — the rest wait for next tick
        tally.examined++;
        let outcome;
        try {
            outcome = await processResource(docUrl, {
                options,
                readFetch,
                writeFetch,
                cap,
                maxRawAnchorBytes,
                maxGraphBytes,
                emit,
                inbox: container,
                graphsContainer,
            });
        }
        catch {
            // A per-resource operational failure (a pod read/write error, a rebuild throw) never
            // aborts the whole sweep — the resource stays Pending for the next tick. It does NOT
            // consume the budget (a transient error must not starve valid Pending resources).
            emit({ kind: "error" });
            tally.pending++;
            tally.skipped++;
            continue;
        }
        switch (outcome.kind) {
            case "not-pending":
                break; // scanned past — not Pending, no budget
            case "skipped":
                // A Pending resource we could not process (integrity/transient failure). It is
                // scanned PAST (no budget) so a bad prefix can never starve valid Pending resources.
                tally.pending++;
                tally.skipped++;
                emit({ kind: "skipped", reason: outcome.reason });
                break;
            case "interpreted":
                tally.pending++;
                tally.interpreted++;
                budgetUsed++;
                emit({ kind: "interpreted", channel: outcome.channel });
                break;
            case "conflict":
                tally.pending++;
                tally.conflicted++;
                budgetUsed++;
                emit({ kind: "conflict" });
                break;
            case "retry":
                tally.pending++;
                tally.retried++;
                budgetUsed++;
                emit({ kind: "retry", attempts: outcome.attempts });
                break;
            case "failed":
                tally.pending++;
                tally.failed++;
                budgetUsed++;
                emit({ kind: "failed", attempts: outcome.attempts });
                break;
            case "write-failed":
                // The model already ran, so this CONSUMES the budget (a write-failing pod must not
                // let one sweep fire an LLM call for every pending resource). Reported as a skip.
                tally.pending++;
                tally.skipped++;
                budgetUsed++;
                emit({ kind: "skipped", reason: "write-failed" });
                break;
        }
    }
    return { ...tally };
}
/** Process one candidate `.ttl` graph resource fail-closed. */
async function processResource(docUrl, ctx) {
    // Defence in depth: re-assert the graph URL is within the GRAPHS container (it came from
    // `ldp:contains`, but never trust the listing) — this also canonicalises it.
    const safeDoc = assertWritableUrl(docUrl, ctx.graphsContainer);
    const { dataset, etag } = await readGraph(ctx.readFetch, safeDoc, ctx.maxGraphBytes);
    // FIRST establish whether this is even a bridge Pending resource — BEFORE any CAS/validator
    // check — so an unrelated `.ttl` (no bridge anchor, or not `agentic:Pending`) is reported
    // `not-pending` (scanned past for free) rather than mis-counted as a Pending skip (a roborev
    // finding). A `.ttl` without EXACTLY one `agentic:RawInboundMessage` subject is not a bridge
    // message graph we handle.
    const anchors = subjectsOfType(dataset, AGENTIC_RAW_INBOUND_MESSAGE);
    if (anchors.length !== 1)
        return { kind: "not-pending" };
    const anchor = anchors[0];
    if (anchor === undefined)
        return { kind: "not-pending" };
    // Only sweep `agentic:Pending` resources (S4 monotonicity — `interpreted`/`failed` are never
    // re-swept, so a hostile message cannot amplify a re-interpretation loop). Require the SOLE
    // status to be exactly `agentic:Pending`: a graph carrying MULTIPLE status values (e.g. both
    // `Pending` and a terminal `Interpreted`/`InterpretationFailed`) is not a clean Pending
    // resource and must never be swept on encounter order — it is `not-pending` (fail-closed).
    const status = soleObjectIri(dataset, anchor, AGENTIC_INTERPRETATION_STATUS);
    if (status !== AGENTIC_PENDING)
        return { kind: "not-pending" };
    // This IS a Pending bridge resource. A CAS `If-Match` replace needs a STRONG validator
    // (RFC 9110 §13.1.1 — `If-Match` mandates strong comparison). Reject a missing / weak
    // (`W/"…"`) / malformed ETag HERE — BEFORE the reconstruction + model call — so a
    // weak-validator server can never cause the sweep to interpret-then-perpetually-`412`,
    // burning the model budget without ever making progress. Fail closed.
    if (etag === null)
        return { kind: "skipped", reason: "no-etag" };
    if (!isStrongEtag(etag))
        return { kind: "skipped", reason: "no-strong-etag" };
    // Each anchor field is single-valued by construction — require EXACTLY ONE (a tampered
    // multi-valued field fails closed rather than being resolved by encounter order).
    const channel = soleLiteral(dataset, anchor, AGENTIC_CHANNEL);
    if (channel === undefined)
        return { kind: "skipped", reason: "missing-channel" };
    const storedMediaType = safeMediaType(soleLiteral(dataset, anchor, AGENTIC_RAW_MEDIA_TYPE));
    if (storedMediaType === undefined)
        return { kind: "skipped", reason: "missing-media-type" };
    const recordedDigest = normalizeDigest(soleLiteral(dataset, anchor, AGENTIC_RAW_DIGEST));
    if (recordedDigest === undefined)
        return { kind: "skipped", reason: "missing-digest" };
    const attempts = readAttempts(dataset, anchor);
    // The received time is the original ingestion instant — re-use it as BOTH the
    // interpreter `now` (so relative-date resolution reproduces the webhook's result, not a
    // later-drifted one) and the rebuilt `schema:dateReceived` (so provenance stays honest).
    const receivedAt = soleLiteral(dataset, anchor, SCHEMA_DATE_RECEIVED);
    const interpretNow = parseDate(receivedAt) ?? ctx.options.now ?? new Date();
    // The reversible slug ↔ id (fail-closed on a tampered / un-reversible slug).
    const slug = slugFromDocUrl(safeDoc);
    if (slug === undefined)
        return { kind: "skipped", reason: "bad-slug" };
    const recoveredId = slugToMessageId(slug);
    if (recoveredId === undefined)
        return { kind: "skipped", reason: "bad-slug" };
    // The raw anchor URL comes from the graph's OWN `schema:url` (the location the writer
    // recorded). Inspect EVERY `schema:url` quad: if ANY exist, the pointer MUST be EXACTLY ONE
    // safe NamedNode strictly within the INBOX, else FAIL CLOSED (a roborev finding). A tampered
    // pointer — a literal, an out-of-inbox IRI, or multiple values — must NEVER fall back to a
    // derived sibling (that would let the sweep interpret + overwrite a mis-pointed resource
    // instead of refusing it). Only a graph with NO `schema:url` at all takes the sibling
    // fallback, and ONLY in the single-container layout (S1: never a payload-derived URL — only a
    // pod URL the writer itself committed, within the inbox).
    const urlQuads = [...dataset.match(anchor, namedNode(SCHEMA_URL), null, null)];
    let rawUrl;
    if (urlQuads.length > 0) {
        const obj = urlQuads.length === 1 ? urlQuads[0]?.object : undefined;
        if (obj === undefined || obj.termType !== "NamedNode") {
            return { kind: "skipped", reason: "unsafe-raw-url" };
        }
        const safeRecorded = safeHttpIri(obj.value);
        if (safeRecorded === undefined || !isWithinBase(safeRecorded, ctx.inbox)) {
            return { kind: "skipped", reason: "unsafe-raw-url" };
        }
        rawUrl = safeRecorded;
    }
    else if (ctx.inbox === ctx.graphsContainer) {
        // NO `schema:url` — single-container fallback ONLY: derive the anchor as the graph's SIBLING
        // (valid solely when the graphs container IS the inbox).
        const base = safeDoc.slice(0, safeDoc.length - ".ttl".length);
        const derived = safeHttpIri(`${base}${rawExtensionFor(storedMediaType)}`);
        if (derived !== undefined && isWithinBase(derived, ctx.inbox))
            rawUrl = derived;
    }
    if (rawUrl === undefined)
        return { kind: "skipped", reason: "unsafe-raw-url" };
    const rawBytes = await fetchRawBytes(ctx.readFetch, rawUrl, ctx.maxRawAnchorBytes);
    if (rawBytes === undefined)
        return { kind: "skipped", reason: "raw-fetch-failed" };
    const message = reparseRawAnchor({
        channel,
        raw: rawBytes,
        messageId: recoveredId,
        ...(ctx.options.maxMessagesPerDelivery !== undefined
            ? { maxMessagesPerDelivery: ctx.options.maxMessagesPerDelivery }
            : {}),
    });
    if (message === undefined)
        return { kind: "skipped", reason: "reconstruct-failed" };
    // --- fail-closed integrity guards (NEVER mis-attribute) ---
    // (a) Slug round-trip: the reconstructed message must map back to THIS resource's slug.
    const reconstructedSlugKey = message.messageId !== undefined && message.messageId.length > 0
        ? message.messageId
        : message.rawSha256;
    if (messageSlug(reconstructedSlugKey) !== slug)
        return { kind: "skipped", reason: "slug-mismatch" };
    // (b) Digest integrity: the raw anchor bytes must hash to the digest the graph committed
    //     to at ingest — a swapped / corrupted anchor is refused, never laundered.
    if (message.rawSha256 !== recordedDigest)
        return { kind: "skipped", reason: "digest-mismatch" };
    // --- interpret + write (EVERYTHING below consumes the sweep budget) ---
    // From here the model is invoked and/or the pod is written, so ANY outcome — success,
    // conflict, retry, failed, a CAS write-failure, or a thrown write/build error — MUST
    // consume the budget (a roborev finding). Otherwise a pod that fails every write would let
    // ONE sweep fire an LLM call for every pending resource despite a tiny budget. A throw here
    // is caught and mapped to `write-failed` (budget-consuming) rather than escaping to the
    // loop's pre-model free-skip catch.
    try {
        return await interpretAndWrite(ctx, {
            safeDoc,
            etag,
            channel,
            message,
            dataset,
            anchor,
            storedMediaType,
            rawUrl,
            receivedAt,
            interpretNow,
            attempts,
        });
    }
    catch {
        return { kind: "write-failed" };
    }
}
async function interpretAndWrite(ctx, a) {
    const { safeDoc, etag, channel, message, dataset, anchor, interpretNow, attempts } = a;
    const { storedMediaType, rawUrl, receivedAt } = a;
    const det = (ctx.options.deterministicInterpreter ?? deterministicInterpreter).interpret(message, {
        docIri: safeDoc,
        now: interpretNow,
    });
    const llm = await new LlmInterpreter({
        extractor: ctx.options.extractor,
        ...(ctx.options.model !== undefined ? { model: ctx.options.model } : {}),
        ...(ctx.options.tasks !== undefined ? { tasks: ctx.options.tasks } : {}),
        ...(ctx.options.kSamples !== undefined ? { kSamples: ctx.options.kSamples } : {}),
        ...(ctx.options.kAgreementThreshold !== undefined
            ? { kAgreementThreshold: ctx.options.kAgreementThreshold }
            : {}),
        ...(ctx.options.perTaskTimeoutMs !== undefined
            ? { perTaskTimeoutMs: ctx.options.perTaskTimeoutMs }
            : {}),
    }).interpretDetailed(message, { docIri: safeDoc, now: interpretNow });
    // Outcome policy (fail-closed, retry-until-clean, ALL-OR-NOTHING LLM persistence):
    //  - A CLEAN pass (no warnings) is terminal `interpreted`: every task either produced a
    //    datum or cleanly found nothing (`{items:[]}`), so the LLM set is COMPLETE. Only then
    //    are the LLM interpretations persisted — the whole `[det, llm]` set atomically.
    //  - ANY warning (an extractor throw/timeout, or a validation drop) is a FAILED attempt.
    //    The LLM output of a non-clean pass is DELIBERATELY NOT persisted — the graph keeps
    //    ONLY the deterministic interpretations (already written by the webhook). This is what
    //    makes retry safe: because a partial pass persists no LLM datum, a later retry can
    //    never DROP an earlier pass's partial success (there is none persisted), and the
    //    message is re-derived from the byte-exact anchor next tick — no accumulation, no
    //    graph→interpretation inverse mapping, no cross-retry loss. The resource stays
    //    `pending` (attempts+1) until a CLEAN pass completes it, or the retry cap makes it the
    //    terminal `failed` (honestly flagged for the owner's quarantine UI; deterministic data
    //    intact). Re-interpretation is bounded by the cap, so a hostile message cannot amplify.
    const clean = llm.warnings.length === 0;
    let interpretations;
    let nextStatus;
    let nextAttempts;
    let resultKind;
    if (clean) {
        interpretations = [...det, ...llm.interpretations]; // COMPLETE LLM set, persisted atomically
        nextStatus = "interpreted";
        nextAttempts = undefined; // a cleanly-interpreted resource carries no retry counter
        resultKind = "interpreted";
    }
    else {
        interpretations = [...det]; // partial LLM output NOT persisted until a clean pass
        const bumped = attempts + 1;
        nextAttempts = bumped;
        if (bumped >= ctx.cap) {
            nextStatus = "failed";
            resultKind = "failed";
        }
        else {
            nextStatus = "pending";
            resultKind = "retry";
        }
    }
    const candidateWebIds = collectCandidateWebIds(dataset, anchor, ctx.options.candidateWebIdsFor?.(message));
    const rawMessageIri = mintUrn("raw", message.rawSha256);
    const graph = await buildAgenticGraph({
        message,
        channel,
        docIri: safeDoc,
        rawMessageIri,
        rawResourceIri: rawUrl,
        rawMediaType: storedMediaType,
        receivedAt: receivedAt ?? interpretNow.toISOString(),
        interpretations,
        interpretationStatus: nextStatus,
        ...(nextAttempts !== undefined ? { interpretationAttempts: nextAttempts } : {}),
        ...(candidateWebIds.length > 0 ? { candidateWebIds } : {}),
        ...(ctx.options.interpretingAgentWebId !== undefined
            ? { interpretingAgentWebId: ctx.options.interpretingAgentWebId }
            : {}),
        ...(ctx.options.mandateIri !== undefined ? { mandateIri: ctx.options.mandateIri } : {}),
    });
    // CAS replace — `If-Match: <etag>`. A 412 means a concurrent sweep already wrote (a
    // benign no-op; it will be re-listed if still Pending). NEVER an unconditional PUT.
    const put = await casPut(ctx.writeFetch, safeDoc, graph.turtle, etag);
    if (put === "conflict")
        return { kind: "conflict" };
    if (put === "failed")
        return { kind: "write-failed" }; // post-model → budget-consuming
    if (resultKind === "interpreted")
        return { kind: "interpreted", channel };
    if (resultKind === "failed")
        return { kind: "failed", attempts: nextAttempts };
    return { kind: "retry", attempts: nextAttempts };
}
// --- pod I/O helpers ---------------------------------------------------------
/**
 * The RDF media type the sweep negotiates AND forces the parse to — TURTLE ONLY.
 * DELIBERATELY NOT JSON-LD: `parseRdf`'s JSON-LD path can dereference a remote `@context`
 * URL via the STREAMING parser's OWN network (not the injected `readFetch`), bypassing the
 * redirect-refusal, DNS-pin, and container-scope guards — an SSRF the sweep must not open (a
 * roborev finding). The sweep only ever reads Turtle it/the webhook wrote via `n3.Writer`, so
 * requesting AND parsing as Turtle is both correct and fully hermetic (no `@context` fetch is
 * even reachable). A server that returns non-Turtle fails the Turtle parse → fail-closed skip,
 * never a network side effect.
 */
const SWEEP_ACCEPT = "text/turtle";
/**
 * Read a response body as a CAPPED STREAM — `undefined` on an over-cap `Content-Length` or a
 * body that exceeds `maxBytes` mid-read (a lying/absent `Content-Length` cannot force an
 * unbounded materialisation). EVERY pod read (the container listing, each graph, each raw
 * anchor) goes through this, so a large in-scope resource can never cause an unbounded
 * memory/time spike on a sweep (a roborev finding). Refuses BEFORE materialising the bytes.
 */
async function readCappedBody(res, maxBytes) {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
        return undefined;
    const body = res.body;
    if (body === null)
        return new Uint8Array(0); // a bodyless response — nothing to read
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value !== undefined) {
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel();
                    return undefined; // over-cap mid-read — refuse (fail-closed)
                }
                chunks.push(value);
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
/** GET + parse a pod Turtle resource (redirect-refused, JSON-LD-free, size-capped); store + ETag. */
async function readGraph(fetchImpl, url, maxBytes) {
    const res = await fetchImpl(url, {
        method: "GET",
        headers: { accept: SWEEP_ACCEPT },
        redirect: "manual",
    });
    assertNoRedirect(res, "GET", url);
    if (!res.ok) {
        throw new Error(`sweep read failed: GET ${url} -> ${res.status} ${res.statusText}`);
    }
    // BOUNDED read — a large listing/graph must not materialise unbounded (a roborev finding). An
    // over-cap read throws: for a graph resource the loop's catch turns it into a free skip; for
    // the container listing it fails the whole sweep (a pathologically-large container — the
    // deferred SPARQL/index case — surfaces as a clear error, not an OOM).
    const bytes = await readCappedBody(res, maxBytes);
    if (bytes === undefined) {
        throw new Error(`sweep read exceeded the ${maxBytes}-byte cap: GET ${url}`);
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Parse as TURTLE unconditionally (ignore the response content-type), so a JSON-LD body from
    // a non-compliant / hostile server can NEVER route through the remote-`@context`-fetching
    // JSON-LD parser. `parseRdf` is the sanctioned parse; forcing its Turtle path keeps it
    // hermetic (never `new Parser().parse(...)` inline, never a bespoke parser).
    const dataset = await parseRdf(text, SWEEP_ACCEPT, { baseIRI: url });
    return { dataset, etag: res.headers.get("etag") };
}
/**
 * GET the raw anchor bytes (redirect-refused), BOUNDED to `maxBytes` — `undefined` on any
 * non-2xx or an over-cap body (via {@link readCappedBody}). So a tampered `schema:url` pointing
 * at a large in-inbox resource cannot cause an unbounded memory/time spike on every sweep. The
 * channel parsers cap again, but the bound must be on the READ, before the bytes materialise.
 */
async function fetchRawBytes(fetchImpl, url, maxBytes) {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual" });
    assertNoRedirect(res, "GET", url);
    if (!res.ok)
        return undefined;
    return readCappedBody(res, maxBytes);
}
/** PUT the rebuilt graph with `If-Match: <etag>` (redirect-refused); 412 ⇒ benign conflict. */
async function casPut(fetchImpl, url, turtle, etag) {
    const res = await fetchImpl(url, {
        method: "PUT",
        headers: { "content-type": "text/turtle", "if-match": etag },
        body: turtle,
        redirect: "manual",
    });
    assertNoRedirect(res, "PUT", url);
    // The precondition-failed status for `If-Match` is 412 — treat ONLY 412 as a benign
    // concurrent-writer conflict (a lost CAS). A 409 (or any other non-2xx) is an ambiguous
    // real failure that must NOT be swallowed as a conflict.
    if (res.status === 412)
        return "conflict";
    if (!res.ok)
        return "failed";
    return "written";
}
// --- graph reading helpers (RDF/JS quad interface — no bespoke parse) ---------
/**
 * Collect the within-container `*.ttl` graph resources from a container listing —
 * skipping the `.chat.ttl` canonical resources, the raw anchors, and `.acl`. Every IRI is
 * `safeHttpIri`-canonicalised and STRICTLY within-container-scoped BEFORE it is ever
 * fetched (S1 — a hostile `ldp:contains` pointing off-origin can never leak the pod
 * credential to a third party).
 */
function graphResourceCandidates(dataset, container) {
    const out = [];
    const seen = new Set();
    for (const quad of dataset.match(null, namedNode(LDP_CONTAINS), null, null)) {
        const value = quad.object.value;
        const safe = safeHttpIri(value);
        if (safe === undefined)
            continue;
        if (!safe.endsWith(".ttl") || safe.endsWith(".chat.ttl"))
            continue;
        if (!isWithinBase(safe, container))
            continue;
        if (seen.has(safe))
            continue;
        seen.add(safe);
        out.push(safe);
    }
    return out;
}
/** The DISTINCT subjects with `rdf:type <typeIri>` (via the RDF/JS `match` interface). */
function subjectsOfType(dataset, typeIri) {
    const out = [];
    const seen = new Set();
    for (const quad of dataset.match(null, namedNode(RDF_TYPE), namedNode(typeIri), null)) {
        const key = `${quad.subject.termType}:${quad.subject.value}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(quad.subject);
    }
    return out;
}
/**
 * The SOLE object of `(subject, predicate)` as a NamedNode IRI. Requires EXACTLY ONE quad whose
 * object is a NamedNode — `undefined` for zero, multiple, or a non-NamedNode. RDF is unordered,
 * so "the first value" is not well-defined; a tampered/malformed graph with MULTIPLE values for
 * a single-valued anchor field (e.g. both `agentic:Pending` and `agentic:Interpreted`) must NOT
 * be resolved by encounter order — it fails closed (a roborev finding; preserves S4 monotonicity).
 */
function soleObjectIri(dataset, subject, predicate) {
    const quads = [...dataset.match(subject, namedNode(predicate), null, null)];
    if (quads.length !== 1)
        return undefined;
    const obj = quads[0]?.object;
    return obj !== undefined && obj.termType === "NamedNode" ? obj.value : undefined;
}
/** The SOLE object of `(subject, predicate)` as a Literal lexical value (EXACTLY ONE, else undefined). */
function soleLiteral(dataset, subject, predicate) {
    const quads = [...dataset.match(subject, namedNode(predicate), null, null)];
    if (quads.length !== 1)
        return undefined;
    const obj = quads[0]?.object;
    return obj !== undefined && obj.termType === "Literal" ? obj.value : undefined;
}
/**
 * Read the `agentic:interpretationAttempts` counter as a non-negative integer (default 0).
 * Requires EXACTLY ONE literal of datatype `xsd:integer` with the CANONICAL lexical form (`0`
 * or a no-leading-zero positive). Anything else — missing, MULTIPLE values, a wrong datatype
 * (`"999"^^xsd:string`), or a non-canonical / non-integer lexical (`"1.5"`, `"4abc"`, `"01"`,
 * `" 3 "`) — falls back to 0 (fail-safe: an unreadable/tampered counter restarts the bounded
 * retry rather than being trusted, so it can never prematurely terminal a resource).
 */
function readAttempts(dataset, subject) {
    const quads = [...dataset.match(subject, namedNode(AGENTIC_INTERPRETATION_ATTEMPTS), null, null)];
    if (quads.length !== 1)
        return 0; // missing or multiple ⇒ untrustworthy
    const obj = quads[0]?.object;
    if (obj === undefined || obj.termType !== "Literal")
        return 0;
    if (obj.datatype.value !== XSD_INTEGER)
        return 0; // MUST be a real xsd:integer
    if (!/^(?:0|[1-9]\d*)$/.test(obj.value))
        return 0; // canonical lexical form only
    const n = Number.parseInt(obj.value, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
/**
 * Collect the sender's previously-recorded `agentic:candidateWebId`s (so a rebuild never
 * DROPS a candidate) unioned with the freshly re-supplied ones. Each is re-validated by
 * `safeHttpIri` here and again by `addSenderPerson` on write — a candidate stays a
 * candidate (never promoted to verified), so this preserves provenance without laundering.
 */
function collectCandidateWebIds(dataset, anchor, supplied) {
    const out = [];
    const seen = new Set();
    const add = (value) => {
        const safe = safeHttpIri(value);
        if (safe !== undefined && !seen.has(safe)) {
            seen.add(safe);
            out.push(safe);
        }
    };
    for (const senderQuad of dataset.match(anchor, namedNode(SCHEMA_SENDER), null, null)) {
        for (const webidQuad of dataset.match(senderQuad.object, namedNode(AGENTIC_CANDIDATE_WEB_ID), null, null)) {
            add(webidQuad.object.value);
        }
    }
    for (const value of supplied ?? [])
        add(value);
    return out;
}
/** Strip the `sha256:` prefix from a recorded digest, returning the lower-hex or `undefined`. */
function normalizeDigest(value) {
    if (value === undefined)
        return undefined;
    const m = /^sha256:([0-9a-f]{64})$/.exec(value.trim().toLowerCase());
    return m?.[1];
}
/**
 * True for a STRONG ETag validator (usable with `If-Match`, which mandates strong comparison
 * — RFC 9110 §13.1.1). A strong entity-tag is a QUOTED opaque-tag `"…"` (§8.8.3). This
 * requires that exact shape, so it rejects not only the weak `W/"…"` form but also any
 * malformed/unquoted validator (`abc`, `*`, empty) — none of which can be relied on for an
 * `If-Match` strong comparison, so we skip rather than fire an avoidable model call before a
 * PUT that cannot reliably succeed.
 */
function isStrongEtag(etag) {
    const t = etag.trim();
    // A quoted opaque-tag: `"` … `"` with no bare `"` inside (a `\"`-escape is allowed).
    return /^"(?:[^"\\]|\\.)*"$/.test(t);
}
/** Parse an ISO date literal, or `undefined` if absent / unparseable. */
function parseDate(value) {
    if (value === undefined)
        return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms);
}
/** The `alb-…` slug of a `<container><slug>.ttl` doc URL (its last path segment, sans `.ttl`). */
function slugFromDocUrl(docUrl) {
    if (!docUrl.endsWith(".ttl"))
        return undefined;
    let path;
    try {
        path = new URL(docUrl).pathname;
    }
    catch {
        return undefined;
    }
    const segment = path.slice(path.lastIndexOf("/") + 1);
    const slug = segment.slice(0, segment.length - ".ttl".length);
    return slug.length > 0 ? slug : undefined;
}
//# sourceMappingURL=interpret-sweep.js.map