/**
 * Unit tests with fetch stubbed out — no services needed, so these run in CI.
 *
 * They assert two things the integration tests cannot cheaply reach: exactly what the
 * client puts on the wire, and how it maps responses back to typed errors.
 *
 * **Published with the package.** This file goes to the public repository, so write it
 * for someone who has this package and nothing else — never how the service is built.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CraterView, CraterViewError, JobFailed, RateLimited, newIdempotencyKey, sniffType,
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

// Ids in the shape the API issues them: `job_` or `key_`, then 24 hexadecimal digits.
const JOB_ID = "job_5f0c2a9e7b1d4c3a8e6f2b0d";
const KEY_ID = "key_8c1e4f7a2b5d0c3e6f9a1b4d";

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
    const calls = stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
    await client("k").submit("inputs/x", { idempotencyKey: "abc-123" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"])
      .toBe("abc-123");
  });

  it("passes model parameters through in params, not at the top level", async () => {
    const calls = stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
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
    const calls = stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
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

  it("asks the ceiling for a longer wait on submit", async () => {
    // The API caps `wait`, so a longer one was refused rather than held as a long poll.
    const calls = stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
    await client("k").submit("inputs/x", { wait: 45 });
    expect(calls[0]!.url).toBe("http://gateway.test/v1/jobs?wait=30");
  });

  it("asks for no wait when it is given none", async () => {
    // Zero is the API's own default, so it is not sent.
    for (const wait of [undefined, 0, -1]) {
      const calls = stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
      await client("k").submit("inputs/x", wait === undefined ? {} : { wait });
      expect(calls[0]!.url, String(wait)).toBe("http://gateway.test/v1/jobs");
    }
  });
});

describe("an id in a path", () => {
  // What a caller might pass where an id goes, each of which builds some other request than the
  // one the method names: a dot segment, which fetch resolves before sending — so `revokeKey("..")`
  // was `DELETE /v1/`, and `job("%2e%2e/keys/current")` read the calling key — the alias for the
  // calling key, nothing, and a real id with something after it or around it.
  const notIds = ["../account", "..", "%2e%2e", "%2e%2e/keys/current", "current", "", "job_1",
                  `${JOB_ID}/../../account`, JOB_ID.toUpperCase(), `${JOB_ID}\n`, ` ${JOB_ID}`];
  const methods = [
    { name: "job", call: (cv: CraterView, id: string) => cv.job(id),
      verb: "GET", path: "/v1/jobs/", issued: JOB_ID, other: KEY_ID },
    { name: "waitFor", call: (cv: CraterView, id: string) => cv.waitFor(id),
      verb: "GET", path: "/v1/jobs/", issued: JOB_ID, other: KEY_ID },
    { name: "revokeKey", call: (cv: CraterView, id: string) => cv.revokeKey(id),
      verb: "DELETE", path: "/v1/keys/", issued: KEY_ID, other: JOB_ID },
  ];

  it("is refused before a request is built unless it is an id the API issued", async () => {
    for (const method of methods) {
      for (const given of [...notIds, method.other]) {
        const calls = stubFetch([{ status: 204 }]);
        const failure = await method.call(client("k"), given).catch((e) => e);
        const what = `${method.name}(${JSON.stringify(given)})`;
        expect(failure, what).toBeInstanceOf(CraterViewError);
        expect(failure.message, what).toContain(JSON.stringify(given));
        expect(calls.map((c) => c.url), what).toEqual([]);
      }
    }
  });

  it("is sent as it is when the API issued it", async () => {
    for (const method of methods) {
      const calls = stubFetch([{ status: method.verb === "DELETE" ? 204 : 200,
                                 body: { id: JOB_ID, model: "m", status: "succeeded" } }]);
      await method.call(client("k"), method.issued);
      expect(calls.map((c) => [c.init.method, c.url]), method.name)
        .toEqual([[method.verb, `http://gateway.test${method.path}${method.issued}`]]);
    }
  });
});

describe("a request that never answers", () => {
  // A socket that accepts and never replies used to hold the caller's await for as long as the
  // runtime allowed — five minutes under Node, for ever in a browser — while the Python client
  // gave up at sixty seconds. `waitFor`'s own deadline cannot help while one read is stuck.
  function silentFetch() {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", (_url: string | URL, init: RequestInit = {}) => {
      signals.push(init.signal ?? undefined);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    return signals;
  }

  it("gives up at the client's timeout, as the runtime's error the retry loop repeats", async () => {
    silentFetch();
    const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test", timeoutMs: 50 });
    const started = Date.now();
    const failure = await cv.models().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((failure as Error).name).toBe("TimeoutError");
    expect(failure).not.toBeInstanceOf(CraterViewError);
  });

  it("bounds every request it makes by default, storage transfers included", async () => {
    const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });
    let calls = stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },
    ]);
    await cv.upload(new Blob(["x"], { type: "image/png" }), "image/png");
    expect(calls.map((c) => c.init.signal)).toEqual(
      [expect.any(AbortSignal), expect.any(AbortSignal)]);          // the API, then storage

    calls = stubFetch([
      { body: { id: JOB_ID, model: "cv-enhance-v3", status: "succeeded",
                result: { output: { url: "http://storage.test/out" } } } },
      { status: 200, body: {} },
    ]);
    await (await cv.job(JOB_ID)).blob();
    expect(calls[1]!.init.signal).toEqual(expect.any(AbortSignal));  // the download
  });
});

describe("error mapping", () => {
  it("carries the status when storage refuses an upload or a download", async () => {
    // The README says `.status` carries the HTTP status where there was one. Storage answers
    // these two, and a 403 (a signature that no longer matches) is the one worth branching on.
    stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 403 },
    ]);
    const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });
    await expect(cv.upload(new Blob(["x"], { type: "image/png" }), "image/png"))
      .rejects.toMatchObject({ name: "CraterViewError", status: 403 });

    stubFetch([
      { body: { id: JOB_ID, model: "cv-enhance-v3", status: "succeeded",
                result: { output: { url: "http://storage.test/out" } } } },
      { status: 403 },
    ]);
    const job = await cv.job(JOB_ID);
    await expect(job.blob()).rejects.toMatchObject({ name: "CraterViewError", status: 403 });
  });

  it("carries the code a program branches on", async () => {
    stubFetch([
      { status: 404, body: { detail: "no model", code: "model_not_found" } },
      { status: 429, body: { detail: "full", code: "queue_full" }, headers: { "Retry-After": "5" } },
      { status: 502, body: "<html>bad gateway</html>" },
    ]);
    const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });
    await expect(cv.job(JOB_ID)).rejects.toMatchObject({ status: 404, code: "model_not_found" });
    await expect(cv.models()).rejects.toMatchObject({ name: "RateLimited", code: "queue_full" });
    await expect(cv.models()).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it("carries the trace id the first-call guide says to quote", async () => {
    // The guide tells a reader to quote `X-Trace-Id` for a request the API refused. A caller of
    // this client never sees a header, so the error has to carry it.
    stubFetch([
      { status: 404, body: { detail: "no job" }, headers: { "x-trace-id": "4bf92f35" } },
      { status: 429, body: { detail: "slow" },
        headers: { "x-trace-id": "a3ce929d", "Retry-After": "7" } },
    ]);
    const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });
    await expect(cv.job(JOB_ID)).rejects.toMatchObject({ status: 404, traceId: "4bf92f35" });
    await expect(cv.models()).rejects.toMatchObject({
      name: "RateLimited", retryAfter: 7, traceId: "a3ce929d",
    });
  });

  it("maps 429 to RateLimited and parses Retry-After", async () => {
    stubFetch([{ status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "42" } }]);
    await expect(client("k").models()).rejects.toMatchObject({
      name: "RateLimited", retryAfter: 42, status: 429,
    });
  });

  it("maps a 402 from an older server to the base error", async () => {
    // No request is refused with 402 Payment Required, so this client declares no type for
    // it. A caller pointed at a deployment that does refuse must still get something catchable.
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

  it("fetches a page bigger than the API serves at the ceiling", async () => {
    // `limit` is a page size and iteration is transparent, so a caller asking for a bigger
    // page still gets every job — clamping costs them nothing, and sending it costs them a
    // 422 on the first request. The Python client clamps at the same number.
    const calls = stubFetch([{ body: { data: [{ id: "a", model: "m", status: "succeeded" }], has_more: false } }]);
    const ids: string[] = [];
    for await (const job of client("k").jobs({ limit: 5000 })) ids.push(job.id);

    expect(ids).toEqual(["a"]);
    expect(calls[0]!.url).toContain("limit=200");
  });

  it("sends a page the API will serve as asked", async () => {
    // The other side, so the clamp cannot become a fixed page size.
    const calls = stubFetch([{ body: { data: [], has_more: false } }]);
    for await (const _ of client("k").jobs({ limit: 7 })) { /* drained */ }
    expect(calls[0]!.url).toContain("limit=7");
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
});

