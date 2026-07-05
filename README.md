# `@jeswr/agentic-legacy-bridge`

The path **FROM** today's channels (email first) **TO** the accountable web of agents.

A four-rung ratchet — *meet legacy where it is, then pull it up* — that composes the suite's hardened
packages rather than rebuilding them. Design record:
[`agentic-solid-vision/docs/LEGACY-INTEROP.md`](https://github.com/jeswr/agentic-solid-vision/blob/main/docs/LEGACY-INTEROP.md);
the paper's §7 "The path from today"; the wire protocol in [`PROTOCOL.md`](./PROTOCOL.md); the design
choices in [`docs/DECISIONS.md`](./docs/DECISIONS.md).

> **Scope.** Email is the first channel; the entire input is untrusted. The core is fully **hermetic** —
> the LLM interpreter, the reply signer, and the channel transport are all **injectable seams**, so
> there is no live-LLM, crypto, or network dependency in the core. **M2.0 (landed)** makes the whole
> pipeline **channel-neutral** (`BridgeMessage` + `ChannelAdapter.parse`, below); **M2.1 (landed)**
> adds the **Slack** parse transform + adapter (below). A native WhatsApp adapter, a live LLM
> interpreter, `solid-vc` signing, and an inbound-webhook service are the remaining M2 phases (see
> *Follow-ups* and [`docs/M2-DESIGN.md`](./docs/M2-DESIGN.md)).

## The four rungs

1. **Represent** — parse an inbound legacy message (hardened RFC 5322 / MIME) and model its sender as
   a `schema:Person`/`foaf:Person`/`vcard:Individual` and the message as a PROV-anchored
   `agentic:RawInboundMessage`. Identity is **never assumed from an unauthenticated address**: the
   person is `agentic:identityStatus "unverified"`, any WebID is an `agentic:candidateWebId` hint.
2. **Interpret with reliability, not laundering** — turn the body into structured RDF via an injectable
   `Interpreter` (M1 ships a deterministic, hermetic reference: meeting-time / relative-date / yes-no
   extraction). Every datum is a reified PROV **qualified derivation** carrying `agentic:confidence`
   + `agentic:calibration` provenance + the interpreting agent's WebID + its ODRL mandate. A downstream
   gate (`classifyReliability`) does **threshold → human-confirm → always-human-confirm for the
   security tail**.
3. **Reply structured** — assemble a machine-readable carrier for outbound replies: inline JSON-LD
   (signable as a `solid-vc` VC over the canonical graph via an injectable signer) + a
   `multipart/alternative` part + an `X-Agentic-Reply` header + an onboarding link.
4. **Negotiate up** — detect a bridge-capable counterparty, rank the highest mutually-supported channel
   (`rdf ≻ dpop-sk ≻ a2a ≻ email`), and decide an upgrade **fail-closed** (a declined security-bearing
   step aborts; the floor is always a working channel). Wire protocol in `PROTOCOL.md`.

Persistence (`importInbound`) is **owner-private** (fail-closed ACL written first).

## Install (GitHub-installable, no build step)

The built `dist/` is committed, so under `ignore-scripts=true` a consumer needs no build step:

```bash
npm install github:jeswr/agentic-legacy-bridge#main
```

npm publish is a deferred migration, not a blocker.

## Usage

```ts
import {
  parseEmail,
  deterministicInterpreter,
  importInbound,
  InMemoryChannelAdapter,
  buildReply,
  classifyReliability,
  detectBridgeCapability,
} from "@jeswr/agentic-legacy-bridge";

// 1. parse (fail-closed, never crashes on hostile input)
const message = parseEmail(rawEmailBytes);

// 2. interpret with reliability (hermetic reference interpreter)
const interps = deterministicInterpreter.interpret(message, { docIri: "https://pod.example/inbox/m.ttl" });
for (const i of interps) {
  const decision = classifyReliability(i); // "auto" | "confirm" | "audit"
}

// 3. import a whole channel batch into a pod, owner-private (ACL first)
await importInbound({
  adapter: new InMemoryChannelAdapter("email", [{ id: message.messageId ?? "1", raw: rawEmailBytes }]),
  writeFetch: myAuthedSolidFetch, // DPoP/Bearer — injectable
  container: "https://pod.example/inbox/",
  ownerWebId: "https://pod.example/profile/card#me",
  interpretingAgentWebId: "https://agent.example/#me",
  mandateIri: "https://agent.example/mandate#m",
});

// 4. build a structured reply (inject a `sign` for a real VC in production)
const reply = await buildReply({
  inReplyTo: "urn:agentic:raw:…",
  offeredTimes: [{ name: "Call", startTime: "2026-07-08T14:00:00Z", endTime: "2026-07-08T14:30:00Z" }],
  podCopyUrl: "https://pod.example/replies/1.ttl",
  onboardingUrl: "https://onboard.example/#/from/…",
  issuer: "https://agent.example/#me",
  // sign: solidVcSigner,   // M2 — DataIntegrity over the canonical graph
});
// reply.inlineHtml  → the <script type="application/ld+json"> block (HTML-safe)
// reply.mimePart    → the multipart/alternative application/ld+json part
// reply.headers     → { "X-Agentic-Reply": … }

// negotiation (pure)
const cap = detectBridgeCapability({ headers: inboundHeaders });
```

The `./email` subexport is the standalone hardened parser, importable without the RDF/pod machinery.

## The channel-neutral spine (M2.0)

The pipeline runs on one channel-neutral shape, **`BridgeMessage`** (what `EmailMessage` is, minus
the email-isms: `channel`, an untrusted `sender.handle`, plain-text-only `textBody`, a `signals`
header-map equivalent feeding `detectBridgeCapability`, and the raw-anchor digest/media type).
A **`ChannelAdapter`** supplies `parse(raw) → BridgeMessage` — its hardened, pure, hermetically
testable transform — and `importInbound` persists any channel identically (the raw anchor's
extension/content-type follow `rawMediaType`: `.eml` for email, `.json` for event payloads).
Email is the first adapter (`parseEmailInbound` = the M1 hardened parse mapped 1:1;
`toBridgeMessage(email)` is the explicit mapping) and behaves exactly as in M1; every
`EmailMessage`-taking entry point still accepts one unchanged. A refused input throws
`ChannelParseError` (`EmailParseError` extends it) → that message is skipped, never the batch.

Person nodes are **channel-scoped** so identity keys can never collide across namespaces: email
keeps its M1 key (`urn:agentic:person:<base64url(address)>` — back-compatible with already-written
pods); every other channel mints `urn:agentic:person:<channel>:<base64url(handle)>`. Cross-channel
identity is only ever a candidate edge (`agentic:candidatePerson`), never a merge; `safeTelIri`
(strict E.164) is the `safeMailtoIri` sibling for phone-keyed channels. This is the seam the M2.1
(Slack), M2.2 (WhatsApp Cloud), and M2.3 (LLM interpreter) phases plug into.

## Slack (M2.1)

The Slack channel is a single pure transform + a thin adapter — no new pipeline, persistence, ACL, or
person-modelling code (it plugs into the M2.0 spine unchanged):

```ts
import { SlackChannelAdapter, slackEventToBridgeMessage, importInbound } from "@jeswr/agentic-legacy-bridge";

// A Slack Events API `event_callback` (or a `conversations.history` row) → a BridgeMessage.
const m = slackEventToBridgeMessage(rawSlackEventJson);          // pure, fixture-tested, fail-closed

// Or drive the whole owner-private import through the adapter:
await importInbound({
  adapter: new SlackChannelAdapter({ messages: receivedEvents, teamId: "T123" }),
  writeFetch: myAuthedSolidFetch,
  container: "https://pod.example/inbox/",
  ownerWebId: "https://pod.example/profile/card#me",
});
```

`slackEventToBridgeMessage` is **hostile-input-hardened**: the whole event is untrusted, so a
malformed/hostile delivery is **refused** (a `SlackParseError`, which `importInbound` skips — never a
crash, never a batch abort); `text` is treated as **plain text only** (control-stripped, capped —
`blocks`/attachments/rich content are **never** flattened to HTML or persisted, the stored-XSS rule);
the `team`/`user` ids are **shape-validated before minting a URN** (an out-of-shape id → a provisional
anon person node, never an IRI-injection); every id/ts regex is anchored + linear (no ReDoS). The
sender is keyed as the channel-scoped `urn:agentic:person:slack:<base64url(team:user)>` and always
flagged `agentic:identityStatus "unverified"`. Our own structured-reply metadata
(`metadata.event_type: "agentic_reply"`) is mapped into `BridgeMessage.signals` so a bridge-capable
Slack counterparty is detected by `detectBridgeCapability`.

**Events API signature-verification contract (for the M2.4 webhook service — not built here).** The
transform authenticates nothing about the *source*; the deployed receiver must, over the **raw request
body before any JSON parse**: verify `X-Slack-Signature` = `v0=` + HMAC-SHA256(signing secret,
`v0:<X-Slack-Request-Timestamp>:<raw-body>`) in constant time, reject a timestamp skew > 300 s, and ack
within **3 s** (Slack retries ×3 with `X-Slack-Retry-Num`). A deterministic in-pod slug maps a
retried/replayed delivery to the same URL, but the current `importInbound` write path is a plain `PUT`
(overwrite) — retry/replay **idempotency is a property the M2.4 service must add** via create-only
writes (`If-None-Match: *`, treating `412` as already-imported), not something this M2.1 adapter
provides. The `url_verification` handshake is answered by the service (echo `challenge`) — the
transform refuses it.
The live remote read (`conversations.history` backfill / Socket Mode / the bot-token file fetch) MUST
route through `@jeswr/guarded-fetch`, with the bot token only as a request header. Full contract in the
`src/slack.ts` module doc.

## The inbound webhook service (M2.4)

The `@jeswr/agentic-legacy-bridge/webhook` subexport is the deployable, **stateless, pod-as-state**
receiver that ties the M2.1/M2.2 transforms together: it **authenticates the source over the raw
request bytes before any parse**, then writes the message owner-private into a pod **create-only +
idempotent**. Framework-free core + a WinterCG `fetch` adapter — fully testable with no live network
or credentials (every seam — the signature secret, the pod write-fetch, the interpreter, the clock —
is injected). Live channel credentials are a deployment (`needs:user`) concern; nothing is hardcoded.

```ts
import { createFetchWebhookHandler } from "@jeswr/agentic-legacy-bridge/webhook";

// A Vercel / Node / worker fetch handler for the Slack Events API endpoint:
export const POST = createFetchWebhookHandler({
  channel: { channel: "slack", signingSecret: process.env.SLACK_SIGNING_SECRET! },
  container: "https://alice.example/inbox/",     // owner provisions the Append-only ACL once
  writeFetch: bridgeAgentAuthedFetch,            // client-credentials/DPoP, acl:Append only
  markPendingInterpretation: true,               // ack fast; a decoupled sweep runs the LLM pass
});
```

- **Signature verification (fail-closed, before any JSON parse).** Slack `v0` HMAC over
  `v0:<ts>:<raw>` with a 300 s replay window + constant-time compare (`verifySlackSignature`);
  WhatsApp/Meta `X-Hub-Signature-256` HMAC over the raw body + the `hub.challenge` registration echo
  gated on a constant-time verify-token match (`verifyMetaSignature` / `metaVerificationChallenge`).
  An unverifiable request → `401` (Slack) / `403` (Meta registration) with no body detail, nothing
  written or logged beyond a counter.
- **Idempotency = the only state.** Every resource is written create-only (`If-None-Match: *`, a
  `412` = already-imported) keyed on the deterministic stable-message-id slug — a Slack retry, a Meta
  36-h redelivery, or a replayed still-valid request all map to the same URLs and no-op. No dedupe
  table, no sticky instance; a partial delivery heals on the platform's retry.
- **Least privilege.** The bridge writes with an `acl:Append`-only pod identity and never touches an
  ACL at runtime (the owner provisions the owner+bridge ACL once). A one-Meta-delivery-many-messages
  body is fanned out per message; the 1 MiB body cap bounds the fan-out.
- **No SSRF surface at webhook time.** The handler makes NO payload-derived fetch — the only outbound
  is the pod write (own trusted origin, redirect-refusing).

## The channel-upgrade state machine (M2.4)

`transition()` + the `RelationshipStore` / orchestration (`src/upgrade-state.ts`, `src/upgrade.ts`)
model, pod-persisted per counterparty, the ratchet from a legacy channel toward an accountable A2A
path: `legacy-only → bridge-detected → identity-verified → card-discovered → offer-pending →
upgraded`, with fail-closed transitions. **Discovery is gated on a control-of-both–verified WebID**
(never fetched on a spoofable handle); a **required (security-bearing) step never silently
downgrades** (it aborts + surfaces); the **email floor works in every state**. The live probe/offer
transport is an **injectable seam** defaulting to `@jeswr/guarded-fetch`'s DNS-pinning node fetch
(https-only, redirect-refusing, verified-endpoint-only) — so it is fully hermetically testable.

## Security posture

- **The entire input is untrusted.** The RFC 5322 / MIME parser is fail-closed + never hangs: every
  cap is explicit (size, header count, part count, nesting depth), every decode is caught, no regex
  backtracks on attacker input. The only throw is `EmailParseError` for an over-cap input.
- **No header injection** — header values (and RFC-2047-decoded subjects / display names) are forced
  single-line, so a decoded `\r\n` can never split a downstream header.
- **No stored XSS** — HTML is never surfaced as HTML; the body is always plain text. The inline
  JSON-LD reply is HTML-escaped so it cannot break out of the `<script>` element.
- **No RDF injection** — every untrusted string that becomes an IRI goes through `safeHttpIri` /
  `safeMailtoIri`; the owner-only ACL is fail-closed (a breakout char in the owner/container is
  rejected or neutralised, never a public-grant breakout). Triples are built with `n3.Writer` + typed
  quads — never hand-concatenated.
- **Identity is never assumed** from an unauthenticated address; a candidate WebID stays `unverified`
  until a control-of-both challenge closes the loop (the onboarding flow).
- **Everything written is owner-private** (owner-only WAC ACL, written FIRST), never public.
- **The security/value tail is never auto-executed** from an LLM interpretation, at any confidence
  (`classifyReliability`'s hard rule).
- **Outbound (M2 adapters)** MUST route untrusted remote reads through `@jeswr/guarded-fetch` (node
  DNS-pin, https-only, private/loopback/metadata-blocked, redirect-refusing); the pod write uses the
  injectable authed fetch and refuses redirects.

## Follow-ups (M2+)

- **Channels:** Slack parse **landed (M2.1)** — see *Slack* above; the live Slack read/reply
  (`conversations.history` backfill, Socket Mode, the `chat.postMessage` metadata carrier) + a native
  WhatsApp Cloud adapter, the already-working Matrix path (`@jeswr/matrix-chat-to-pod`), and
  Gmail / Microsoft Graph adapters — each behind the `ChannelAdapter` seam, guarded-fetch for reads.
- **Live LLM interpreter:** an adapter over `@jeswr/solid-a2a` `parseIntent({ translate })` implementing
  the same `Interpreter` interface (method `LlmInterpretation`).
- **Reply signing:** a `@jeswr/solid-vc` Data-Integrity signer for the `sign` seam.
- **Onboarding + negotiation transport:** the running service (passkey onboarding, live agent-card
  discovery via `@jeswr/solid-agent-card`, the `solid-a2a` upgrade codec over the wire).
- **Candidate-WebID discovery:** the `solid-webid-index` + `.well-known/webid` lookups §2.1 describes.
- **`agentic:` w3id redirect** — `needs:user`.

## Provenance

Authored by the PSS agent (Claude Opus 4.8) — the session model for this security-sensitive
hostile-input package. Reviewed by codex via roborev (`.roborev.toml`). MIT.
