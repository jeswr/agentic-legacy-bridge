// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { Parser } from "n3";
import { describe, expect, it } from "vitest";
import { InMemoryChannelAdapter } from "./channel.js";
import { importInbound } from "./import.js";

const CONTAINER = "https://pod.example/inbox/";
const OWNER = "https://pod.example/profile/card#me";
const NOW = new Date("2026-07-04T00:00:00Z");

interface Put {
  url: string;
  contentType: string;
  body: string;
}

/** A recording mock authed fetch that returns 201 for every PUT. */
function recordingFetch(
  puts: Put[],
  overrides?: (url: string) => Response | undefined,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const ov = overrides?.(url);
    if (ov !== undefined) return ov;
    puts.push({
      url,
      contentType: String((init?.headers as Record<string, string>)?.["content-type"] ?? ""),
      body: typeof init?.body === "string" ? init.body : "<bytes>",
    });
    return new Response(null, { status: 201 });
  }) as typeof globalThis.fetch;
}

const EMAIL = [
  "From: Jane <jane@example.com>",
  "Subject: Project sync",
  "Date: Wed, 08 Jul 2026 09:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "Can we meet at 2026-07-08T14:00:00Z?",
].join("\r\n");

describe("importInbound", () => {
  it("writes the ACL FIRST, then raw + graph + canonical per message", async () => {
    const puts: Put[] = [];
    const adapter = new InMemoryChannelAdapter("email", [{ id: "m1@example.com", raw: EMAIL }]);
    const result = await importInbound({
      adapter,
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
      interpretingAgentWebId: "https://agent.example/#me",
      mandateIri: "https://agent.example/mandate#m",
    });

    expect(result.written).toBe(1);
    expect(result.interpretations).toBeGreaterThan(0);

    // ACL is the FIRST write.
    expect(puts[0]?.url).toBe(`${CONTAINER}.acl`);
    expect(puts[0]?.contentType).toBe("text/turtle");

    const urls = puts.map((p) => p.url);
    expect(urls.some((u) => u.endsWith(".eml"))).toBe(true);
    expect(
      urls.some((u) => u.endsWith(".ttl") && !u.endsWith(".chat.ttl") && !u.endsWith(".acl")),
    ).toBe(true);
    expect(urls.some((u) => u.endsWith(".chat.ttl"))).toBe(true);

    // Every written resource is strictly within the container.
    for (const u of urls) expect(u.startsWith(CONTAINER)).toBe(true);

    // The raw resource is the byte-exact rfc822 anchor.
    const raw = puts.find((p) => p.url.endsWith(".eml"));
    expect(raw?.contentType).toBe("message/rfc822");

    // The agentic graph is valid Turtle and carries the reliability model.
    const graph = puts.find(
      (p) => p.url.endsWith(".ttl") && !p.url.endsWith(".chat.ttl") && !p.url.endsWith(".acl"),
    );
    expect(() => new Parser().parse(graph?.body ?? "")).not.toThrow();
    expect(graph?.body).toContain("agentic:confidence");
    expect(graph?.body).toContain("agentic:RawInboundMessage");
  });

  it("skips an unparseable/over-cap message without aborting the batch", async () => {
    const puts: Put[] = [];
    // A ~31 MiB body → EmailParseError → skipped.
    const huge = `From: a@b.com\r\n\r\n${"x".repeat(31 * 1024 * 1024)}`;
    const adapter = new InMemoryChannelAdapter("email", [
      { id: "big", raw: huge },
      { id: "m1@example.com", raw: EMAIL },
    ]);
    const result = await importInbound({
      adapter,
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      now: NOW,
    });
    expect(result.skipped).toBe(1);
    expect(result.written).toBe(1);
  });

  it("refuses a redirect on a pod write (fail-closed)", async () => {
    const puts: Put[] = [];
    const adapter = new InMemoryChannelAdapter("email", [{ id: "m1@example.com", raw: EMAIL }]);
    await expect(
      importInbound({
        adapter,
        writeFetch: recordingFetch(puts, (url) =>
          url.endsWith(".eml")
            ? new Response(null, { status: 302, headers: { location: "https://evil/" } })
            : undefined,
        ),
        container: CONTAINER,
        ownerWebId: OWNER,
        now: NOW,
      }),
    ).rejects.toThrow(/redirect/i);
  });

  it("throws on a non-2xx pod write", async () => {
    const puts: Put[] = [];
    const adapter = new InMemoryChannelAdapter("email", [{ id: "m1@example.com", raw: EMAIL }]);
    await expect(
      importInbound({
        adapter,
        writeFetch: recordingFetch(puts, (url) =>
          url.endsWith(".acl") ? new Response("no", { status: 403 }) : undefined,
        ),
        container: CONTAINER,
        ownerWebId: OWNER,
      }),
    ).rejects.toThrow(/403/);
  });

  it("rejects an unsafe container (fail-closed)", async () => {
    const adapter = new InMemoryChannelAdapter("email", []);
    await expect(
      importInbound({
        adapter,
        writeFetch: recordingFetch([]),
        container: "https://pod.example/inbox",
        ownerWebId: OWNER,
      }),
    ).rejects.toThrow(/container/);
  });

  it("can skip the ACL write (writeAcl: false)", async () => {
    const puts: Put[] = [];
    const adapter = new InMemoryChannelAdapter("email", [{ id: "m1@example.com", raw: EMAIL }]);
    await importInbound({
      adapter,
      writeFetch: recordingFetch(puts),
      container: CONTAINER,
      ownerWebId: OWNER,
      writeAcl: false,
      now: NOW,
    });
    expect(puts.some((p) => p.url.endsWith(".acl"))).toBe(false);
  });
});