describe("job", () => {
  const job = (over: Record<string, unknown> = {}) =>
    ({ id: JOB_ID, model: "cv-enhance-v3", status: "succeeded", ...over });

  it("exposes status predicates", async () => {
    stubFetch([{ body: job({ status: "queued" }) }]);
    const queued = await client("k").job(JOB_ID);
    expect(queued.done).toBe(false);
    expect(queued.succeeded).toBe(false);

    stubFetch([{ body: job({ status: "failed", error: "bad input" }) }]);
    const failed = await client("k").job(JOB_ID);
    expect(failed.done).toBe(true);
    expect(failed.succeeded).toBe(false);
    expect(failed.error).toBe("bad input");
  });

  it("refuses to download a result that does not exist", async () => {
    stubFetch([{ body: job({ status: "failed", output_url: null }) }]);
    const failed = await client("k").job(JOB_ID);
    await expect(failed.blob()).rejects.toBeInstanceOf(CraterViewError);
  });

  it("exposes the wait a queued job is in", async () => {
    stubFetch([{ body: job({ status: "queued", community: true, eta_seconds: 42 }) }]);
    const queued = await client("k").job(JOB_ID);
    expect(queued.community).toBe(true);
    expect(queued.etaSeconds).toBe(42);
  });

  it("treats an omitted community flag as paid work", async () => {
    // A server that omits the flag is not running community work, so its jobs are paid.
    // Null here would be a third state that means nothing to a caller.
    stubFetch([{ body: job({ status: "queued" }) }]);
    const queued = await client("k").job(JOB_ID);
    expect(queued.community).toBe(false);
  });
});

