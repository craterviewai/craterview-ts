/**
 * The TypeScript SDK against a running server.
 *
 * Stubbed tests prove the client sends what we think it sends; only this proves the
 * server agrees. Point CV_BASE_URL at one and set CV_API_KEY; every case skips by itself
 * when there is nothing there to answer.
 *
 * **Published with the package.** This file goes to the public repository, so write it
 * for someone who has this package and nothing else — never how the service is built.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { CraterView, JobFailed } from "../index";

const BASE_URL = process.env.CV_BASE_URL ?? "http://localhost:8000";
// **The API requires a key**, and there is no unauthenticated endpoint to point at, so a
// client built without one fails every case here with "missing or malformed Authorization
// header" — red tests that say nothing about the SDK and that a reader learns to ignore.
// Set CV_API_KEY to a key for the account these should run against.
//
// Absent, these skip with the same message the unreachable-server path gives, because "not
// configured" and "not running" deserve the same treatment: neither is a failing SDK.
const API_KEY = process.env.CV_API_KEY ?? "";
// Sample images for the live cases, outside this package. Point CV_SDK_TEST_INPUTS at a
// directory of your own; the cases that need one skip when it is not there, and say where
// they looked.
const INPUTS = process.env.CV_SDK_TEST_INPUTS ?? "../../../../sample-inputs";
const INPUTS_URL = new URL(`${INPUTS}/`, import.meta.url);
const HAVE_INPUTS = existsSync(INPUTS_URL);

// Two cases below need a job that finishes quickly and needs no particular hardware, and do
// not care what it produces. Which model that is belongs to the server you point this at, so
// it is named here rather than assumed:
//
//   CV_SDK_TEST_QUICK_MODEL=<model> CV_API_KEY=... npm test
//
// Left unset, those two cases skip.
const QUICK_MODEL = process.env.CV_SDK_TEST_QUICK_MODEL ?? "";

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
  return new Blob([readFileSync(new URL(name, INPUTS_URL))], { type });
}

// Wraps a case that reads a sample image: skipped, with the directory named, when there is
// no such directory — a missing file is not a failing SDK either.
const withImages = (name: string, fn: () => Promise<void>) => async () => {
  if (!HAVE_INPUTS) {
    console.warn(`skipping "${name}" — no sample images at ${INPUTS_URL.pathname}; set CV_SDK_TEST_INPUTS`);
    return;
  }
  await fn();
};

// **Two sets of cases call `run()`, against two models, and they are the same three cases.**
//
// The `echo` set runs against every server. `echo` is the free model for building against —
// no credits, no GPU, a real result — and it takes the parameters every enhancing model does
// (`scale`, `output_format`), so a job built against it is the job a paid model gets. That
// is what lets these run on any stack, and it is the set that runs in CI.
//
// The paid set calls `run()` with its default model, which needs a server with a GPU behind
// it: pointed at one without, those jobs sit queued until the 120s timeout and report as
// failures that say nothing about the SDK. This flag is how you say the model is there:
//
//   CV_GPU=1 CV_API_KEY=... npm test
//
// Both sets send only what the catalog publishes for the model they name. A parameter one
// model accepts is not a parameter another does — `cv.models()` says which — and a value a
// model does not publish is refused at submit, whatever it is called.
const GPU = process.env.CV_GPU === "1";

const gpu = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(name, async () => {
    if (!GPU) {
      console.warn(`skipping "${name}" — needs a server running that model; set CV_GPU=1`);
      return;
    }
    if (!reachable) {
      console.warn(`skipping "${name}" — nothing reachable at ${BASE_URL}`);
      return;
    }
    await fn();
  }, timeout);

// As `live`, and additionally skipped when no quick model has been named.
const quick = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(name, async () => {
    if (!reachable || !QUICK_MODEL) {
      console.warn(QUICK_MODEL
        ? `skipping "${name}" — nothing reachable at ${BASE_URL}`
        : `skipping "${name}" — set CV_SDK_TEST_QUICK_MODEL to a model this server serves`);
      return;
    }
    await fn();
  }, timeout);

const live = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(name, async () => {
    if (!reachable) {
      console.warn(API_KEY
        ? `skipping "${name}" — nothing reachable at ${BASE_URL}`
        : `skipping "${name}" — CV_API_KEY is unset and the API requires a key`);
      return;
    }
    await fn();
  }, timeout);

describe("live server", () => {
  live("lists models with parameter schemas", async () => {
    const models = await cv().models() as Array<{ name: string; params_schema: unknown }>;
    // Asserts the shape of the catalog rather than its contents: which models are listed
    // is the service's to change, and a test naming one fails the day it is withdrawn.
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.name).toBeTruthy();
      expect(model.params_schema).toBeTruthy();
    }
  });

  gpu("uploads, submits and settles in one call", withImages("uploads, submits and settles in one call", async () => {
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { scale: 4 });
    expect(job.succeeded).toBe(true);
    expect(job.outputUrl).toBeTruthy();
  }));

  gpu("returns the same format it was given, and downloads it", withImages("returns the same format it was given, and downloads it", async () => {
    // The contract the Python SDK also relies on; drift here would be invisible to
    // either SDK's own tests. One job for both assertions: every case here mints an
    // upload URL, and an account may mint ten a minute.
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { scale: 2 });
    expect(job.contentType).toBe("image/jpeg");
    const blob = await job.blob();
    expect(blob.size).toBeGreaterThan(1000);
  }));

  gpu("surfaces a server-side failure as JobFailed", withImages("surfaces a server-side failure as JobFailed", async () => {
    // A JPEG cannot carry transparency, and the service refuses the job rather than
    // flattening it silently — on every model, so the same case runs against echo below.
    await expect(
      cv().run(image("children-alpha.png"), { scale: 2, output_format: "jpeg" }),
    ).rejects.toBeInstanceOf(JobFailed);
  }));

  // The same four, against the free model, on any server. This is the call the guide to a
  // first API call makes, and the one to build against before switching the model name.
  live("echo: uploads, submits and settles in one call", withImages("echo: uploads, submits and settles in one call", async () => {
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { model: "echo", scale: 2 });
    expect(job.succeeded).toBe(true);
    expect(job.outputUrl).toBeTruthy();
  }));

  live("echo: returns the same format it was given, and downloads it", withImages("echo: returns the same format it was given, and downloads it", async () => {
    const job = await cv().run(image("0030.jpg", "image/jpeg"), { model: "echo", scale: 2 });
    expect(job.contentType).toBe("image/jpeg");
    const blob = await job.blob();
    expect(blob.size).toBeGreaterThan(1000);
  }));

  live("echo: surfaces a server-side failure as JobFailed", withImages("echo: surfaces a server-side failure as JobFailed", async () => {
    await expect(
      cv().run(image("children-alpha.png"), { model: "echo", scale: 2, output_format: "jpeg" }),
    ).rejects.toBeInstanceOf(JobFailed);
  }));

  live("rejects invalid parameters with the server's own message", withImages("rejects invalid parameters with the server's own message", async () => {
    const client = cv();
    const key = await client.upload(image("0030.jpg", "image/jpeg"));
    // A value outside the published enum is refused by the server, and the SDK surfaces
    // that rather than swallowing it. `output_format` is a parameter every model publishes,
    // so this holds whatever the default model is.
    await expect(client.submit(key, { output_format: "no-such-format" })).rejects.toThrow(/is not one of/);
  }));

  quick("iterates job history", async () => {
    // **Makes its own history**, rather than reading whatever the cases above left behind:
    // those are gated on CV_GPU, so depending on them makes this pass or fail on a flag that
    // has nothing to do with it. Only that a job exists matters here, not what it returned.
    const client = cv();
    const key = await client.upload(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    await client.submit(key, { model: QUICK_MODEL, wait: 10 });

    const seen: string[] = [];
    for await (const job of client.jobs({ limit: 2 })) {
      seen.push(job.id);
      if (seen.length >= 5) break;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });

  quick("honors a short wait and still completes afterwards", withImages("honors a short wait and still completes afterwards", async () => {
    // No wait at all, so the submit returns the job as it was queued — the quick model is
    // quick precisely so that any positive wait might finish it — and `waitFor` is what
    // carries it the rest of the way, which is the thing under test.
    const client = cv();
    const key = await client.upload(image("0030.jpg", "image/jpeg"));
    const job = await client.submit(key, { model: QUICK_MODEL, wait: 0 });
    expect(job.done).toBe(false);
    const settled = await client.waitFor(job, 60_000);
    expect(settled.succeeded).toBe(true);
  }));
});
