/**
 * What this client reads out of a job, against the same cases the other client is held to.
 *
 * The request half of the contract is in `contract.test.ts`. This is the other direction,
 * and it is the one that had nothing holding it: an accessor reading a field the service
 * stopped sending passes this suite on its own and fails only in a customer's hands. Both
 * clients did drift that way once, on the evening `inputUrl` stopped meaning the file you
 * uploaded.
 *
 * **Published with the package.** This file goes to the public repository, so write it for
 * someone who has this package and nothing else — never how the service is built.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Job } from "../index";

// Shared with the other client's suite, one level above this package. A standalone checkout
// does not have it — the package is at the root there — so these cases skip rather than
// fail, exactly as the request contract does.
const FIXTURE = new URL("../../../tests/contract/job_responses.json", import.meta.url);
const shared = existsSync(fileURLToPath(FIXTURE));

const cases: Array<{ name: string; payload: any; expect: Record<string, any> }> =
  shared ? JSON.parse(readFileSync(fileURLToPath(FIXTURE), "utf8")).cases : [];

describe.skipIf(!shared)("what a client reads out of a job", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const job = new Job(testCase.payload);
      const want = testCase.expect;

      expect(job.id).toBe(want.id);
      expect(job.status).toBe(want.status);
      expect(job.credits).toBe(want.credits ?? null);
      expect(job.errorCode).toBe(want.error_code ?? null);
      expect(job.kept).toBe(want.kept);
      expect(job.flagged).toBe(want.flagged ?? null);
      expect(Boolean(job.outputUrl)).toBe(want.has_output_url);
      // The one this file exists for: read out of `result.input`, and the picture the model
      // worked from rather than the file you sent.
      expect(Boolean(job.inputUrl)).toBe(want.has_input_url);
      expect(Boolean(job.alphaUrl)).toBe(want.has_alpha_url);
      expect(Boolean(job.thumbUrl)).toBe(want.has_thumb_url);
      expect(job.contentType).toBe(want.output_content_type ?? null);
      expect(job.outputBytes).toBe(want.output_bytes ?? null);
    });
  }
});
