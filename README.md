# `@jeswr/agentic-legacy-bridge`

The path **FROM** today's channels (email first) **TO** the accountable web of agents.

A four-rung ratchet — *meet legacy where it is, then pull it up* — that composes the suite's hardened
packages rather than rebuilding them. Design record:
[`agentic-solid-vision/docs/LEGACY-INTEROP.md`](https://github.com/jeswr/agentic-solid-vision/blob/main/docs/LEGACY-INTEROP.md);
the paper's §7 "The path from today"; the wire protocol in [`PROTOCOL.md`](./PROTOCOL.md); the design
choices in [`docs/DECISIONS.md`](./docs/DECISIONS.md).

> **Scope.** Email is the first channel; the entire input is untrusted. The core is fully **hermetic** —
> the LLM interpreter, the reply signer, and the channel transport are all **injectable seams**, so
> there is no mandatory live-LLM, crypto, or network dependency in the core. M2's channel-neutral
> spine, Slack and WhatsApp transforms, slot-constrained LLM interpreter, stateless webhook seam,
> pod-persisted upgrade state machine, and approval-gated Slack reply path have landed. Every live
> credential, endpoint, fetch, signer, and approval decision remains injected by the host.

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

## The metadata protocol (M2.6 — deterministic first, LLM last)

The `./metadata` subexport implements `NOW-PERSONAL-AGENT.md` §5 (documented in `PROTOCOL.md` §5):

- **Inbound (Rule 1):** `structuredMetadataInterpreter` (a drop-in sync `Interpreter`) /
  `extractStructuredMetadata` (async, verifier-aware) read the machine-readable metadata senders
  already emit — Gmail-markup **schema.org JSON-LD**, **`text/calendar` VEVENTs** (invites,
  cancellations), and a peer's **`AgenticReply`** carrier — with fixed code at deterministic
  confidence, before any model reads anything. `composeInterpreters(structuredMetadataInterpreter,
  deterministicInterpreter)` chains structured-first with the prose fallback.
- **Outbound (Rule 2):** `buildReply({ dateSent, sender, … })` carries the sent-at envelope on every
  reply; `buildActionMetadata` emits the standalone signed "sent at *time*" descriptor
  (schema.org + PROV, minting nothing).
- **Patterns (Rule 3):** exchange shapes are SHACL documents at stable IRIs, content-addressed by
  SHA-256 over RDFC-1.0 (the `a2a-rdf-extension` `protocolHash` mechanism) and referenced via
  `dct:conformsTo` — a peer learns each pattern once, caches `(hash → handler)`, and runs LLM-free
  thereafter. `sent-at` and `propose-times` ship pre-cached (`KNOWN_PATTERN_HASHES`,
  `verifyPatternDocument`).

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
// reply.humanText   → answer + one recommendation to continue in full A2A mode

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

**Events API signature-verification contract.** The transform authenticates nothing about the
*source*; the deployed `./webhook` receiver verifies, over the **raw request body before any JSON
parse**, `X-Slack-Signature` = `v0=` + HMAC-SHA256(signing secret,
`v0:<X-Slack-Request-Timestamp>:<raw-body>`) in constant time, rejects timestamp skew > 300 s, and
keeps the hot path deterministic. Create-only pod writes (`If-None-Match: *`; `412` = already
imported) make Slack retries/replays idempotent, and the receiver answers `url_verification` by
echoing its signed challenge.
The live remote read (`conversations.history` backfill / Socket Mode / the bot-token file fetch) MUST
route through `@jeswr/guarded-fetch`, with the bot token only as a request header. Full contract in the
`src/slack.ts` module doc.

## Respond and recommend the A2A upgrade

`respondAndRecommendUpgrade` is the explicit outbound policy boundary: it answers on a configured
legacy channel, embeds the normal structured carrier, and appends one link recommending full agentic
(A2A) mode. It **defaults to approval-required**. With no approver it returns a complete
`pending-approval` draft and performs no send; `auto-send` is available only as an explicit opt-in.
Missing/blank answers use an honest review-needed acknowledgement rather than fabricating content.

```ts
import {
  SlackChannelAdapter,
  respondAndRecommendUpgrade,
} from "@jeswr/agentic-legacy-bridge";

const slack = new SlackChannelAdapter({
  reply: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    // fetch is injectable for recorded-fixture tests; global fetch is the live default.
    // apiEndpoint may be injected, but is fail-closed to this exact Slack HTTPS endpoint:
    apiEndpoint: process.env.SLACK_API_ENDPOINT ?? "https://slack.com/api/chat.postMessage",
  },
});

const outcome = await respondAndRecommendUpgrade({
  adapter: slack,
  target: { to: "C123ABC456", inReplyToId: "C123ABC456:1784383200.000100" },
  answer: "Tuesday at 14:00 works for me.",
  upgradeUrl: process.env.A2A_UPGRADE_URL!,
  reply: {
    inReplyTo: "urn:agentic:raw:…",
    podCopyUrl: "https://pod.example/replies/1.ttl",
    issuer: process.env.AGENT_WEBID!,
  },
  approve: async (draft) => approvalQueue.approve(draft),
  // deliveryMode: "auto-send", // explicit opt-in only; not recommended as the default
});
```

The live Slack sender posts top-level plain text for accessibility, disables mrkdwn and URL/media
unfurls, replies only to validated Slack conversation/thread IDs, and puts only the advertised
channel set plus pod-copy pointer in `metadata.event_payload`. Inbound bot/app-authored-message
refusal (preventing a reply loop) is scoped to **this bridge's own identity, per field and
fail-closed** — pass `ownBotId`/`ownAppId` (from Slack's `auth.test`) to
`SlackChannelAdapter`/`slackEventToBridgeMessage` so a DIFFERENT counterparty's own bridge bot can
still be read for its Rung-3 capability signal (including Slack's `bot_message` subtype). A message
is only ever accepted as foreign when EVERY identity signal it carries is both comparable (the
matching own-id is configured) and non-matching; an uncomparable signal (an own-id left
unconfigured, or a bare `bot_message` subtype with no id at all) is conservatively refused, so a
partial own-identity configuration can never reopen the loop. Omit both to keep the original safe
default of refusing every bot/app message. The bot token is attached only
to the exact `https://slack.com/api/chat.postMessage` origin/path; redirects and oversized/stalled
responses are refused.

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

## Exact live configuration and credentials

The package never reads environment variables itself; these names define the recommended **host
adapter contract**. The host maps them into the injected options shown above, so unit tests use fake
fetches and recorded fixtures without any secret.

| Name | Required for | Exact value / source |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Slack Events webhook | Slack app → **Basic Information → App Credentials → Signing Secret**. This is not the deprecated verification token. Inject as `channel.signingSecret`. |
| `SLACK_BOT_TOKEN` | Slack replies (and optional API backfill) | Bot User OAuth Token beginning `xoxb-`, with `chat:write`; install/invite the app to each target conversation. Add only the history scopes for inbound surfaces actually enabled (`channels:history`, `groups:history`, `im:history`, `mpim:history`) and `app_mentions:read` if subscribing to `app_mention`. |
| `SLACK_EVENT_SUBSCRIPTIONS` | Slack app configuration | Subscribe only to the surfaces the deployment imports: one or more of `message.channels`, `message.groups`, `message.im`, `message.mpim`, plus `app_mention` if desired. Point the Events API Request URL at `WEBHOOK_PUBLIC_URL`. This is configuration, not a secret. |
| `SLACK_API_ENDPOINT` | Slack replies | Optional; if set it must be exactly `https://slack.com/api/chat.postMessage`. The strict endpoint gate prevents bearer-token exfiltration. |
| `WEBHOOK_PUBLIC_URL` | Slack app configuration | Public HTTPS URL mounted to `createFetchWebhookHandler`, for example `https://bridge.example/webhooks/slack`; enter it as the Slack Events API **Request URL**. The package does not read this value. |
| `POD_INBOX_CONTAINER` | Webhook persistence | Canonical owner-controlled Solid container URL ending `/`, with no query/fragment, e.g. `https://alice.example/inbox/`. |
| `BRIDGE_WEBID` | Pod ACL provisioning | The bridge service-agent WebID granted **Append only** on `POD_INBOX_CONTAINER`; keep owner `Read/Write/Control`. The webhook never writes ACLs. |
| `SOLID_OIDC_ISSUER` | Constructing `writeFetch` | Solid issuer used by the host's client-credentials/DPoP flow. |
| `SOLID_CLIENT_ID` | Constructing `writeFetch` | Bridge service client identifier. |
| `SOLID_CLIENT_SECRET` | Constructing `writeFetch` | Bridge service client secret, held only in the deployment secret store. Inject the resulting authenticated fetch as `writeFetch`; never pass the secret to this package. |
| `POD_RELATIONSHIP_CONTAINER` | Upgrade-state persistence | Owner-private Solid container ending `/`, e.g. `https://alice.example/relationships/`. Relationship resources require ETag-enabled `GET` plus conditional `PUT`; this must not be public or Append-only. |
| `NEGOTIATION_WEBID` | Relationship ACL / upgrade orchestration | A separate service/owner WebID granted `Read` + `Write` on `POD_RELATIONSHIP_CONTAINER`; do not widen the webhook identity's Append-only inbox grant. |
| `NEGOTIATION_SOLID_OIDC_ISSUER` | Constructing relationship `readFetch`/`writeFetch` | Solid issuer for the negotiation identity's client-credentials/DPoP flow. |
| `NEGOTIATION_SOLID_CLIENT_ID` | Constructing relationship `readFetch`/`writeFetch` | Negotiation identity client identifier. |
| `NEGOTIATION_SOLID_CLIENT_SECRET` | Constructing relationship `readFetch`/`writeFetch` | Negotiation identity client secret, held only in the deployment secret store. Inject authenticated fetch functions; never pass the secret into relationship data. |
| `AGENT_WEBID` | Reply issuer / provenance | Replying agent's HTTPS WebID. |
| `ODRL_MANDATE_IRI` | Interpretation provenance | HTTPS IRI of the owner's mandate; inject as `mandateIri`. |
| `A2A_UPGRADE_URL` | Upgrade recommendation | Credential-free HTTPS onboarding/A2A continuation URL (opaque token in fragment/path is allowed; max 2048 characters). |
| `REPLY_DELIVERY_MODE` | Outbound policy | Recommended `approval-required` (also the code default). Set `auto-send` only after a maintainer explicitly accepts the impersonation, loop, and mistaken-answer risk. |

Email remains the shipped M1 hardened parser plus the injectable `ChannelAdapter` seam; this package
does **not** open an IMAP or SMTP connection itself. For a conventional live IMAP/SMTP host adapter,
the maintainer must provide `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT`, `EMAIL_IMAP_SECURE`,
`EMAIL_IMAP_USERNAME`, and either `EMAIL_IMAP_PASSWORD` or an OAuth access/refresh-token provider for
inbound; plus `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_USERNAME`,
`EMAIL_SMTP_PASSWORD` (or OAuth provider), and `EMAIL_FROM` for replies. Those credentials belong only
to the injected email adapter and deployment secret store. Gmail API or Microsoft Graph deployments
instead supply their provider's OAuth client id/secret, refresh token and mailbox identifier; no
provider-specific OAuth implementation is hidden in this package.

## The channel-upgrade state machine (M2.5)

`transition()` + the `RelationshipStore` / orchestration (`src/upgrade-state.ts`, `src/upgrade.ts`)
model, pod-persisted per counterparty, the ratchet from a legacy channel toward an accountable A2A
path: `legacy-only → bridge-detected → identity-verified → card-discovered → offer-pending →
upgraded`, with fail-closed transitions. **Discovery is gated on a control-of-both–verified WebID**
(never fetched on a spoofable handle); a **required (security-bearing) step never silently
downgrades** (it aborts + surfaces); the **email floor works in every state**. The live probe/offer
transport is an **injectable seam** defaulting to `@jeswr/guarded-fetch`'s DNS-pinning node fetch
(https-only, redirect-refusing, verified-endpoint-only) — so it is fully hermetically testable.
`offer-pending` is written with optimistic concurrency **before** transport; an outage leaves a
durable, identical-offer-only retry point, and the peer response resolves it with the persisted ETag.

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
- **Outbound replies require approval by default.** Parsing/interpretation never implies authority to
  send; `auto-send` is a deliberate host opt-in, and bot/app-authored Slack events are refused to
  prevent responder loops.
- **Outbound (M2 adapters)** MUST route untrusted remote reads through `@jeswr/guarded-fetch` (node
  DNS-pin, https-only, private/loopback/metadata-blocked, redirect-refusing); the pod write uses the
  injectable authed fetch and refuses redirects.

## Follow-ups (M2+)

- **Channels:** Slack parse/webhook/reply and native WhatsApp parsing/webhook have landed. Remaining
  transport work is Slack `conversations.history` backfill + Socket Mode, WhatsApp free-form/template
  send policy, and Gmail / Microsoft Graph adapters — each behind `ChannelAdapter`, guarded-fetch for
  reads.
- **Reply signing + verification:** a `@jeswr/solid-vc` Data-Integrity signer for the `sign` seam
  and the matching `AgenticReplyVerifier` adapter (until injected, inbound `AgenticReply` blocks
  stay `SelfReported` — never auto-run).
- **More pattern shapes:** `accept-time`, `decline-with-alternatives`, `request-document` — same
  SHACL + RDFC-1.0-hash mechanism as `sent-at`/`propose-times`; and the FlightReservation /
  ParcelDelivery Gmail-markup families in the JSON-LD extractor's closed table.
- **Onboarding + negotiation transport:** the running service (passkey onboarding, live agent-card
  discovery via `@jeswr/solid-agent-card`, the `solid-a2a` upgrade codec over the wire).
- **Candidate-WebID discovery:** the `solid-webid-index` + `.well-known/webid` lookups §2.1 describes.
- **`agentic:` w3id redirect** — `needs:user`.

## Provenance

Authored by the PSS agent — M1–M2.5a by Claude Opus 4.8 (the then-session model for this
security-sensitive hostile-input package), the M2.6 metadata protocol by Claude Fable 5. Reviewed
by codex via roborev (`.roborev.toml`). MIT.
