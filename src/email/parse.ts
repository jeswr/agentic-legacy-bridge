// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * A minimal, HOSTILE-INPUT-HARDENED RFC 5322 / MIME parser.
 *
 * The ENTIRE input is untrusted. The design goals, in priority order:
 *  1. **Never crash / never hang.** Every cap is explicit; every decode is
 *     try/caught; no regex has super-linear backtracking on attacker input. The
 *     ONLY throw is {@link EmailParseError} for a message that exceeds the hard
 *     input cap — a controlled, typed, fail-closed refusal (callers can catch it).
 *     Everything else degrades: a malformed part is dropped, a bad encoding falls
 *     back, a cap-exceeding structure is truncated — each with a `warnings` entry.
 *  2. **No header injection.** Header VALUES are unfolded and control-stripped, so
 *     a `\r\n`-carrying value can never split into a second header downstream.
 *  3. **No stored XSS.** HTML is never surfaced as HTML — the body is always plain
 *     text (a text/plain part preferred; text/html tag-stripped as a last resort).
 *  4. **Byte-faithful structure, charset-correct leaves.** Structure is parsed in a
 *     byte-preserving `latin1` view (1 char = 1 byte), so a leaf part's original
 *     bytes are recoverable and decoded with ITS declared charset.
 *
 * This is an EMAIL parser (explicitly allowed to be in-house — the RDF house rule
 * bans only bespoke *RDF* parsers). It is intentionally small: envelope headers +
 * one plain-text body, not a faithful MIME object model.
 */

import { createHash } from "node:crypto";
import { sanitizeText } from "../safe-iri.js";
import type { EmailAddress, EmailMessage } from "./types.js";

/**
 * Force a header-DERIVED value onto a single line: strip C0/C1 controls (via
 * {@link sanitizeText}) THEN collapse the remaining CR/LF/TAB whitespace to single
 * spaces. Load-bearing for subjects and display names: an RFC-2047 encoded-word can
 * DECODE to text containing CR/LF (which `sanitizeText` deliberately keeps for
 * bodies), and such a value must never carry a line break downstream — otherwise it
 * could be re-emitted into an outbound header and split it (header injection). Only
 * BODY text keeps its newlines; every header-derived string goes through this.
 */
function oneLine(value: string): string {
  return sanitizeText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// --- hard caps (fail-closed) -------------------------------------------------
/** Hard cap on the whole input; over this throws {@link EmailParseError}. */
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
/** Cap on the header block scanned for the header/body separator. */
const MAX_HEADER_BLOCK_BYTES = 1 * 1024 * 1024;
/** Cap on the number of headers kept. */
const MAX_HEADERS = 512;
/** Cap on a single (unfolded) header value length. */
const MAX_HEADER_VALUE_CHARS = 64 * 1024;
/** Cap on MIME parts visited across the whole tree. */
const MAX_PARTS = 256;
/** Cap on multipart nesting depth. */
const MAX_MIME_DEPTH = 12;
/** Cap on the retained plain-text body length. */
const MAX_TEXT_BODY_CHARS = 512 * 1024;
/** Cap on addresses parsed from one address header. */
const MAX_ADDRESSES = 256;
/** Cap on decoded content bytes per leaf part (post-CTE). */
const MAX_PART_BYTES = 8 * 1024 * 1024;

/** A controlled, typed, fail-closed refusal (the only throw from {@link parseEmail}). */
export class EmailParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailParseError";
  }
}

/** A bounded warnings collector (so a pathological input cannot grow it without limit). */
class Warnings {
  private readonly list: string[] = [];
  private static readonly MAX = 64;
  add(msg: string): void {
    if (this.list.length < Warnings.MAX) this.list.push(msg);
    else if (this.list.length === Warnings.MAX) this.list.push("…further warnings suppressed");
  }
  values(): string[] {
    return this.list;
  }
}

/** Normalise the input to a Buffer, enforcing the hard byte cap. */
function toBuffer(input: string | Uint8Array): Buffer {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (buf.length > MAX_MESSAGE_BYTES) {
    throw new EmailParseError(
      `email exceeds the ${MAX_MESSAGE_BYTES}-byte hard cap (${buf.length} bytes).`,
    );
  }
  return buf;
}