// A 40 × 25 PNG, 97 bytes: enough of a file for the header reader to size.
const PNG_40x25 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAZCAIAAADMuvsyAAAAKElEQVR4nO3NAQ0AAAgDIK/9OxvDzUEBkp660Cer" +
  "WCwWi8VisVj8K156IQA4rw/PUgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("the declared size", () => {
  // `upload()` reads the image's size from its header and `submit()` sends it as
  // `input_megapixels` for the key it came back with, so a caller who passes the key
  // straight through declares without carrying anything. Only the estimate reads it on the
  // other side; the concern here is that the figure is right, travels, and is never invented.
  const slots = () => [
    { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
    { status: 200 },
    { body: { id: JOB_ID, model: "cv-enhance-v3", status: "queued" } },
  ];

  it("reads the size at upload and sends it with a submit of that key", async () => {
    const calls = stubFetch(slots());
    const cv = client("k");
    const key = await cv.upload(PNG_40x25, "image/png");
    await cv.submit(key, { scale: 4 });
    const body = JSON.parse(calls[2]!.init.body as string);
    expect(body.input_megapixels).toBeCloseTo(0.001, 4);
    expect(body.params).toEqual({ scale: 4 });  // beside params, not a model parameter
  });

  it("declares nothing for a file the reader does not know", async () => {
    const calls = stubFetch(slots());
    const cv = client("k");
    const key = await cv.upload(new Blob(["not an image"], { type: "image/png" }));
    await cv.submit(key);
    expect(JSON.parse(calls[2]!.init.body as string)).not.toHaveProperty("input_megapixels");
  });

  it("declares nothing for a key it did not upload, unless told", async () => {
    const calls = stubFetch(slots().slice(2));
    const cv = client("k");
    await cv.submit("inputs/elsewhere");
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty("input_megapixels");
    await cv.submit("inputs/elsewhere", { inputMegapixels: 12 });
    expect(JSON.parse(calls[1]!.init.body as string).input_megapixels).toBe(12);
  });

  it("lets an explicit figure override the one it read", async () => {
    const calls = stubFetch(slots());
    const cv = client("k");
    const key = await cv.upload(PNG_40x25, "image/png");
    await cv.submit(key, { inputMegapixels: 2.5 });
    expect(JSON.parse(calls[2]!.init.body as string).input_megapixels).toBe(2.5);
  });

  it("run() declares the size of the image it was handed", async () => {
    const calls = stubFetch([
      slots()[0]!, slots()[1]!,
      { body: { id: JOB_ID, model: "cv-enhance-v3", status: "succeeded",
                result: { output: { url: "http://x" } } } },
    ]);
    await client("k").run(PNG_40x25);
    expect(JSON.parse(calls[2]!.init.body as string).input_megapixels).toBeCloseTo(0.001, 4);
  });
});

