// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmailParseError, parseEmail } from "./parse.js";

const CRLF = "\r\n";
function msg(headers: string, body = ""): string {
  return `${headers}${CRLF}${CRLF}${body}`;
}

describe("parseEmail — basic envelope", () => {
  it("parses From/To/Subject/Date and a plain body", () => {
    const m = parseEmail(
      msg(
        [
          "From: Jane Doe <jane@example.com>",
          "To: bob@example.org",
          "Subject: Lunch?",
          "Date: Wed, 08 Jul 2026 14:00:00 +0000",
        ].join(CRLF),
        "Shall we meet?",
      ),
    );
    expect(m.from?.address).toBe("jane@example.com");
    expect(m.from?.displayName).toBe("Jane Doe");
    expect(m.to[0]?.address).toBe("bob@example.org");
    expect(m.subject).toBe("Lunch?");
    expect(m.date).toBe("2026-07-08T14:00:00.000Z");
    expect(m.textBody).toBe("Shall we meet?");
  });

  it("computes the raw sha-256 over the input bytes", () => {
    const raw = msg("From: a@b.com", "hi");
    const m = parseEmail(raw);
    expect(m.rawSha256).toBe(createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));
    expect(m.rawByteLength).toBe(Buffer.byteLength(raw));
  });

  it("accepts a Uint8Array input", () => {
    const m = parseEmail(new TextEncoder().encode(msg("From: a@b.com", "bytes body")));
    expect(m.textBody).toBe("bytes body");
    expect(m.from?.address).toBe("a@b.com");
  });

  it("handles LF-only line endings", () => {
    const m = parseEmail("From: a@b.com\nSubject: x\n\nbody");
    expect(m.from?.address).toBe("a@b.com");
    expect(m.subject).toBe("x");
    expect(m.textBody).toBe("body");
  });

  it("returns empty structure for empty input (never throws)", () => {
    const m = parseEmail("");
    expect(m.from).toBeUndefined();
    expect(m.to).toEqual([]);
    expect(m.textBody).toBe("");
  });
});

describe("parseEmail — header hardening", () => {
  it("strips CR/LF from a header value (no header injection)", () => {
    // A folded/hostile Subject cannot smuggle a second header downstream.
    const m = parseEmail(msg(["Subject: hello", " world", "X-Evil: injected"].join(CRLF), "b"));
    expect(m.subject).toBe("hello world");
    // The continuation is folded into Subject; the value carries no CR/LF.
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("does not let an injected newline in a decoded value split a header", () => {
    // Even if an encoded-word decodes to text containing CR/LF, it is control-stripped.
    const m = parseEmail(msg("Subject: =?utf-8?B?YQ0KWC1FdmlsOiBi?=", "body"));
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.headers.find(([n]) => n === "x-evil")).toBeUndefined();
  });

  it("unfolds folding-whitespace continuations", () => {
    const m = parseEmail(msg(["To: a@b.com,", " c@d.com"].join(CRLF), "x"));
    expect(m.to.map((a) => a.address)).toEqual(["a@b.com", "c@d.com"]);
  });

  it("skips malformed header lines without a colon", () => {
    const m = parseEmail(msg(["From: a@b.com", "garbage-no-colon", "Subject: ok"].join(CRLF), "x"));
    expect(m.from?.address).toBe("a@b.com");
    expect(m.subject).toBe("ok");
  });

  it("caps a huge number of headers with a warning", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `X-H${i}: v`).join(CRLF);
    const m = parseEmail(msg(many, "b"));
    expect(m.warnings.some((w) => w.includes("headers"))).toBe(true);
    expect(m.headers.length).toBeLessThanOrEqual(512);
  });
});