/**
 * Split off the header block from the body: find the FIRST blank line
 * (`\r\n\r\n` or `\n\n`) within the header-block cap. Returns the raw header text
 * and the raw body text (both latin1). If no separator is found within the cap, the
 * whole (capped) input is treated as headers with an empty body.
 */
function splitHeaderBody(rawLatin1: string, w: Warnings): { headerText: string; body: string } {
  const scanLimit = Math.min(rawLatin1.length, MAX_HEADER_BLOCK_BYTES);
  // Look for CRLFCRLF first, then LFLF, within the scan window.
  let sepIndex = -1;
  let sepLen = 0;
  const crlf = rawLatin1.indexOf("\r\n\r\n");
  if (crlf !== -1 && crlf < scanLimit) {
    sepIndex = crlf;
    sepLen = 4;
  }
  const lf = rawLatin1.indexOf("\n\n");
  if (lf !== -1 && lf < scanLimit && (sepIndex === -1 || lf < sepIndex)) {
    sepIndex = lf;
    sepLen = 2;
  }
  if (sepIndex === -1) {
    if (rawLatin1.length > MAX_HEADER_BLOCK_BYTES) {
      w.add("no header/body separator within the header-block cap; body treated as empty.");
    }
    return { headerText: rawLatin1.slice(0, scanLimit), body: "" };
  }
  return { headerText: rawLatin1.slice(0, sepIndex), body: rawLatin1.slice(sepIndex + sepLen) };
}

/**
 * Unfold + parse a header block into `[lower-name, value]` pairs. Unfolding removes
 * the CRLF of a folding whitespace continuation (a line starting with SP/HTAB is a
 * continuation of the previous header). Values are control-stripped so no `\r`/`\n`
 * survives into a value (the header-injection guard). Malformed lines are skipped.
 */
function parseHeaders(headerText: string, w: Warnings): Array<[string, string]> {
  // Normalise line endings to \n for splitting; the separator search already handled both.
  const lines = headerText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const headers: Array<[string, string]> = [];
  let current: { name: string; value: string } | undefined;
  const flush = () => {
    if (current === undefined) return;
    if (headers.length >= MAX_HEADERS) {
      w.add(`more than ${MAX_HEADERS} headers; extra headers dropped.`);
      current = undefined;
      return;
    }
    // Control-strip the value (drops any stray CR/LF/other C0 — the injection guard),
    // collapse the folding whitespace to single spaces, and cap the length.
    let value = sanitizeText(current.value)
      .replace(/[\t ]+/g, " ")
      .trim();
    if (value.length > MAX_HEADER_VALUE_CHARS) {
      value = value.slice(0, MAX_HEADER_VALUE_CHARS);
      w.add(`header "${current.name}" value truncated at the length cap.`);
    }
    headers.push([current.name, value]);
    current = undefined;
  };
  for (const line of lines) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && current !== undefined) {
      // Folding-whitespace continuation of the current header.
      current.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      // Not a valid "name: value" line and not a continuation — skip it.
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    // A header name is printable ASCII with no whitespace/control; reject otherwise.
    if (!/^[!-9;-~]+$/.test(name)) {
      continue;
    }
    flush();
    current = { name, value: line.slice(colon + 1).trimStart() };
    if (headers.length >= MAX_HEADERS) {
      // Stop accumulating once at the cap (flush() will drop, but avoid unbounded work).
      break;
    }
  }
  flush();
  return headers;
}

/** First header value (case-insensitive), or undefined. */
function headerValue(
  headers: ReadonlyArray<readonly [string, string]>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [n, v] of headers) if (n === lower) return v;
  return undefined;
}

// --- RFC 2047 encoded-word decoding -----------------------------------------
/**
 * Decode RFC 2047 encoded-words (`=?charset?B?…?=` / `=?charset?Q?…?=`) in a header
 * value. Adjacent encoded-words separated only by whitespace are concatenated with
 * the whitespace removed (per RFC 2047 §6.2). Malformed words are left literal.
 */
