/**
 * Unit tests with fetch stubbed out — no services needed, so these run in CI.
 *
 * They assert two things the integration tests cannot cheaply reach: exactly what the
 * client puts on the wire, and how it maps responses back to typed errors.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CraterView, CraterViewError, JobFailed, RateLimited, newIdempotencyKey,
} from "../index";

interface Call { url: string; init: RequestInit }

/**
 * A scripted response. Deliberately not `Partial<Response>`: the real Response.body is a
 * ReadableStream, so reusing that name against a plain object is a type error — which is
 * exactly what tsc caught here.
 */
interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Replace global fetch with a scripted queue of responses, recording every call. */
function stubFetch(responses: ResponseSpec[]) {
  const calls: Call[] = [];
  let index = 0;

  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(index++, responses.length - 1)]!;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(spec.headers ?? {}),
      json: async () => spec.body,
      blob: async () => new Blob([JSON.stringify(spec.body ?? {})]),
    } as unknown as Response;
  });

  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = (apiKey?: string) =>
  new CraterView({ apiKey, baseUrl: "http://gateway.test" });

describe("request construction", () => {
  it("sends the API key as a bearer token", async () => {
    const calls = stubFetch([{ body: [] }]);
    await client("cv_secret").models();
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"])
      .toBe("Bearer cv_secret");
  });

  it("omits the header entirely when unauthenticated", async () => {
    const calls = stubFetch([{ body: [] }]);
    await client().models();
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"])
      .toBeUndefined();
  });

  it("sends Idempotency-Key when given one", async () => {
    const calls = stubFetch([{ body: { id: "job_1", model: "m", status: "queued" } }]);
    await client("k").submit("inputs/x", { idempotencyKey: "abc-123" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"])
      .toBe("abc-123");
  });

  it("passes model parameters through in params, not at the top level", async () => {
    const calls = stubFetch([{ body: { id: "job_1", model: "m", status: "queued" } }]);
    await client("k").submit("inputs/x", { style: "photo", scale: 2, wait: 5 });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.params).toEqual({ style: "photo", scale: 2 });
    expect(body.input_key).toBe("inputs/x");
    // wait is a query parameter, not a model parameter — sending it in params would be
    // rejected by additionalProperties: false.
    expect(body.params.wait).toBeUndefined();
    expect(calls[0]!.url).toContain("wait=5");
  });

  it("uses snake_case on the wire for webhook_url", async () => {
    const calls = stubFetch([{ body: { id: "job_1", model: "m", status: "queued" } }]);
    await client("k").submit("inputs/x", { webhookUrl: "https://example.com/hook" });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.webhook_url).toBe("https://example.com/hook");
    expect(body.webhookUrl).toBeUndefined();
  });

  it("strips a trailing slash from baseUrl", async () => {
    const calls = stubFetch([{ body: [] }]);
    await new CraterView({ baseUrl: "http://gateway.test/" }).models();
    expect(calls[0]!.url).toBe("http://gateway.test/v1/models");
  });
});

