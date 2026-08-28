/**
 * `VERSION` is mirrored from package.json, and this is what makes the mirror binding.
 *
 * The Python client reads its number back from installed package metadata and cannot
 * disagree with itself. Nothing equivalent is available here: the package ships as
 * TypeScript with no build step, so importing package.json would have to resolve in
 * whatever toolchain the consumer compiles with — and reading it at runtime is not an
 * option in a browser. So the number is written twice and asserted equal.
 *
 * So: duplicate the value, and make a test the thing that keeps the copies honest.
 * Replace this with a generated version.ts once there is a `tsc` build to generate it
 * during.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CraterView, VERSION } from "../index";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("VERSION", () => {
  it("matches the version published in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  // The reason the two are kept in step at all: this string is what reaches a server log.
  it("is what the client announces itself as", async () => {
    const calls: RequestInit[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response("[]", {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    }) as typeof fetch;

    try {
      await new CraterView({ apiKey: "cv_test" }).models();
    } finally {
      globalThis.fetch = original;
    }

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`craterview-ts/${pkg.version}`);
  });
});
