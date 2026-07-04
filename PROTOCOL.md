# The legacy-bridge wire protocol

<!-- AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate. -->

How an agentic reply advertises itself over a legacy channel and how two bridge-capable parties
negotiate off email onto a better channel. This is the concrete, documented form of
`agentic-solid-vision/docs/LEGACY-INTEROP.md` §4–§5. M1 ships the **pure decision logic**
(`detectBridgeCapability`, `highestMutualChannel`, `decideUpgrade`); the **live transport** (fetching
a peer's agent card, running the handshake over the wire) is the M2 adapter and composes
`@jeswr/solid-agent-card` + `@jeswr/solid-a2a` through `@jeswr/guarded-fetch`.

## 1. Advertising a structured reply

An outbound reply built by `buildReply` carries the structured payload in three redundant places
(all the same canonical graph — see `docs/DECISIONS.md` D2):

| Carrier | Where | For |
|---|---|---|
| Inline JSON-LD | `<script type="application/ld+json">…</script>` in the HTML body | any client (survives forwarding) — the primary |
| MIME part | a `multipart/alternative` `application/ld+json` part | agent-aware clients (byte-exact) |
| Header pointer | `X-Agentic-Reply: <pod-url>` | a recipient agent locating the authoritative pod copy |

A reply MAY also advertise its supported upgrade channels:

```
X-Agentic-Channels: rdf, dpop-sk, a2a
```

The values are drawn from the fixed channel vocabulary (§3). `email` is implicit (it is how the
message arrived) and need not be listed.

## 2. Detecting a bridge-capable counterparty

`detectBridgeCapability({ headers, jsonLd })` returns `{ capable, channels, podCopyUrl? }`. A
counterparty is **capable** if an inbound message shows any bridge marker:

- an `X-Agentic-Reply` header (a safe http(s) pod-copy URL), or
- an `X-Agentic-Channels` header, or
- an inline JSON-LD block whose `type` includes `AgenticReply`.

`channels` is the advertised set intersected with the known vocabulary, always including `email` as
the floor, returned in preference order. Everything is parsed from what an inbound message *already
carries* — no network. (Full capability discovery — reading the peer's
`.well-known/agent-card.json` A2A `capabilities.extensions` array — is M2.)

## 3. The channel vocabulary + preference order

Most-preferred first (`CHANNEL_PREFERENCE`):

| Channel | A2A extension URI (`CHANNEL_EXTENSION_URI`) | Meaning |
|---|---|---|
| `rdf` | `https://w3id.org/jeswr/a2a-rdf/v1` | RDF-native structured exchange ([`jeswr/a2a-rdf-extension`](https://github.com/jeswr/a2a-rdf-extension)) |
| `dpop-sk` | `https://w3id.org/jeswr/dpop-sk/v1` | the DPoP-SK browser fast-path ([`jeswr/dpop-sk-spec`](https://github.com/jeswr/dpop-sk-spec)) |
| `a2a` | `https://a2a-protocol.org/` | plain A2A JSON |
| `email` | `urn:agentic:channel:email` | the floor — always works |

`highestMutualChannel(local, peer)` returns the highest channel both sides support, falling back to
`email`. Both sides implicitly support `email`.

## 4. The upgrade handshake (fail-closed)

Once both parties have agents, the initiator sends an **upgrade offer** naming the target protocol
document (mirrors `@jeswr/solid-a2a`'s `encodeUpgradeOffer`):

```
UpgradeOffer  = { targetChannel, protocolHash?, protocolSource?, required }
UpgradeResponse = { accept, protocolHash? }
```

`decideUpgrade(offer, response, currentChannel)` decides, **fail-closed**:

| Peer response | `offer.required` | Outcome |
|---|---|---|
| accept, hash matches (or no hash set) | — | `upgrade` to `targetChannel` |
| accept, hash **mismatch** | — | **`abort`** (tampered/ambiguous protocol binding) |
| decline | `true` | **`abort`** — a security-bearing step must NOT proceed in unsigned prose |
| decline | `false` | `stay` at `currentChannel` (the floor still works) |

Two invariants, non-negotiable:

1. **No silent downgrade of a security-bearing step.** A declined `required` offer aborts rather than
   quietly continuing in prose — the reliability model's always-human-confirm rule expressed on the
   transport (a `required`/security datum can *propose* but never *authorise*).
2. **The floor always works.** Every non-abort outcome leaves a working channel underneath — worst
   case, email with inline structured data any future agent can still read.

## 5. Onboarding

The reply's onboarding link (`buildReply`'s `onboardingBlock`, one unobtrusive link — `docs/DECISIONS.md`
D4) leads to the suite's passkey-first sign-up (account + WebID + storage in one go), seeded with the
message context. On completion the recipient has a WebID + pod + their own agent card (which already
understands the `AgenticReply` shape), and the deferred `mailto:`→WebID identity binding can be
upgraded from `unverified` to verified (they proved control of both the mailbox — they clicked a link
sent to it — and the new WebID). This is the loop `LEGACY-INTEROP.md` §2.1 defers and §5.1 closes; the
running onboarding service is M2+.