function decodeRfc2047(input: string): string {
  // Match encoded-word tokens without backtracking risk: fixed structure, the
  // charset/encoding are short tokens and the text excludes `?` and whitespace.
  const Token = /=\?([^?\s]{1,64})\?([bBqQ])\?([^?\s]{0,4096})\?=/g;
  let out = "";
  let last = 0;
  let prevWasEncoded = false;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
  while ((m = Token.exec(input)) !== null) {
    const between = input.slice(last, m.index);
    // Whitespace-only gap between two encoded-words is dropped.
    if (!(prevWasEncoded && between.trim() === "")) out += between;
    const [, charset, enc, text] = m;
    out += decodeEncodedWord(charset ?? "", enc ?? "", text ?? "");
    last = m.index + m[0].length;
    prevWasEncoded = true;
  }
  out += input.slice(last);
  return out;
}

/** Decode one encoded-word's text; on any failure return the literal `=?...?=`. */
function decodeEncodedWord(charset: string, enc: string, text: string): string {
  try {
    let bytes: Buffer;
    if (enc.toLowerCase() === "b") {
      bytes = base64ToBytes(text);
    } else {
      // Q-encoding: `_` = space, `=XX` = hex byte, everything else literal.
      bytes = qDecode(text);
    }
    return decodeCharset(bytes, charset);
  } catch {
    return `=?${charset}?${enc}?${text}?=`;
  }
}

/** Q-encoding decode (RFC 2047 §4.2) → bytes. */
function qDecode(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "_") {
      out.push(0x20);
    } else if (c === "=" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      const code = Number.parseInt(hex, 16);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(code);
        i += 2;
      } else {
        out.push(0x3d); // literal '='
      }
    } else {
      out.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(out);
}

// --- content-transfer-encoding + charset ------------------------------------
/** Strip to the base64 alphabet then decode to bytes (lenient; never throws). */
function base64ToBytes(s: string): Buffer {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  return Buffer.from(clean, "base64");
}