describe("run", () => {
  it("uploads, submits and returns a settled job in one call", async () => {
    const calls = stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },  // the PUT to object storage
      { body: { id: JOB_ID, model: "cv-enhance-v3", status: "succeeded", output_url: "http://x" } },
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
      { body: { id: JOB_ID, model: "m", status: "failed", error: "no face was found in the image",
                error_code: "no_face_found" } },
    ]);
    const failure = await client("k").run(new Blob(["x"])).catch((e) => e);
    expect(failure).toBeInstanceOf(JobFailed);
    expect(failure.message).toBe("no face was found in the image");
    // The half a client branches on. `run()` is the ergonomic path and the one the README
    // leads with, so a caller taking it must not be left matching on prose.
    expect(failure.errorCode).toBe("no_face_found");
  });

  it("accepts a Uint8Array as well as a Blob", async () => {
    stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },
      { body: { id: JOB_ID, model: "m", status: "succeeded" } },
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
    const calls = stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
    const key = newIdempotencyKey();
    await client("k").submit("inputs/x", { idempotencyKey: key });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(key);
  });
});


describe("the type an upload declares", () => {
  // What the bytes are, when nothing else says: a type is signed into the upload URL and
  // becomes the stored file's, and one the API does not take is refused by the first
  // request, before any bytes are sent.
  const bytes = (...b: number[]) => new Uint8Array(b);
  const text = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const ftyp = (...brands: string[]) =>
    bytes(0, 0, 0, 16 + 4 * (brands.length - 1), ...text("ftyp"), ...text(brands[0]!), 0, 0, 0, 0,
      ...brands.slice(1).flatMap(text));

  async function declared(image: Blob | Uint8Array, contentType?: string): Promise<string> {
    const calls = stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },
    ]);
    await new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" }).upload(image, contentType);
    return JSON.parse(String(calls[0]!.init.body)).content_type;
  }

  it("names a file from its signature when nothing else does", async () => {
    expect(await declared(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(await declared(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(await declared(new Blob([ftyp("heic", "mif1")]))).toBe("image/heic");
    expect(await declared(new Blob([bytes(0x49, 0x49, 0x2a, 0x00)]))).toBe("image/tiff");
  });

  it("names a format the API does not take, so the refusal can say what it is", async () => {
    expect(await declared(ftyp("avif", "mif1"))).toBe("image/avif");
    // The structural brand first and `avif` among the rest is still an AVIF, not a HEIF.
    expect(await declared(ftyp("mif1", "avif", "miaf"))).toBe("image/avif");
    expect(await declared(bytes(0xff, 0x0a, 0xcb, 0x40))).toBe("image/jxl");
  });

  it("sends a file it cannot name undeclared, never as a PNG it may not be", async () => {
    expect(await declared(bytes(1, 2, 3, 4))).toBe("application/octet-stream");
    expect(await declared(new Blob(["not an image"]))).toBe("application/octet-stream");
  });

  it("lets the caller's type decide, then the bytes, then the Blob's", async () => {
    expect(await declared(bytes(0xff, 0xd8, 0xff, 0xe0), "image/png")).toBe("image/png");
    // A JPEG named as a WebP: the name is what a Blob's type is usually read from.
    expect(await declared(new Blob([bytes(0xff, 0xd8, 0xff)], { type: "image/webp" })))
      .toBe("image/jpeg");
    expect(await declared(new Blob([bytes(1, 2, 3)], { type: "image/webp" }))).toBe("image/webp");
  });

  it("reads a signature no longer than the box that holds it", async () => {
    expect(await sniffType(new Blob([]))).toBe("");
    expect(await sniffType(new Blob([bytes(0, 0, 0, 8, ...text("ftyp"))]))).toBe("");
  });
});

describe("what an error says", () => {
  // The message is what a caller reads first, and often all they read: each one says what
  // happened on that path and what to do next, rather than handing over a structure or a page.
  const answering = (status: number, json: () => Promise<unknown>) =>
    vi.stubGlobal("fetch", async () =>
      ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json } as unknown as Response));
  const page = () => Promise.reject(new SyntaxError("Unexpected token '<'"));

  it("reads a validation refusal as field and reason, not [object Object]", async () => {
    stubFetch([{ status: 422, body: { detail: [
      { type: "greater_than", loc: ["body", "content_length"], msg: "Input should be greater than 0" },
      { type: "value_error", loc: ["body", "webhook_url"],
        msg: "Value error, must be an absolute http or https URL" },
    ] } }]);
    const failure = await client("k").models().catch((e) => e);
    expect(failure.message).toBe("content_length: Input should be greater than 0; "
      + "webhook_url: must be an absolute http or https URL");
    expect(failure.status).toBe(422);
  });

  it("does not label a refusal of the whole body with the word body", async () => {
    stubFetch([{ status: 422, body: { detail: [
      { type: "body", loc: ["body"], msg: "the request body must be a JSON object" }] } }]);
    await expect(client("k").models()).rejects.toThrow(/^the request body must be a JSON object$/);
  });

  it("names an error page from in between, and says a 5xx is worth repeating", async () => {
    answering(502, page);
    const failure = await client("k").models().catch((e) => e);
    expect(failure).toBeInstanceOf(CraterViewError);
    expect(failure.message).toMatch(/gateway\.test answered HTTP 502/);
    expect(failure.message).toMatch(/same idempotency key/);
  });

  it("says a page that is not the API is about the baseUrl", async () => {
    answering(404, page);
    const failure = await client("k").job(JOB_ID).catch((e) => e);
    expect(failure.message).toMatch(/404.*baseUrl/);
    expect(failure.message).not.toMatch(/idempotency/);
  });

  it("throws its own error for a success that is not JSON", async () => {
    // A baseUrl pointed at a website let the parser's SyntaxError escape.
    answering(200, page);
    const failure = await client("k").models().catch((e) => e);
    expect(failure).toBeInstanceOf(CraterViewError);
    expect(failure.message).toMatch(/200.*baseUrl/);
  });

  it("refuses an empty file before anything is sent", async () => {
    // Sent, it came back as a refusal of `content_length`, a field the caller never wrote.
    const calls = stubFetch([{ body: {} }]);
    await expect(client("k").upload(new Blob([]))).rejects.toThrow(/empty/);
    await expect(client("k").upload(new Uint8Array())).rejects.toThrow(/empty/);
    expect(calls).toEqual([]);
  });
});