describe("error mapping", () => {
  it("maps 429 to RateLimited and parses Retry-After", async () => {
    stubFetch([{ status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "42" } }]);
    await expect(client("k").models()).rejects.toMatchObject({
      name: "RateLimited", retryAfter: 42, status: 429,
    });
  });

  it("maps a 402 from an older gateway to the base error", async () => {
    // Nothing is refused for want of credit, so this client declares no type for it. A
    // caller pointed at a deployment that does refuse must still get something catchable.
    stubFetch([{ status: 402, body: { detail: "quota exhausted" } }]);
    await expect(client("k").models()).rejects.toMatchObject({
      name: "CraterViewError", status: 402,
    });
  });

  it("surfaces the server's detail rather than a bare status", async () => {
    stubFetch([{ status: 422, body: { detail: "'sketch' is not one of ['photo']" } }]);
    await expect(client("k").models()).rejects.toThrow("'sketch' is not one of ['photo']");
  });

  it("does not throw on a malformed error body", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false, status: 500, headers: new Headers(),
      json: async () => { throw new SyntaxError("not json"); },
    } as unknown as Response));
    await expect(client("k").models()).rejects.toThrow("HTTP 500");
  });

  it("keeps instanceof working across the error hierarchy", async () => {
    // Subclassing built-in Error breaks instanceof under an ES5 target, which would make
    // every `catch (e) { if (e instanceof RateLimited) }` silently fail. Asserted here so
    // a future tsconfig change cannot quietly reintroduce it.
    stubFetch([{ status: 429, body: { detail: "x" } }]);
    const error = await client("k").models().catch((e) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect(error).toBeInstanceOf(CraterViewError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("pagination", () => {
  it("follows next_before across pages", async () => {
    const calls = stubFetch([
      { body: { data: [{ id: "a", model: "m", status: "succeeded" }], has_more: true, next_before: "a" } },
      { body: { data: [{ id: "b", model: "m", status: "succeeded" }], has_more: false } },
    ]);
    const ids: string[] = [];
    for await (const job of client("k").jobs({ limit: 1 })) ids.push(job.id);

    expect(ids).toEqual(["a", "b"]);
    expect(calls[1]!.url).toContain("before=a");
  });

  it("terminates when has_more is true but next_before is missing", async () => {
    // A server that says "more" without a cursor would otherwise spin forever.
    stubFetch([{ body: { data: [{ id: "a", model: "m", status: "succeeded" }], has_more: true } }]);
    const ids: string[] = [];
    for await (const job of client("k").jobs()) ids.push(job.id);
    expect(ids).toEqual(["a"]);
  });

  it("stops immediately on an empty first page", async () => {
    stubFetch([{ body: { data: [], has_more: false } }]);
    const ids: string[] = [];
    for await (const job of client("k").jobs()) ids.push(job.id);
    expect(ids).toEqual([]);
  });

  it("passes the status filter through", async () => {
    const calls = stubFetch([{ body: { data: [], has_more: false } }]);
    for await (const _ of client("k").jobs({ status: "failed" })) { /* drain */ }
    expect(calls[0]!.url).toContain("status=failed");
  });
});

describe("job", () => {
  const job = (over: Record<string, unknown> = {}) =>
    ({ id: "job_1", model: "cv-restore-v1", status: "succeeded", ...over });

  it("exposes status predicates", async () => {
    stubFetch([{ body: job({ status: "queued" }) }]);
    const queued = await client("k").job("job_1");
    expect(queued.done).toBe(false);
    expect(queued.succeeded).toBe(false);

    stubFetch([{ body: job({ status: "failed", error: "bad input" }) }]);
    const failed = await client("k").job("job_1");
    expect(failed.done).toBe(true);
    expect(failed.succeeded).toBe(false);
    expect(failed.error).toBe("bad input");
  });

  it("refuses to download a result that does not exist", async () => {
    stubFetch([{ body: job({ status: "failed", output_url: null }) }]);
    const failed = await client("k").job("job_1");
    await expect(failed.blob()).rejects.toBeInstanceOf(CraterViewError);
  });

  it("exposes the wait a queued job is in", async () => {
    stubFetch([{ body: job({ status: "queued", community: true, eta_seconds: 42 }) }]);
    const queued = await client("k").job("job_1");
    expect(queued.community).toBe(true);
    expect(queued.etaSeconds).toBe(42);
  });

  it("treats an omitted community flag as paid work", async () => {
    // A gateway with no community queue omits the flag, and its jobs are paid work.
    // Null here would be a third state that means nothing to a caller.
    stubFetch([{ body: job({ status: "queued" }) }]);
    const queued = await client("k").job("job_1");
    expect(queued.community).toBe(false);
  });
});

describe("run", () => {
  it("uploads, submits and returns a settled job in one call", async () => {
    const calls = stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },  // the PUT to object storage
      { body: { id: "job_1", model: "cv-restore-v1", status: "succeeded", output_url: "http://x" } },
    ]);

    const job = await client("k").run(new Blob(["x"], { type: "image/png" }),
                                          { style: "photo" });
    expect(job.succeeded).toBe(true);
    // The image must go straight to storage, never through the API.
    expect(calls[1]!.url).toBe("http://storage.test/put");
    expect(calls[1]!.init.method).toBe("PUT");

    // And the length is declared from the Blob the PUT sends, because it is signed into the
    // URL — a client that declared a different figure would have its own upload refused by
    // storage with a signature error.
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      content_type: "image/png", content_length: 1,
    });
  });

  it("throws JobFailed rather than returning a failed job", async () => {
    stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },
      { body: { id: "job_1", model: "m", status: "failed", error: "alpha not supported",
                error_code: "face_enhance_alpha_unsupported" } },
    ]);
    const failure = await client("k").run(new Blob(["x"])).catch((e) => e);
    expect(failure).toBeInstanceOf(JobFailed);
    expect(failure.message).toBe("alpha not supported");
    // The half a client branches on. `run()` is the ergonomic path and the one the README
    // leads with, so a caller taking it must not be left matching on prose.
    expect(failure.errorCode).toBe("face_enhance_alpha_unsupported");
  });

  it("accepts a Uint8Array as well as a Blob", async () => {
    stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },
      { body: { id: "job_1", model: "m", status: "succeeded" } },
    ]);
    const job = await client("k").run(new Uint8Array([1, 2, 3]), { style: "photo" });
    expect(job.succeeded).toBe(true);
  });
});

describe("pagination cannot run away", () => {
  // Explicit short timeouts: the failure mode for these is an infinite loop, and a test
  // that hangs is far worse in CI than one that fails.
  it("stops when the cursor does not advance", { timeout: 5000 }, async () => {
    stubFetch([{ body: { data: [{ id: "a", model: "m", status: "succeeded" }],
                         has_more: true, next_before: "same" } }]);
    const ids: string[] = [];
    for await (const job of client("k").jobs()) ids.push(job.id);
    expect(ids.length).toBeLessThan(5);
  });

  it("stops when has_more is true but no cursor is given", { timeout: 5000 }, async () => {
    stubFetch([{ body: { data: [{ id: "a", model: "m", status: "succeeded" }], has_more: true } }]);
    const ids: string[] = [];
    for await (const job of client("k").jobs()) ids.push(job.id);
    expect(ids).toEqual(["a"]);
  });
});

describe("newIdempotencyKey", () => {
  it("is unique across calls", () => {
    const keys = new Set(Array.from({ length: 500 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(500);
  });

  it("is safe to put in a header", () => {
    const key = newIdempotencyKey();
    // No whitespace, no control characters, no separators that would need quoting.
    expect(key).toMatch(/^idem_[A-Za-z0-9_-]+$/);
    expect(key.length).toBeGreaterThan(16);
  });

  it("round-trips through submit as the header", async () => {
    const calls = stubFetch([{ body: { id: "job_1", model: "m", status: "queued" } }]);
    const key = newIdempotencyKey();
    await client("k").submit("inputs/x", { idempotencyKey: key });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(key);
  });
});