/** Quoted-printable decode (RFC 2045 §6.7) → bytes. Malformed `=XX` kept literal. */
function qpToBytes(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "=") {
      // Soft line break: `=\r\n` or `=\n` — the `=` and the line ending vanish.
      if (s[i + 1] === "\r" && s[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (s[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const next2 = s.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(next2)) {
        out.push(Number.parseInt(next2, 16));
        i += 2;
        continue;
      }
      out.push(0x3d); // stray '=' kept literal
      continue;
    }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/**
 * Decode content bytes using a declared charset, with a robust fallback chain:
 * declared → utf-8 → latin1. Never throws (a decode error falls back).
 */
function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = normalizeCharset(charset);
  const attempts = [label, "utf-8", "latin1"];
  for (const enc of attempts) {
    if (enc === undefined) continue;
    try {
      return new TextDecoder(enc, { fatal: false }).decode(bytes);
    } catch {
      // unknown label — try the next fallback
    }
  }
  return bytes.toString("latin1");
}

/** Normalise a charset label; map a few common aliases; undefined → default later. */
function normalizeCharset(charset: string | undefined): string | undefined {
  if (charset === undefined) return "utf-8";
  const c = charset.trim().toLowerCase().replace(/^"|"$/g, "");
  if (c === "" || c === "us-ascii" || c === "ascii") return "utf-8";
  if (c === "latin1" || c === "iso8859-1") return "iso-8859-1";
  return c;
}

// --- content-type parsing ----------------------------------------------------
interface ContentType {
  readonly type: string; // lower-cased `type/subtype`
  readonly params: Readonly<Record<string, string>>;
}

/** Parse a Content-Type header value into `{ type, params }` (tolerant). */
function parseContentType(value: string | undefined): ContentType {
  if (value === undefined) return { type: "text/plain", params: {} };
  const semi = value.indexOf(";");
  const type = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  const params: Record<string, string> = {};
  if (semi !== -1) {
    // Split params on `;` — good enough for the boundary/charset we need; quoted
    // values may contain `;` but that is rare and we bound the work regardless.
    const rest = value.slice(semi + 1);
    for (const seg of rest.split(";").slice(0, 32)) {
      const eq = seg.indexOf("=");
      if (eq === -1) continue;
      const k = seg.slice(0, eq).trim().toLowerCase();
      let v = seg.slice(eq + 1).trim();
      if (v.startsWith('"')) v = v.slice(1, v.endsWith('"') ? -1 : undefined);
      if (k.length > 0 && k.length < 128) params[k] = v;
    }
  }
  return { type: type === "" ? "text/plain" : type, params };
}

// --- body extraction (recursive, depth- + count-limited) --------------------
interface PartCtx {
  parts: number;
  w: Warnings;
}

/**
 * Extract the best plain-text body from a MIME entity (recursive). Prefers a
 * text/plain leaf anywhere in the tree; falls back to a tag-stripped text/html leaf
 * ONLY if no text/plain exists (HTML is never surfaced as HTML). Returns the decoded
 * text (or "" if none), respecting the part/depth/byte caps.
 */
function extractText(
  bodyLatin1: string,
  contentTypeValue: string | undefined,
  cteValue: string | undefined,
  depth: number,
  ctx: PartCtx,
): { plain?: string; html?: string } {
  if (ctx.parts >= MAX_PARTS || depth > MAX_MIME_DEPTH) {
    if (depth > MAX_MIME_DEPTH) ctx.w.add("MIME nesting depth cap hit; deeper parts ignored.");
    return {};
  }
  ctx.parts++;
  const ct = parseContentType(contentTypeValue);

  if (ct.type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (boundary === undefined || boundary === "") {
      ctx.w.add("multipart without a boundary; treated as opaque.");
      return {};
    }
    let plain: string | undefined;
    let html: string | undefined;
    for (const partRaw of splitMultipart(bodyLatin1, boundary)) {
      if (ctx.parts >= MAX_PARTS) {
        ctx.w.add(`more than ${MAX_PARTS} MIME parts; remaining parts ignored.`);
        break;
      }
      const { headerText, body } = splitHeaderBody(partRaw, ctx.w);
      const partHeaders = parseHeaders(headerText, ctx.w);
      const childCt = headerValue(partHeaders, "content-type");
      const childCte = headerValue(partHeaders, "content-transfer-encoding");
      const got = extractText(body, childCt, childCte, depth + 1, ctx);
      if (plain === undefined && got.plain !== undefined) plain = got.plain;
      if (html === undefined && got.html !== undefined) html = got.html;
      // A text/plain anywhere wins; stop scanning once we have it.
      if (plain !== undefined) break;
    }
    return { ...(plain !== undefined ? { plain } : {}), ...(html !== undefined ? { html } : {}) };
  }

  // Leaf part. Decode CTE → bytes → charset.
  const cte = (cteValue ?? "7bit").trim().toLowerCase();
  let bytes: Buffer;
  const partBytesLatin1 = Buffer.from(bodyLatin1, "latin1");
  if (cte === "base64") bytes = base64ToBytes(bodyLatin1);
  else if (cte === "quoted-printable") bytes = qpToBytes(bodyLatin1);
  else bytes = partBytesLatin1; // 7bit / 8bit / binary / unknown
  if (bytes.length > MAX_PART_BYTES) {
    bytes = bytes.subarray(0, MAX_PART_BYTES);
    ctx.w.add("part exceeded the byte cap and was truncated.");
  }
  const text = decodeCharset(bytes, ct.params.charset);

  if (ct.type === "text/plain" || ct.type === "text" || ct.type === "") {
    return { plain: text };
  }
  if (ct.type === "text/html") {
    return { html: text };
  }
  // Any other leaf (image, application/*, …) contributes no text body.
  return {};
}

/**
 * Split a multipart body on its boundary. Returns each part's raw content (between
 * `--boundary` delimiter lines), dropping the preamble and epilogue. Tolerant of
 * CRLF/LF and trailing whitespace on the delimiter line. Bounded by MAX_PARTS.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  // Normalise to \n for splitting; delimiter lines are compared loosely.
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let currentLines: string[] | undefined;
  for (const line of lines) {
    const trimmedRight = line.replace(/[\t ]+$/, "");
    if (trimmedRight === delim || trimmedRight === `${delim}--`) {
      if (currentLines !== undefined) {
        parts.push(currentLines.join("\n"));
        if (parts.length >= MAX_PARTS) break;
      }
      currentLines = trimmedRight === `${delim}--` ? undefined : [];
      continue;
    }
    if (currentLines !== undefined) currentLines.push(line);
  }
  // An unterminated final part (no closing `--boundary--`) is still captured.
  if (currentLines !== undefined && currentLines.length > 0 && parts.length < MAX_PARTS) {
    parts.push(currentLines.join("\n"));
  }
  return parts;
}

/**
 * Best-effort strip of HTML to plain text — remove tags and decode a handful of
 * named entities. NOT a sanitiser (we never re-emit HTML); this only derives a
 * readable text body when the message has no text/plain part. Linear, no
 * backtracking regex on the tag scan.
 */
function htmlToText(html: string): string {
  // Drop script/style CONTENT entirely, then strip remaining tags.
  const noScript = html
    .replace(/<script[\s\S]{0,100000}?<\/script>/gi, " ")
    .replace(/<style[\s\S]{0,100000}?<\/style>/gi, " ");
  const noTags = noScript.replace(/<[^>]{0,8192}>/g, " ");
  return noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

// --- address parsing ---------------------------------------------------------
/**
 * Parse an address-list header value into {@link EmailAddress}es (tolerant, capped).
 * Splits on top-level commas (not inside quotes/angles), extracts the angle-addr or
 * the bare addr, and decodes+sanitises the display phrase. Group syntax
 * (`Name: a, b;`) is flattened by stripping a leading `phrase:` and trailing `;`.
 */
function parseAddressList(value: string | undefined): EmailAddress[] {
  if (value === undefined || value.trim() === "") return [];
  const out: EmailAddress[] = [];
  for (const token of splitTopLevelCommas(value)) {
    if (out.length >= MAX_ADDRESSES) break;
    const addr = parseOneAddress(token);
    if (addr !== undefined) out.push(addr);
  }
  return out;
}

/** Split on commas that are not inside a `"…"` quote or a `<…>` angle-addr. */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < value.length && parts.length < MAX_ADDRESSES + 1; i++) {
    const c = value[i] as string;
    if (c === '"' && !inAngle) inQuote = !inQuote;
    else if (c === "<" && !inQuote) inAngle = true;
    else if (c === ">" && !inQuote) inAngle = false;
    else if ((c === "," || c === ";") && !inQuote && !inAngle) {
      parts.push(buf);
      buf = "";
      continue;
    }
    // Drop a group-label `:` at top level by ignoring everything up to it handled below.
    buf += c;
  }
  if (buf.trim() !== "") parts.push(buf);
  return parts;
}

/** Parse a single address token → {@link EmailAddress}, or undefined if empty. */
function parseOneAddress(token: string): EmailAddress | undefined {
  let t = token.trim();
  if (t === "") return undefined;
  // Strip a leading group label `phrase:` (but NOT the `:` inside a `<...>`).
  const angleOpen = t.indexOf("<");
  const colon = t.indexOf(":");
  if (colon !== -1 && (angleOpen === -1 || colon < angleOpen) && !t.slice(0, colon).includes('"')) {
    // Heuristic: a top-level `:` before any `<` is a group label; drop it.
    t = t.slice(colon + 1).trim();
  }
  let address: string;
  let displayName: string | undefined;
  const lt = t.indexOf("<");
  const gt = t.indexOf(">", lt + 1);
  if (lt !== -1 && gt !== -1) {
    address = t.slice(lt + 1, gt).trim();
    const phrase = t.slice(0, lt).trim();
    if (phrase !== "") displayName = cleanPhrase(phrase);
  } else {
    address = t.trim();
  }
  address = sanitizeText(address).replace(/[\s]/g, "");
  if (address === "") {
    if (displayName === undefined) return undefined;
    return { address: "", displayName };
  }
  return displayName === undefined ? { address } : { address, displayName };
}

/** Decode + dequote + sanitise a display phrase. */
function cleanPhrase(phrase: string): string {
  let p = phrase.trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = p.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return oneLine(decodeRfc2047(p));
}

// --- DKIM domain -------------------------------------------------------------
/** Extract the CLAIMED (unverified) DKIM `d=` domain, if present + plausible. */
function extractDkimDomain(headers: ReadonlyArray<readonly [string, string]>): string | undefined {
  const sig = headerValue(headers, "dkim-signature");
  if (sig === undefined) return undefined;
  const m = /(?:^|;)\s*d=([^;]{1,255})/.exec(sig);
  if (m === null) return undefined;
  const domain = (m[1] ?? "").trim().toLowerCase();
  // A DKIM d= is a domain: LDH labels. Reject anything else (fail closed).
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return undefined;
  }
  return domain;
}

