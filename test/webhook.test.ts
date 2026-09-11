/**
 * Verifying a callback. No services needed — a signature is arithmetic, so these run in CI.
 *
 * Every case here is a mistake a receiver can actually make, and each one is the difference
 * between a webhook endpoint that authenticates its input and one that only appears to.
 *
 * **Published with the package.** This file goes to the public repository, so write it
 * for someone who has this package and nothing else — never how the service is built.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE_SECONDS, InvalidSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER,
  verifyWebhook,
} from "../index";

const SECRET = "cvwh_test-secret";

/** What the platform sends: HMAC-SHA256 over `<timestamp>.<body>`, hex, `sha256=` prefixed. */
async function sign(body: string, timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return "sha256=" + Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function now(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function delivery(body: string, secret = SECRET, timestamp = now()) {
  return {
    body,
    headers: {
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: await sign(body, timestamp, secret),
    },
  };
}

describe("verifyWebhook", () => {
  it("accepts a genuine delivery and returns the parsed body", async () => {
    const { body, headers } = await delivery('{"id":"job_1","status":"succeeded"}');
    const event = await verifyWebhook(body, headers, SECRET);
    expect(event.id).toBe("job_1");
    expect(event.status).toBe("succeeded");
  });

  it("rejects a body that was altered in transit", async () => {
    const { headers } = await delivery('{"status":"failed"}');
    await expect(verifyWebhook('{"status":"succeeded"}', headers, SECRET))
      .rejects.toBeInstanceOf(InvalidSignature);
  });

  it("rejects a signature made with somebody else's secret", async () => {
    const { body, headers } = await delivery('{"id":"job_1"}', "cvwh_not-yours");
    await expect(verifyWebhook(body, headers, SECRET))
      .rejects.toBeInstanceOf(InvalidSignature);
  });

  it("rejects a delivery with no signature headers", async () => {
    await expect(verifyWebhook("{}", {}, SECRET))
      .rejects.toBeInstanceOf(InvalidSignature);
  });

  it("rejects a stale delivery, so a captured one cannot be replayed later", async () => {
    const old = String(Math.floor(Date.now() / 1000) - DEFAULT_TOLERANCE_SECONDS - 60);
    const { body, headers } = await delivery('{"id":"job_1"}', SECRET, old);
    await expect(verifyWebhook(body, headers, SECRET))
      .rejects.toBeInstanceOf(InvalidSignature);
  });

  it("rejects a delivery dated in the future", async () => {
    const ahead = String(Math.floor(Date.now() / 1000) + DEFAULT_TOLERANCE_SECONDS + 60);
    const { body, headers } = await delivery('{"id":"job_1"}', SECRET, ahead);
    await expect(verifyWebhook(body, headers, SECRET))
      .rejects.toBeInstanceOf(InvalidSignature);
  });

  it("accepts an old delivery when the tolerance is switched off", async () => {
    const old = String(Math.floor(Date.now() / 1000) - 86_400);
    const { body, headers } = await delivery('{"id":"job_1"}', SECRET, old);
    const event = await verifyWebhook(body, headers, SECRET, { toleranceSeconds: 0 });
    expect(event.id).toBe("job_1");
  });

  it("accepts either secret while a rotation is in progress", async () => {
    // The header carries one signature per live secret, so a receiver still holding the
    // previous one keeps working until it has deployed the replacement.
    const body = '{"id":"job_1"}';
    const timestamp = now();
    const headers = {
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: [
        await sign(body, timestamp, "cvwh_the-new-one"),
        await sign(body, timestamp, SECRET),
      ].join(","),
    };

    await expect(verifyWebhook(body, headers, SECRET)).resolves.toMatchObject({ id: "job_1" });
    await expect(verifyWebhook(body, headers, "cvwh_the-new-one"))
      .resolves.toMatchObject({ id: "job_1" });
    await expect(verifyWebhook(body, headers, "cvwh_neither"))
      .rejects.toBeInstanceOf(InvalidSignature);
  });

  it("reads headers however the framework spells them", async () => {
    const { body, headers } = await delivery('{"id":"job_1"}');
    const lowered = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    await expect(verifyWebhook(body, lowered, SECRET)).resolves.toMatchObject({ id: "job_1" });

    const asHeaders = new Headers(headers as Record<string, string>);
    await expect(verifyWebhook(body, asHeaders, SECRET)).resolves.toMatchObject({ id: "job_1" });
  });

  it("takes the body as bytes as well as text", async () => {
    const text = '{"id":"job_1"}';
    const { headers } = await delivery(text);
    const bytes = new TextEncoder().encode(text);

    await expect(verifyWebhook(bytes, headers, SECRET)).resolves.toMatchObject({ id: "job_1" });
    await expect(verifyWebhook(bytes.buffer as ArrayBuffer, headers, SECRET))
      .resolves.toMatchObject({ id: "job_1" });
  });

  it("refuses a verified delivery whose body is not JSON", async () => {
    // Signed correctly and still unusable — reported as a refusal rather than as a parse
    // error escaping from inside, so a caller has one thing to catch.
    const { body, headers } = await delivery("not json at all");
    await expect(verifyWebhook(body, headers, SECRET))
      .rejects.toBeInstanceOf(InvalidSignature);
  });
});
