/**
 * The TypeScript SDK against a running server.
 *
 * Stubbed tests prove the client sends what we think it sends; only this proves the
 * server agrees. Point CV_BASE_URL at one and set CV_API_KEY; every case skips by itself
 * when there is nothing there to answer, and is counted as skipped — never as passed.
 *
 * **Published with the package.** This file goes to the public repository, so write it
 * for someone who has this package and nothing else — never how the service is built.
 */

import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
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
// Sample images for the live cases, outside this package. CV_SDK_TEST_INPUTS names a directory
// of your own, relative to where the suite is run, as any path in the environment is. Unset, a
// directory beside the repository is looked for, and the cases that need one skip when it is
// not there, saying where they looked. Set, it must name a directory: a path that names
// nothing is a mistake, and turning every case that needs it into a skip would hide it.
const INPUTS = process.env.CV_SDK_TEST_INPUTS;
const INPUTS_URL = INPUTS
  ? pathToFileURL(`${resolve(INPUTS)}${sep}`)
  : new URL("../../../../sample-inputs/", import.meta.url);
if (INPUTS && !existsSync(INPUTS_URL)) {
  throw new Error(`CV_SDK_TEST_INPUTS is ${INPUTS}, which names no directory from ${process.cwd()}`);
}
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

type Case = (ctx: TestContext) => Promise<void>;

// **A case that cannot run here is skipped, and counted as skipped.** It used to return early,
// and was then reported as passed: a run with nothing behind it read "11 passed". The reason
// is said as well as given to the runner, so a person reading the output sees why.
function skip(ctx: TestContext, name: string, why: string): never {
  console.warn(`skipping "${name}" — ${why}`);
  return ctx.skip(why) as never;
}

// Wraps a case that reads a sample image: skipped, with the directory named, when there is
// no such directory — a missing file is not a failing SDK either.
const withImages = (name: string, fn: Case): Case => async (ctx) => {
  if (!HAVE_INPUTS) {
    skip(ctx, name, `no sample images at ${INPUTS_URL.pathname}; set CV_SDK_TEST_INPUTS`);
  }
  await fn(ctx);
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

const gpu = (name: string, fn: Case, timeout = 120_000) =>
  it(name, async (ctx) => {
    if (!GPU) skip(ctx, name, "needs a server running that model; set CV_GPU=1");
    if (!reachable) skip(ctx, name, `nothing reachable at ${BASE_URL}`);
    await fn(ctx);
  }, timeout);

// As `live`, and additionally skipped when no quick model has been named.
const quick = (name: string, fn: Case, timeout = 120_000) =>
  it(name, async (ctx) => {
    if (!QUICK_MODEL) skip(ctx, name, "set CV_SDK_TEST_QUICK_MODEL to a model this server serves");
    if (!reachable) skip(ctx, name, `nothing reachable at ${BASE_URL}`);
    await fn(ctx);
  }, timeout);

const live = (name: string, fn: Case, timeout = 120_000) =>
  it(name, async (ctx) => {
    if (!reachable) {
      skip(ctx, name, API_KEY ? `nothing reachable at ${BASE_URL}`
                              : "CV_API_KEY is unset and the API requires a key");
    }
    await fn(ctx);
  }, timeout);

describe("live server", () => {
  live("lists models with parameter schemas", async () => {
    const models = await cv().models() as Array<{ id: string; params_schema: unknown }>;
    // Asserts the shape of the catalog rather than its contents: which models are listed
    // is the service's to change, and a test naming one fails the day it is withdrawn.
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.id).toBeTruthy();
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

  gpu("keeps the transparency of a picture asked for as JPEG, as a PNG", withImages("keeps the transparency of a picture asked for as JPEG, as a PNG", async () => {
    // A JPEG cannot carry transparency, so the format asked for gives way to one that can —
    // on every model, so the same case runs against echo below.
    const job = await cv().run(image("children-alpha.png"), { scale: 2, output_format: "jpeg" });
    expect(job.contentType).toBe("image/png");
  }));

  // The same cases, against the free model, on any server. This is the call the guide to a
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

  live("echo: keeps the transparency of a picture asked for as JPEG, as a PNG", withImages("echo: keeps the transparency of a picture asked for as JPEG, as a PNG", async () => {
    const job = await cv().run(image("children-alpha.png"), { model: "echo", scale: 2, output_format: "jpeg" });
    expect(job.contentType).toBe("image/png");
  }));

  live("echo: surfaces a server-side failure as JobFailed", withImages("echo: surfaces a server-side failure as JobFailed", async () => {
    // `fail: public` is echo's own way to fail as a mistake in the request does.
    await expect(
      cv().run(image("0030.jpg", "image/jpeg"), { model: "echo", fail: "public" }),
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