describe("parseEmail — MIME + encodings", () => {
  it("decodes quoted-printable with soft line breaks", () => {
    const m = parseEmail(
      msg(
        [
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
        ].join(CRLF),
        "Hello=20World=\r\ncontinued caf=C3=A9",
      ),
    );
    expect(m.textBody).toBe("Hello Worldcontinued café");
  });

  it("decodes base64 parts", () => {
    const b64 = Buffer.from("café ☕", "utf8").toString("base64");
    const m = parseEmail(
      msg(
        ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"].join(CRLF),
        b64,
      ),
    );
    expect(m.textBody).toBe("café ☕");
  });

  it("prefers a text/plain part in multipart/alternative and never surfaces HTML", () => {
    const boundary = "BOUND";
    const body = [
      `--${boundary}`,
      "Content-Type: text/html",
      "",
      "<p>hi <script>alert(1)</script></p>",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "hi plain",
      `--${boundary}--`,
    ].join(CRLF);
    const m = parseEmail(msg(`Content-Type: multipart/alternative; boundary="${boundary}"`, body));
    expect(m.textBody).toContain("hi plain");
    expect(m.textBody).not.toContain("<script>");
    expect(m.textBody).not.toContain("<p>");
  });

  it("tag-strips text/html when no text/plain part exists (HTML never persisted)", () => {
    const m = parseEmail(
      msg("Content-Type: text/html", "<div>Hello <b>bold</b> <script>evil()</script></div>"),
    );
    expect(m.textBody).toContain("Hello");
    expect(m.textBody).toContain("bold");
    expect(m.textBody).not.toContain("<");
    expect(m.textBody).not.toContain("evil()");
    expect(m.warnings.some((w) => w.includes("text/html"))).toBe(true);
  });

  it("decodes RFC 2047 encoded-word subjects (both B and Q)", () => {
    const b = parseEmail(
      msg(`Subject: =?utf-8?B?${Buffer.from("Réunion", "utf8").toString("base64")}?=`),
    );
    expect(b.subject).toBe("Réunion");
    const q = parseEmail(msg("Subject: =?utf-8?Q?caf=C3=A9_time?="));
    expect(q.subject).toBe("café time");
  });

  it("leaves a malformed encoded-word literal", () => {
    const m = parseEmail(msg("Subject: =?utf-8?X?whatever?="));
    expect(m.subject).toBe("=?utf-8?X?whatever?=");
  });

  it("does not crash on malformed base64 / quoted-printable", () => {
    expect(() =>
      parseEmail(msg("Content-Transfer-Encoding: base64", "!!!not base64!!! %%% \x00\x01")),
    ).not.toThrow();
    const qp = parseEmail(msg("Content-Transfer-Encoding: quoted-printable", "a=ZZb=%end="));
    expect(qp.textBody).toContain("a=ZZb");
  });

  it("falls back on an unknown charset", () => {
    const m = parseEmail(
      msg("Content-Type: text/plain; charset=x-not-a-real-charset", "plain ascii body"),
    );
    expect(m.textBody).toBe("plain ascii body");
  });
});