// --- the public entry point --------------------------------------------------
/**
 * Parse raw email bytes/text into an {@link EmailMessage}. Fail-closed + never
 * hangs; the only throw is {@link EmailParseError} when the input exceeds the hard
 * byte cap. All other malformations degrade with a `warnings` entry.
 */
export function parseEmail(input: string | Uint8Array): EmailMessage {
  const buf = toBuffer(input);
  const w = new Warnings();
  const rawSha256 = createHash("sha256").update(buf).digest("hex");
  const rawLatin1 = buf.toString("latin1");

  const { headerText, body } = splitHeaderBody(rawLatin1, w);
  const headers = parseHeaders(headerText, w);

  const ctx: PartCtx = { parts: 0, w };
  const extracted = extractText(
    body,
    headerValue(headers, "content-type"),
    headerValue(headers, "content-transfer-encoding"),
    0,
    ctx,
  );
  let textBody: string;
  if (extracted.plain !== undefined) {
    textBody = extracted.plain;
  } else if (extracted.html !== undefined) {
    textBody = htmlToText(extracted.html);
    w.add("no text/plain part; derived plain text from text/html (HTML never persisted).");
  } else {
    textBody = "";
  }
  textBody = sanitizeText(textBody);
  if (textBody.length > MAX_TEXT_BODY_CHARS) {
    textBody = textBody.slice(0, MAX_TEXT_BODY_CHARS);
    w.add("text body truncated at the length cap.");
  }

  const fromList = parseAddressList(headerValue(headers, "from"));
  const subjectRaw = headerValue(headers, "subject");
  const subject = subjectRaw === undefined ? undefined : oneLine(decodeRfc2047(subjectRaw));
  const date = parseDate(headerValue(headers, "date"));
  const messageId = extractMsgId(headerValue(headers, "message-id"));
  const inReplyTo = extractMsgId(headerValue(headers, "in-reply-to"));
  const dkimDomain = extractDkimDomain(headers);

  const message: EmailMessage = {
    ...(fromList[0] !== undefined ? { from: fromList[0] } : {}),
    to: parseAddressList(headerValue(headers, "to")),
    cc: parseAddressList(headerValue(headers, "cc")),
    replyTo: parseAddressList(headerValue(headers, "reply-to")),
    ...(subject !== undefined && subject !== "" ? { subject } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(dkimDomain !== undefined ? { dkimDomain } : {}),
    textBody,
    headers,
    rawSha256,
    rawByteLength: buf.length,
    warnings: w.values(),
  };
  return message;
}

/** Parse a Date header to ISO-8601, or undefined if unparseable. */
function parseDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Extract a Message-ID token: the content of the FIRST `<...>` if present, else the
 * whole trimmed value. Control-stripped + whitespace-free; empty → undefined. This
 * is an EMAIL token, NOT an http IRI — callers never treat it as one.
 */
function extractMsgId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const lt = value.indexOf("<");
  const gt = value.indexOf(">", lt + 1);
  const inner = lt !== -1 && gt !== -1 ? value.slice(lt + 1, gt) : value;
  const id = sanitizeText(inner).replace(/\s/g, "").trim();
  return id === "" ? undefined : id.slice(0, 998);
}
