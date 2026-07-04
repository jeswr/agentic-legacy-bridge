# Design decisions — `@jeswr/agentic-legacy-bridge`

<!-- AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate. -->

Decisions taken while building M1 (the FROM-email path). Per the suite
proceed-without-greenlight rule, each open question in
[`full-solid-ecosystem#20`](https://github.com/jeswr/full-solid-ecosystem/issues/20) is answered
with the best-choice default — following the already-drafted, roborev-clean design in
`agentic-solid-vision/docs/LEGACY-INTEROP.md` — and recorded here for the maintainer to steer
after the fact. The mirror comment is on issue #20.

The three questions that GATE M1 code (reliability model, reply carrier, channel-first) are answered
in D1–D3; the two product/policy questions (nudge aggressiveness, LLM-privacy) are D4–D5.

---

## D1 — Reliability-model shape *(gates the RDF interpretation surface)*

**Chosen:** the per-datum `agentic:confidence` (`xsd:decimal`, [0,1]) + `agentic:calibration`
provenance (`SelfReported` / `Calibrated` / `Verified`) + `agentic:interpretationMethod`
(`Deterministic` / `LlmInterpretation` / `HumanConfirmed`), emitted as a **reified PROV qualified
derivation** — NOT confidence as a first-class second-model "reliability credential" (for M1).
Default thresholds **τ_auto = 0.9, τ_confirm = 0.5** (`DEFAULT_THRESHOLDS`).

**Why.** (LEGACY-INTEROP.md §3b.) Reliability is *per-datum*, not per-message — one email yields a
high-confidence "wants to meet" and a low-confidence "…probably Tuesday", and scoring the message as
a whole would let the weakest datum poison the strongest. The score carries its *own* provenance so a
self-reported 0.9 is never treated like a calibrated 0.9 (`classifyReliability` requires
`Calibrated`/`Verified` for the `auto` decision — a high self-reported score is quarantined for
human confirm). The reified shape lets a consumer materialise the plain triple **only after** it
passes the gate.

A first-class "reliability credential" (a second model issuing a VC over the first's output) is
strictly heavier — a second signer, a second graph, a verification step — and buys nothing M1 needs;
it is recorded here as a **deferred option** for when a calibrated cross-checking model exists (the
`Calibrated` calibration value is the seam for it). The per-datum annotation is forward-compatible
with it (a reliability credential would simply *set* `calibration = Verified` + a `prov:` link).

**The hard rule is code, not prose** (`classifyReliability`): a `securityBearing` datum is **never**
`auto`, at any confidence — grant/pay/sign/share/delete always need a human confirm. "A model that is
confidently wrong about a payee must not be able to pay them."

## D2 — Reply-metadata carrier *(gates the reply surface)*

**Chosen:** **inline JSON-LD** as the primary carrier, signable as a `@jeswr/solid-vc` Verifiable
Credential **over the RDFC-1.0 canonical graph** (via an *injectable* `sign` seam in M1 — the
concrete Data-Integrity signer is the M2 adapter), **plus** a `multipart/alternative`
`application/ld+json` fallback part **plus** an `X-Agentic-Reply` header → the authoritative pod copy.
The inline JSON is HTML-escaped so it cannot break out of the `<script>` element.

**Why.** (LEGACY-INTEROP.md §4.2.) Inline JSON-LD is Gmail's own supported markup path and, being
part of the body, survives forwarding without special client support (highest reach). The
re-flow/re-encode fragility of an inline body is solved by **signing the graph, not the bytes**:
RDFC-1.0 canonicalisation makes whitespace/ordering/encoding differences vanish, so the proof holds
even if a mail client mangles the surrounding HTML. The MIME part gives agent-aware clients byte-exact
fidelity; the header lets a recipient agent find the full pod copy without scraping; a human just
reads the prose. All three carry the identical canonical graph. (MIME-only was rejected — many
clients drop unknown alternatives; RDFa was rejected — couples data to presentation, brittle under
client rewriting; a signed attachment is used only for the authoritative pod copy, referenced by
link, because gateways strip attachments and cold-contact attachments read as phishing.)

**M1 honesty:** without an injected signer the reply is an **unsigned** `AgenticReply` — it does NOT
claim the `VerifiableCredential` type (only claimed once a `proof` is attached). Production MUST
supply the signer.

## D3 — Which legacy channel to prototype first *(gates the channel surface)*

**Chosen: email first** (per the maintainer's verbatim ask), behind a `ChannelAdapter` seam so
Slack / Matrix / Gmail-API adapters drop in as M2 without touching the core.

**Why.** Email has the widest reach and the hardest identity story — building it first forces the
candidate-vs-verified WebID discipline (D-adjacent: an email `From:` authenticates nothing) to be
correct from the start, rather than bolting it on after an easier bounded-workspace channel. The
`matrix-chat-to-pod` path is already a working inbound bridge, so leaning on it would be the *fastest*
demo — but it would not exercise the email identity problem the vision most needs solved. Email is
also the channel a non-technical recipient is guaranteed to have, which is what the onboarding ratchet
(D4) needs. Slack (bounded workspace, cleaner identity) and the Matrix path are **M2**.

## D4 — Channel-upgrade / onboarding aggressiveness *(product/policy)*

**Chosen: one unobtrusive link** — a single "want your own assistant to read this? set one up: `<url>`"
block appended after the human prose (`buildReply`'s `onboardingBlock`), never a hard CTA, banner, or
repeated nag.

**Why.** (LEGACY-INTEROP.md §9 Q3.) Over-nudging reads as spam and burns the trust the whole ratchet
depends on. The value proposition (a structured, verifiable reply your agent can act on) is
self-evidencing to a recipient who wants it; a recipient who does not still gets a perfectly good
human email with inline structured data any future agent can read. The ratchet's teeth are *opt-in
and always-degrading*, so a gentle single link is the correct default. Flagged for maintainer steer if
conversion proves too low.

## D5 — Privacy of LLM-interpreting inbound legacy messages *(product/policy — the sharpest issue)*

**Chosen (design commitment; enforced by the injectable seam in M1):** interpret **in the owner's own
trust boundary** (the `translate`/`Interpreter` seam is injected by the pod owner — the default is
their own model endpoint, not a shared cloud service), **data-minimised** (the interpreter sees the
message body needed for the task, never the whole mailbox; raw bytes stay owner-private), **under an
explicit ODRL mandate** (`prov:hadPlan` on every interpretation activity — the interpretation is
itself an accountable, mandated action), and **no auto-share** (the reliability gate's
always-human-confirm rule covers "share outward"). M1 does NOT ship a live LLM — the reference
interpreter is deterministic and hermetic — so no third-party words leave the box at all in M1.

**Open sub-question kept for the maintainer:** whether an *explicit consent/notice model* is also
needed (the sender did not consent to LLM processing of *their* words). The current answer —
owner-trust-boundary + data-minimisation + mandate + no-auto-share — is judged sufficient for a
personal assistant reading its owner's own inbox, but a **notice** (e.g. a footer on the structured
reply: "an assistant interpreted your message") is a low-cost addition the maintainer may want; it is
NOT built in M1. This is the one D that is genuinely a values call, so it is surfaced most prominently.

---

## Structural decisions (not in #20, but taken while building)

- **New package, not a doc addition or an extension of an existing bridge** — the reliability model,
  the reply-carrier assembly, and the onboarding/negotiation wiring are genuinely new surface;
  channel-plurality is a package boundary. (LEGACY-INTEROP.md §7.)
- **One minted namespace only:** `https://w3id.org/jeswr/agentic#`, for the reliability annotation +
  the raw-message anchor (no W3C Recommendation exists for epistemic confidence). Everything else
  reuses PROV / schema.org / Dublin Core / vcard / foaf / ACL. The `agentic:` w3id redirect is a
  `needs:user` item.
- **Minimal deps:** `n3` (npm) + `@jeswr/solid-chat-interop` + `@jeswr/guarded-fetch` (both git,
  sha-pinned) — identical to the sibling `@jeswr/matrix-chat-to-pod`. No live-LLM, no crypto, no
  network dependency in M1 (both are injectable seams). `guarded-fetch` is depended on for its
  consolidated `isWithinPodScope` write-scope primitive and to make its node pinning fetch available
  to the M2 live adapters.
- **Interpreter + signer + channel are all injectable seams** so M1 is fully hermetic and the heavy
  M2 dependencies (a live LLM via `solid-a2a` `parseIntent`; `solid-vc` signing; IMAP/Gmail/Graph
  adapters) plug into the SAME interfaces without a core rewrite.
- **Persistence layout:** per message, owner-private under one owner-locked container (ACL written
  FIRST): `<slug>.eml` (byte-exact raw anchor), `<slug>.ttl` (the agentic graph), `<slug>.chat.ttl`
  (the `solid-chat-interop` CanonicalMessage for `/chat`).
