/**
 * The shared wire contract, read from the same JSON the Python suite uses.
 *
 * Each client is already tested on its own. What neither suite can see alone is the two
 * drifting apart — one sending output_format while the other sends outputFormat passes
 * both and fails only against a real gateway. This maps each contract case onto this
 * client's idiomatic signature and asserts the request that goes out is identical.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CraterView, CraterViewError, RateLimited } from "../index";

const contract = JSON.parse(
  readFileSync(new URL("../../../tests/contract/wire_contract.json", import.meta.url), "utf8"),
) as {
  submit: Array<{ name: string; call: Record<string, any>; expect: Record<string, any> }>;
  auth: Array<{ name: string; api_key: string; expect: { headers: Record<string, string> } }>;
  errors: Array<{ status: number; detail: string; retry_after?: string; expect_type: string }>;
  account: Array<{
    name: string; method_name: string; args?: any[];
    expect: { method: string; path: string; body: Record<string, unknown> | null };
  }>;
};

interface Call { url: string; init: RequestInit }

function stub(status = 200, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      json: async () => body,
    } as unknown as Response;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("wire contract: submit", () => {
  for (const testCase of contract.submit) {
    it(testCase.name, async () => {
      const calls = stub(200, { id: "job_1", model: "m", status: "queued" });
      const { model, input_key, params, wait, idempotency_key, webhook_url } = testCase.call;

      const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });
      await cv.submit(input_key, {
        model,
        ...(wait !== undefined ? { wait } : {}),
        ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
        ...(webhook_url ? { webhookUrl: webhook_url } : {}),
        ...params,
      });

      const sent = calls[0]!;
      const body = JSON.parse(sent.init.body as string);
      expect(sent.init.method).toBe(testCase.expect.method);
      expect(sent.url).toContain(testCase.expect.path);
      if (testCase.expect.query_contains) {
        expect(sent.url).toContain(testCase.expect.query_contains);
      }
      expect(body).toEqual(testCase.expect.body);
      for (const [header, value] of Object.entries(testCase.expect.headers ?? {})) {
        expect((sent.init.headers as Record<string, string>)[header]).toBe(value);
      }
    });
  }
});

describe("wire contract: auth", () => {
  for (const testCase of contract.auth) {
    it(testCase.name, async () => {
      const calls = stub(200, []);
      await new CraterView({ apiKey: testCase.api_key, baseUrl: "http://gateway.test" }).models();
      for (const [header, value] of Object.entries(testCase.expect.headers)) {
        expect((calls[0]!.init.headers as Record<string, string>)[header]).toBe(value);
      }
    });
  }
});

describe("wire contract: errors", () => {
  const types: Record<string, unknown> = { RateLimited, CraterViewError };

  for (const testCase of contract.errors) {
    it(`${testCase.status} maps to ${testCase.expect_type}`, async () => {
      stub(testCase.status, { detail: testCase.detail },
           testCase.retry_after ? { "Retry-After": testCase.retry_after } : {});
      const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });

      const error = await cv.models().then(() => null, (e) => e);
      expect(error).toBeInstanceOf(types[testCase.expect_type] as never);
      expect(String(error)).toContain(testCase.detail);
      if (testCase.retry_after) {
        expect((error as RateLimited).retryAfter).toBe(Number(testCase.retry_after));
      }
    });
  }
});

/**
 * The credential calls. Each is one line in each client, which is exactly why they drift:
 * a path or a method typed differently in one of them is invisible until a customer's key
 * management fails against the real gateway.
 *
 * The contract names methods in the Python client's spelling, because the wire is what it
 * describes and each language spells its own call how its language would.
 */
const METHODS: Record<string, (cv: CraterView, args: any[]) => Promise<unknown>> = {
  keys: (cv) => cv.keys(),
  create_key: (cv, args) => (args.length ? cv.createKey(args[0]) : cv.createKey()),
  revoke_key: (cv, args) => cv.revokeKey(args[0]),
  webhook_secret: (cv) => cv.webhookSecret(),
  rotate_webhook_secret: (cv) => cv.rotateWebhookSecret(),
};

describe("wire contract: account", () => {
  for (const testCase of contract.account) {
    it(testCase.name, async () => {
      const isDelete = testCase.expect.method === "DELETE";
      const calls = stub(isDelete ? 204 : 200, {
        secret: "cvwh_x", id: "key_1", key: "cv_x", prefix: "cv_x",
        name: "api", rate_limit_per_minute: 60,
      });

      const cv = new CraterView({ apiKey: "k", baseUrl: "http://gateway.test" });
      await METHODS[testCase.method_name]!(cv, testCase.args ?? []);

      const sent = calls[0]!;
      expect(sent.init.method).toBe(testCase.expect.method);
      expect(sent.url).toContain(testCase.expect.path);
      // `null` in the contract means the call sends no body at all. A request that quietly
      // grew one would be a difference between the clients no single-language suite sees.
      if (testCase.expect.body === null) {
        expect(sent.init.body).toBeUndefined();
      } else {
        expect(JSON.parse(sent.init.body as string)).toEqual(testCase.expect.body);
      }
    });
  }
});