describe("parseEmail — DoS + fail-closed caps", () => {
  it("throws EmailParseError above the hard byte cap", () => {
    // Construct a Buffer just over the cap cheaply.
    const big = Buffer.alloc(30 * 1024 * 1024 + 1, 0x61);
    expect(() => parseEmail(big)).toThrow(EmailParseError);
  });

  it("bounds deeply nested multipart", () => {
    // 20 levels of nesting (built innermost-out so boundaries nest correctly) — must
    // terminate at the depth cap (12), not hang, and warn.
    let entity = "leaf text";
    let entityCt = "text/plain";
    for (let i = 1; i <= 20; i++) {
      entity = [`--B${i}`, `Content-Type: ${entityCt}`, "", entity, `--B${i}--`].join(CRLF);
      entityCt = `multipart/mixed; boundary="B${i}"`;
    }
    const m = parseEmail(msg(`Content-Type: ${entityCt}`, entity));
    expect(m).toBeDefined();
    expect(m.warnings.some((w) => w.toLowerCase().includes("depth"))).toBe(true);
  });

  it("does not hang on a pathological repeated pattern (linear scan)", () => {
    const started = Date.now();
    parseEmail(msg(`Subject: ${"=?utf-8?Q?a?= ".repeat(2000)}`));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // --- ReDoS regressions: each input would have blown up a specific super-linear
  // regex that has since been replaced with a linear scan. The 5s bound is a
  // decisive proof (the pre-fix code took tens of seconds → minutes on these); the
  // point is bounded time, not the exact number (timing is inherently noisy).

  it("html/tag-strip: a '<'-flood does not blow up (was `/<[^>]{0,8192}>/g`)", () => {
    // A megabyte of '<' with no '>' forced the OLD bounded-class regex to re-scan up
    // to 8192 chars at every position — measured ~10s at 200 KB, i.e. minutes here.
    // A '<' with no '>' is not a tag, so it stays as harmless literal text (Turtle-
    // escaped on write); the ReDoS property under test is bounded TIME + bounded
    // output (tag removal itself is covered by the text/html tests above).
    const html = "<".repeat(1_000_000);
    const started = Date.now();
    const m = parseEmail(msg("Content-Type: text/html", html));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(m.textBody.length).toBeLessThanOrEqual(512 * 1024);
  });

  it("multipart: a giant trailing-space line does not blow up (was `/[\\t ]+$/`)", () => {
    // A single body line of hundreds of thousands of spaces then a non-space char
    // drove the OLD per-line `line.replace(/[\t ]+$/, "")` quadratic — measured 65s
    // at 200 KB (→ minutes at 400 KB). 400 K spaces stays under the 512 KB text-body
    // cap so the trailing 'x' is retained and asserted.
    const boundary = "B";
    const bigLine = `${" ".repeat(400_000)}x`;
    const body = [`--${boundary}`, "Content-Type: text/plain", "", bigLine, `--${boundary}--`].join(
      CRLF,
    );
    const started = Date.now();
    const m = parseEmail(msg(`Content-Type: multipart/mixed; boundary="${boundary}"`, body));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(m.textBody).toContain("x");
  });

  it("html: an unterminated <script flood does not blow up (was a bounded-lazy regex)", () => {
    // Many '<script' tokens with no matching '</script>' — the linear stripBlock scan
    // drops the unterminated remainder without re-scanning.
    const html = `ok<b>keep</b>${"<script".repeat(200_000)}`;
    const started = Date.now();
    const m = parseEmail(msg("Content-Type: text/html", html));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(m.textBody).toContain("keep");
    expect(m.textBody).not.toContain("<script");
  });

  it("html: a tag longer than the old 8192 cap is now fully stripped (no HTML re-emit)", () => {
    // The old bounded `<[^>]{0,8192}>` LEFT an over-long tag literal; the linear
    // stripTags removes it regardless of length — strictly safer (output is plain text).
    const html = `before<a ${"x".repeat(20_000)}>after`;
    const m = parseEmail(msg("Content-Type: text/html", html));
    expect(m.textBody).toContain("before");
    expect(m.textBody).toContain("after");
    expect(m.textBody).not.toContain("<");
    expect(m.textBody).not.toContain("xxxx");
  });
});

describe("parseEmail — DKIM + message-id", () => {
  it("extracts the claimed DKIM d= domain", () => {
    const m = parseEmail(
      msg(["DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; bh=x; b=y"].join(CRLF), "b"),
    );
    expect(m.dkimDomain).toBe("example.com");
  });

  it("rejects a bogus DKIM d= value (fail closed)", () => {
    const m = parseEmail(msg("DKIM-Signature: v=1; d=not a domain!; b=y", "b"));
    expect(m.dkimDomain).toBeUndefined();
  });

  it("extracts Message-ID / In-Reply-To without angle brackets", () => {
    const m = parseEmail(
      msg(["Message-ID: <abc.123@host>", "In-Reply-To: <prev@host>"].join(CRLF), "b"),
    );
    expect(m.messageId).toBe("abc.123@host");
    expect(m.inReplyTo).toBe("prev@host");
  });
});

describe("parseEmail — address parsing", () => {
  it("parses a quoted display name with a comma", () => {
    const m = parseEmail(msg('From: "Doe, Jane" <jane@example.com>', "b"));
    expect(m.from?.displayName).toBe("Doe, Jane");
    expect(m.from?.address).toBe("jane@example.com");
  });

  it("parses multiple recipients", () => {
    const m = parseEmail(msg("To: a@b.com, c@d.com, e@f.com", "b"));
    expect(m.to.map((x) => x.address)).toEqual(["a@b.com", "c@d.com", "e@f.com"]);
  });

  it("flattens a group syntax address list", () => {
    const m = parseEmail(msg("To: Team: a@b.com, c@d.com;", "b"));
    expect(m.to.map((x) => x.address)).toContain("a@b.com");
    expect(m.to.map((x) => x.address)).toContain("c@d.com");
  });

  it("strips control chars / whitespace out of an address", () => {
    const m = parseEmail(msg("From: <a\x00b@ex\tample.com>", "b"));
    // control-stripped and whitespace-removed
    expect(m.from?.address).not.toMatch(/\s/);
  });

  // --- identity-attribution SPOOF regression (angle-addr inside a quoted phrase) ---
  it("does NOT take an address from inside a quoted display-name (From spoof)", () => {
    // The angle-addr `<victim@bank.com>` is smuggled INSIDE the quoted phrase; the
    // REAL angle-addr is `<attacker@evil.example>`. A naive indexOf("<") would mint
    // the victim's mailbox as the sender identity — a third-party spoof.
    const m = parseEmail(msg('From: "Alice <victim@bank.com>" <attacker@evil.example>', "b"));
    expect(m.from?.address).toBe("attacker@evil.example");
    expect(m.from?.address).not.toBe("victim@bank.com");
    expect(m.from?.displayName).toBe("Alice <victim@bank.com>");
  });

  it("resists the same quoted-phrase smuggle in Reply-To / To / Cc", () => {
    const m = parseEmail(
      msg(
        [
          'From: "Alice <victim@bank.com>" <attacker@evil.example>',
          'Reply-To: "Bob <victim2@bank.com>" <reply@evil.example>',
          'To: "Carol <victim3@bank.com>" <to@evil.example>',
          'Cc: "Dave <victim4@bank.com>" <cc@evil.example>',
        ].join(CRLF),
        "b",
      ),
    );
    expect(m.replyTo[0]?.address).toBe("reply@evil.example");
    expect(m.to[0]?.address).toBe("to@evil.example");
    expect(m.cc[0]?.address).toBe("cc@evil.example");
    for (const a of [m.replyTo[0], m.to[0], m.cc[0]]) {
      expect(a?.address).not.toMatch(/victim/);
    }
  });

  it("treats a `>` inside a quoted display-name as opaque", () => {
    const m = parseEmail(msg('From: "weird > name" <x@y.com>', "b"));
    expect(m.from?.address).toBe("x@y.com");
    expect(m.from?.displayName).toBe("weird > name");
  });

  it("honours an escaped quote inside the display-name (quoted-pair)", () => {
    // The `\"` are quoted-pairs and do NOT end the string, so `<evil@x.com>` stays
    // inside the phrase; the real angle-addr is `<real@c.com>`.
    const m = parseEmail(msg('From: "a\\"<evil@x.com>\\" b" <real@c.com>', "b"));
    expect(m.from?.address).toBe("real@c.com");
    expect(m.from?.address).not.toBe("evil@x.com");
  });

  it("does NOT take an address from inside an RFC 5322 comment (From spoof)", () => {
    // The angle-addr is smuggled into a `(…)` comment; the real one is
    // `<attacker@evil.example>`. A comment-blind scan would mint `victim@bank.com`.
    const m = parseEmail(
      msg("From: Alice (ignored <victim@bank.com>) <attacker@evil.example>", "b"),
    );
    expect(m.from?.address).toBe("attacker@evil.example");
    expect(m.from?.address).not.toBe("victim@bank.com");
  });

  it("resists the comment smuggle in Reply-To / To / Cc (nested + escaped)", () => {
    const m = parseEmail(
      msg(
        [
          "From: Alice (a <victim@bank.com>) <attacker@evil.example>",
          "Reply-To: Bob (b (nested <victim2@bank.com>)) <reply@evil.example>",
          "To: Carol (c <victim3@bank.com>) <to@evil.example>",
          "Cc: Dave (esc \\) <victim4@bank.com>) <cc@evil.example>",
        ].join(CRLF),
        "b",
      ),
    );
    expect(m.from?.address).toBe("attacker@evil.example");
    expect(m.replyTo[0]?.address).toBe("reply@evil.example");
    expect(m.to[0]?.address).toBe("to@evil.example");
    expect(m.cc[0]?.address).toBe("cc@evil.example");
    for (const a of [m.from, m.replyTo[0], m.to[0], m.cc[0]]) {
      expect(a?.address).not.toMatch(/victim/);
    }
  });

  it("does NOT treat a colon inside a comment as a group label (From/To spoof)", () => {
    // A `:` smuggled into a comment must not slice off the phrase (which would let
    // `<victim@bank.com>` become the angle-addr). The real address wins.
    const m = parseEmail(
      msg(
        [
          "From: Alice (note: <victim@bank.com>) <attacker@evil.example>",
          "To: Carol (re: <victim2@bank.com>) <to@evil.example>",
        ].join(CRLF),
        "b",
      ),
    );
    expect(m.from?.address).toBe("attacker@evil.example");
    expect(m.to[0]?.address).toBe("to@evil.example");
    expect(m.from?.address).not.toBe("victim@bank.com");
    expect(m.to[0]?.address).not.toBe("victim2@bank.com");
  });

  it("does NOT split on a comma/semicolon inside a comment (no bogus recipients)", () => {
    const m = parseEmail(msg("To: Alice (one, two; three) <a@b.com>", "b"));
    expect(m.to).toHaveLength(1);
    expect(m.to[0]?.address).toBe("a@b.com");
  });

  it("still honours a legitimate top-level group label + quoted colon", () => {
    // Real group label is stripped; a `:` inside quotes is NOT a label.
    const grp = parseEmail(msg("To: Team: a@b.com, c@d.com;", "b"));
    expect(grp.to.map((x) => x.address)).toEqual(["a@b.com", "c@d.com"]);
    const quoted = parseEmail(msg('From: "Dept: Sales" <s@x.com>', "b"));
    expect(quoted.from?.address).toBe("s@x.com");
    expect(quoted.from?.displayName).toBe("Dept: Sales");
  });
});