describe("giving up on a job", () => {
  // `run()` and `waitFor()` stop waiting at their timeout; the job does not stop.
  const running = () => [
    { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
    { status: 200 },
    { body: { id: JOB_ID, model: "m", status: "running" } },
  ];

  it("says the job is still going, names it, and says how to collect it", async () => {
    // "did not finish within 600000ms" read as a failure, named nothing to collect, and left a
    // caller to run the request again — a second job, billed as well.
    stubFetch(running());
    const failure = await client("k").run(new Blob(["x"]), { timeoutMs: 0 }).catch((e) => e);
    expect(failure).toBeInstanceOf(CraterViewError);
    expect(failure).not.toBeInstanceOf(JobFailed);
    expect(failure.jobId).toBe(JOB_ID);
    expect(failure.message).toContain(`${JOB_ID} is still running`);
    expect(failure.message).toMatch(/has not failed/);
    expect(failure.message).toMatch(/charged only if it succeeds/);
    expect(failure.message).toMatch(/waitFor/);
    expect(failure.message).toMatch(/second job/);
  });

  it("says the same from waitFor", async () => {
    stubFetch([{ body: { id: JOB_ID, model: "m", status: "queued" } }]);
    const failure = await client("k").waitFor(JOB_ID, 10, 5).catch((e) => e);
    expect(failure.jobId).toBe(JOB_ID);
    expect(failure.message).toMatch(/still queued/);
  });

  it("never asks the server to hold a submit longer than the client listens", async () => {
    // `run()` asked for 30 seconds whatever the client's own timeout was, so a client given 10
    // gave up with the job already made.
    for (const [timeoutMs, expected] of [[60_000, "30"], [10_000, "5"]] as const) {
      const calls = stubFetch(running());
      const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test", timeoutMs });
      await cv.run(new Blob(["x"]), { timeoutMs: 0 }).catch(() => undefined);
      expect(new URL(calls[2]!.url).searchParams.get("wait"), String(timeoutMs)).toBe(expected);
    }
  });

  it("says the API's words when both submissions were its own 503", async () => {
    // The API's 503 to a submission is the one status it answers before anything is recorded,
    // and says so. Asked twice and answered so twice, run() said a job may have been made.
    const words = "storage could not be reached; nothing was queued or charged.";
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      if (call >= 3) {
        return { ok: false, status: 503, headers: new Headers({ "X-Trace-Id": "trace-1" }),
                 json: async () => ({ detail: words }) } as unknown as Response;
      }
      return { ok: true, status: 200, headers: new Headers(),
               json: async () => ({ input_key: "inputs/abc", upload_url: "http://storage.test/put" }) } as unknown as Response;
    });
    const failure = await client("k").run(new Blob(["x"])).catch((e) => e);
    expect(failure).toBeInstanceOf(CraterViewError);
    expect(failure.message).toContain(words);
    expect(failure.message).not.toMatch(/may have been made/);
  });

  it("says what repeating would do when its submission gets no answer", async () => {
    // The advice for a request that timed out is to repeat it with the same idempotency key.
    // `run()` uploads afresh each time, so its caller cannot, and running it again starts a
    // second job if the first was made. Still the runtime's TimeoutError, so a loop that tells
    // a refusal from no answer by type is unchanged.
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      // Both submissions: run() asks once more under its key before it gives up.
      if (call >= 3) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return { ok: true, status: 200, headers: new Headers(),
               json: async () => ({ input_key: "inputs/abc", upload_url: "http://storage.test/put" }) } as unknown as Response;
    });
    const failure = await client("k").run(new Blob(["x"])).catch((e) => e);
    expect(failure.name).toBe("TimeoutError");
    expect(failure).not.toBeInstanceOf(CraterViewError);
    expect(failure.message).toMatch(/may have been made/);
    expect(failure.message).toMatch(/jobs\(\)/);
    expect(failure.message).toMatch(/second job/);
  });
});

