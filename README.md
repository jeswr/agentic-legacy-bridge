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
> pipeline **channel-neutral** (`BridgeMessage` + `ChannelAdapter.parse`, below); Slack/WhatsApp
> adapters, a live LLM interpreter, `solid-vc` signing, and an inbound-webhook service are the
> remaining M2 phases (see *Follow-ups* and [`docs/M2-DESIGN.md`](./docs/M2-DESIGN.md)).

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

- **Channels:** Slack (Events API), the already-working Matrix path (`@jeswr/matrix-chat-to-pod`),
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
