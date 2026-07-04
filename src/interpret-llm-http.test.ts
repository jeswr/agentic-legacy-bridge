// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it, vi } from "vitest";
import { createHttpLlmExtractor } from "./interpret-llm-http.js";

const ENDPOINT = "https://model.example/v1/chat/completions";
const TASK = {
  task: "meeting-times",
  schema: { type: "object" },
  text: "meet 2026-07-08T14:00:00Z",
  now: "2026-07-04T00:00:00Z",
} as const;

/** A fake fetch that captures the call and returns a canned OpenAI-style completion. */
function fakeFetch(content = '{"items":[]}', init?: { status?: number; redirected?: boolean }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit ?? {} });
    if (init?.redirected || (init?.status !== undefined && init.status >= 300)) {
      return {
        redirected: init?.redirected ?? false,
        status: init?.status ?? 200,
        ok: (init?.status ?? 200) < 300,
      } as unknown as Response;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

describe("createHttpLlmExtractor — request shape + credential discipline", () => {
  it("POSTs a delimited-data chat request; the key rides ONLY the Authorization header", async () => {
    const { fn, calls } = fakeFetch();
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "gpt-x",
      apiKey: "sk-secret",
      fetch: fn,
    });
    const out = await extract(TASK);
    expect(out).toBe('{"items":[]}');

    const { url, init } = calls[0] as { url: string; init: RequestInit };
    expect(url).toBe(ENDPOINT);
    expect(url).not.toContain("sk-secret"); // never in the URL
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-x");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("MESSAGE-DATA");
    expect(body.messages[1].content).toContain("meet 2026-07-08T14:00:00Z");
  });

  it("extra headers can NEVER override Authorization or Content-Type", async () => {
    const { fn, calls } = fakeFetch();
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "m",
      apiKey: "sk-real",
      fetch: fn,
      headers: { authorization: "Bearer sk-EVIL", "content-type": "text/plain", "x-extra": "ok" },
    });
    await extract(TASK);
    const headers = (calls[0] as { init: RequestInit }).init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-real");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-extra"]).toBe("ok");
  });
});

describe("createHttpLlmExtractor — transport hardening", () => {
  it("refuses a non-https endpoint at construction", () => {
    expect(() =>
      createHttpLlmExtractor({ endpoint: "http://model.example/v1", model: "m" }),
    ).toThrow(/https/);
  });

  it("permits an http LOOPBACK endpoint only under allowLocalModelEndpoint", async () => {
    const { fn } = fakeFetch();
    expect(() =>
      createHttpLlmExtractor({
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "m",
        allowLocalModelEndpoint: true,
        fetch: fn,
      }),
    ).not.toThrow();
    // A NON-loopback http endpoint is still refused even with the flag.
    expect(() =>
      createHttpLlmExtractor({
        endpoint: "http://evil.example/v1",
        model: "m",
        allowLocalModelEndpoint: true,
        fetch: fn,
      }),
    ).toThrow(/https/);
  });

  it("refuses a redirect (a 3xx would leak the Authorization header)", async () => {
    const { fn } = fakeFetch("", { status: 302 });
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "m",
      apiKey: "sk",
      fetch: fn,
    });
    await expect(extract(TASK)).rejects.toThrow(/redirect/);
  });

  it("refuses a followed redirect (response.redirected)", async () => {
    const { fn } = fakeFetch("", { redirected: true });
    const extract = createHttpLlmExtractor({ endpoint: ENDPOINT, model: "m", fetch: fn });
    await expect(extract(TASK)).rejects.toThrow(/redirect/);
  });

  it("throws on a non-ok status without leaking the key or the body", async () => {
    const { fn } = fakeFetch("", { status: 500 });
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "m",
      apiKey: "sk-secret",
      fetch: fn,
    });
    await expect(extract(TASK)).rejects.toThrow(/HTTP 500/);
    await expect(extract(TASK)).rejects.not.toThrow(/sk-secret/);
  });

  it("enforces a response byte cap", async () => {
    const big = "x".repeat(5000);
    const { fn } = fakeFetch(big);
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "m",
      fetch: fn,
      maxResponseBytes: 100,
    });
    await expect(extract(TASK)).rejects.toThrow(/byte cap/);
  });

  it("throws a shape error (never crashes) on a malformed completion", async () => {
    const fn = vi.fn(
      async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const extract = createHttpLlmExtractor({ endpoint: ENDPOINT, model: "m", fetch: fn });
    await expect(extract(TASK)).rejects.toThrow(/choices|shape|content/);
  });

  it("keeps the timeout armed through the BODY read (a hung body stream still times out)", async () => {
    // Headers arrive fast, then the body stream hangs — the abort timer must remain
    // armed until the body is fully consumed, else this would hang forever.
    const fn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new Error("aborted body")),
          );
          // never enqueue or close → the body hangs until the abort fires
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "m",
      fetch: fn,
      timeoutMs: 15,
    });
    await expect(extract(TASK)).rejects.toThrow();
  });

  it("bounds a hanging request by the timeout (AbortSignal fires)", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof globalThis.fetch;
    const extract = createHttpLlmExtractor({
      endpoint: ENDPOINT,
      model: "m",
      fetch: hang,
      timeoutMs: 15,
    });
    await expect(extract(TASK)).rejects.toThrow(/request failed/);
  });
});