describe("downloading a result", () => {
  // Why there is nothing to download depends on the job, and so does what to do next.
  const job = (over: Record<string, unknown>) =>
    ({ id: JOB_ID, model: "m", status: "succeeded", ...over });
  const read = async (data: Record<string, unknown>) => {
    stubFetch([{ body: data }]);
    return await client("k").job(JOB_ID);
  };

  it("says a job still going is to be waited for", async () => {
    const failure = await (await read(job({ status: "queued" }))).blob().catch((e) => e);
    expect(failure.message).toMatch(/still queued.*waitFor/);
    expect(failure.jobId).toBe(JOB_ID);
  });

  it("says why a failed job failed", async () => {
    const failed = await read(job({ status: "failed", error: "no face was found in the image" }));
    await expect(failed.blob()).rejects.toThrow(/no face was found in the image/);
  });

  it("says both reasons a finished job may have no file, rather than guessing one", async () => {
    // A job read after its file expired looks the same as one whose model never draws.
    for (const result of [{ verdict: "passed", input: { url: "http://x" } },
      { output_bytes: 120, scaled: 2 }, null]) {
      const failure = await (await read(job({ result }))).blob().catch((e) => e);
      expect(failure.message).toMatch(/answers in `result` alone, or its file has expired or been deleted/);
    }
  });

  it("names a refused link as expired, with the way to fresh ones", async () => {
    stubFetch([
      { body: job({ result: { output: { url: "http://storage.test/out" } } }) },
      { status: 403 },
    ]);
    const failure = await (await client("k").job(JOB_ID)).blob().catch((e) => e);
    expect(failure).toMatchObject({ status: 403, jobId: JOB_ID });
    expect(failure.message).toMatch(/expired/);
    expect(failure.message).toContain(`cv.job("${JOB_ID}")`);
  });
});

