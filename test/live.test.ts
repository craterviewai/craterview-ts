/**
 * The TypeScript SDK against the real gateway.
 *
 * Stubbed tests prove the client sends what we think it sends; only this proves the
 * server agrees. Skipped automatically when the stack is not up.
 *
 *   docker compose up -d
 *   npx vitest run --root packages/craterview-ts
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CraterView, JobFailed } from "../index";

const BASE_URL = process.env.CV_BASE_URL ?? "http://localhost:8000";
// **The gateway requires a key**, and there is no unauthenticated one to point at, so a
// client built without one fails every case here with "missing or malformed Authorization
// header" — red tests that say nothing about the SDK and that a reader learns to ignore.
// Mint one and export it:
//
//   CV_API_KEY=$(python tools/accounts.py create ts-sdk | grep -o 'cv_[A-Za-z0-9_-]*')
//
// Absent, these skip with the same message the unreachable-gateway path gives, because "not
// configured" and "not running" deserve the same treatment: neither is a failing SDK.
const API_KEY = process.env.CV_API_KEY ?? "";
// Sample images for the live cases, outside this package. Point CV_SDK_TEST_INPUTS at a
// directory of your own; the cases that need one skip when it is not there.
const INPUTS = process.env.CV_SDK_TEST_INPUTS ?? "../../../../sample-inputs";

let reachable = false;

beforeAll(async () => {
  if (!API_KEY) return;   // reachable stays false; every case below skips and says why
  try {
    const resp = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    reachable = resp.ok;
  } catch {
    reachable = false;
  }
});

const cv = () => new CraterView({ baseUrl: BASE_URL, apiKey: API_KEY });

function image(name: string, type = "image/png"): Blob {
  return new Blob([readFileSync(new URL(`${INPUTS}/${name}`, import.meta.url))], { type });
}

// **The four cases that call `run()` need a real model worker.** `run()` defaults to
// `cv-restore-v1`, and the default stack serves only `echo` — so without a GPU worker
// those jobs sit queued until the 120s timeout and report as four failures that say nothing
// about the SDK. pytest gates the same cases behind `--gpu`; this is that gate.
//
//   docker compose --profile gpu up -d && CV_GPU=1 CV_API_KEY=... npm test
const GPU = process.env.CV_GPU === "1";

const gpu = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(name, async () => {
    if (!GPU) {
      console.warn(`skipping "${name}" — needs a model worker; set CV_GPU=1 with --profile gpu`);
      return;
    }
    if (!reachable) {
      console.warn(`skipping "${name}" — gateway not reachable at ${BASE_URL}`);
      return;
    }
    await fn();
  }, timeout);

const live = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(name, async () => {
    if (!reachable) {
      console.warn(API_KEY
        ? `skipping "${name}" — gateway not reachable at ${BASE_URL}`
        : `skipping "${name}" — CV_API_KEY is unset and the gateway requires a key`);
      return;
    }
    await fn();
  }, timeout);

describe("live gateway", () => {
  live("lists models with parameter schemas", async () => {
    const models = await cv().models() as Array<{ name: string; params_schema: unknown }>;
    expect(models.map((m) => m.name)).toContain("cv-restore-v1");
  });

  gpu("uploads, submits and settles in one call", async () => {
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { style: "illustration" });
    expect(job.succeeded).toBe(true);
    expect(job.outputUrl).toBeTruthy();
  });

  gpu("returns the same format it was given", async () => {
    // The contract the Python SDK also relies on; drift here would be invisible to
    // either SDK's own tests.
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { style: "photo" });
    expect(job.contentType).toBe("image/jpeg");
  });

  gpu("downloads the result", async () => {
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { style: "photo" });
    const blob = await job.blob();
    expect(blob.size).toBeGreaterThan(1000);
  });

  gpu("surfaces a server-side failure as JobFailed", async () => {
    await expect(
      cv().run(image("children-alpha.png"), { style: "photo", output_format: "jpeg" }),
    ).rejects.toBeInstanceOf(JobFailed);
  });

  live("rejects invalid parameters with the server's own message", async () => {
    const client = cv();
    const key = await client.upload(image("0030.jpg", "image/jpeg"));
    // A value outside the published enum is refused by the server, and the SDK surfaces
    // that rather than swallowing it.
    await expect(client.submit(key, { style: "no-such-style" })).rejects.toThrow(/is not one of/);
  });

  live("iterates job history", async () => {
    // **Makes its own history**, rather than reading whatever the cases above left behind:
    // those are gated on CV_GPU, so depending on them makes this pass or fail on a flag that
    // has nothing to do with it. `echo` settles in seconds and needs no GPU.
    const client = cv();
    const key = await client.upload(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    await client.submit(key, { model: "echo", wait: 10 });

    const seen: string[] = [];
    for await (const job of client.jobs({ limit: 2 })) {
      seen.push(job.id);
      if (seen.length >= 5) break;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });

  live("honours a short wait and still completes afterwards", async () => {
    const client = cv();
    const key = await client.upload(image("0030.jpg", "image/jpeg"));
    const job = await client.submit(key, { model: "echo", delay_seconds: 4, wait: 1 });
    expect(job.done).toBe(false);
    const settled = await client.waitFor(job, 60_000);
    expect(settled.succeeded).toBe(true);
  });
});