describe("a job once submitted is not lost", () => {
  // `run()` is one request from upload to result. A submission that got no answer, or met a
  // failure on the way to the API, is asked once more under one key, and a read of the job
  // that fails the same way is waited through. Neither told a caller to repeat a job that
  // already existed, and a failed read lost the job's id.
  const upload = [
    { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
    { status: 200 },
  ];
  const done = { body: { id: JOB_ID, model: "m", status: "succeeded" } };
  const submits = (calls: Call[]) => calls.filter((c) => new URL(c.url).pathname === "/v1/jobs");

  it("asks a submission met by a failure on the way once more, under one key", async () => {
    const calls = stubFetch([...upload, { status: 502 }, done]);
    expect((await client("k").run(new Blob(["x"]))).id).toBe(JOB_ID);
    const keys = submits(calls).map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("says a refusal and does not ask it again", async () => {
    const calls = stubFetch([...upload, { status: 422, body: { detail: "scale: must be at most 4" } }]);
    const failure = await client("k").run(new Blob(["x"])).catch((e) => e);
    expect(failure.message).toMatch(/scale/);
    expect(submits(calls)).toHaveLength(1);
  });

  it("waits through a read that fails on the way", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      if (call === 1) throw new TypeError("fetch failed");
      const status = call === 2 ? 502 : 200;
      return { ok: status === 200, status, headers: new Headers(),
               json: async () => (status === 200 ? done.body : undefined) } as unknown as Response;
    });
    expect((await client("k").waitFor(JOB_ID, 5_000, 5)).status).toBe("succeeded");
  });

  it("carries the job on a read that is refused", async () => {
    stubFetch([{ status: 403, body: { detail: "not your job" } }]);
    const failure = await client("k").waitFor(JOB_ID, 5_000, 5).catch((e) => e);
    expect(failure).toBeInstanceOf(CraterViewError);
    expect(failure.jobId).toBe(JOB_ID);
  });
});

describe("a failed job", () => {
  it("carries the job id, and the server's sentence as its message", async () => {
    stubFetch([
      { body: { input_key: "inputs/abc", upload_url: "http://storage.test/put" } },
      { status: 200 },
      { body: { id: "job_9", model: "m", status: "failed", error: "no face was found in the image",
                error_code: "no_face_found" } },
    ]);
    const failure = await client("k").run(new Blob(["x"])).catch((e) => e);
    expect(failure).toBeInstanceOf(JobFailed);
    expect(failure.jobId).toBe("job_9");
    expect(failure.message).toBe("no face was found in the image");
  });
});
