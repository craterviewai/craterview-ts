/**
 * CraterView.ai TypeScript client.
 *
 *   import { CraterView } from "craterview";
 *
 *   const cv = new CraterView({ apiKey: "cv_..." });
 *   const job = await cv.run(file, { scale: 4 });
 *   const blob = await job.blob();
 *
 * One dependency: `image-size`, which reads an image's dimensions from its header — no
 * decoding — so the client can tell the API how big the file you sent is and get a wait
 * estimated for that file rather than a typical one. fetch and Blob are standard in Node 18+
 * and every browser, and `image-size` runs in both, so the client stays installable anywhere.
 */

import { imageSize } from "image-size";

// Mirrored from package.json, which is the number a release bumps. It cannot be imported
// from there — this ships as TypeScript, so the import would have to resolve in the
// consumer's toolchain — so test/version.test.ts asserts the two agree.
export const VERSION = "0.4.20";
const DEFAULT_BASE_URL = "https://api.craterview.ai";
// The server rejects a longer wait outright, so asking for one costs a 422 rather than the
// wait you asked for. `run()` clamps to this rather than letting that happen.
const MAX_SERVER_WAIT = 30;
// The largest page the job history serves. Same reasoning: a bigger `limit` is refused, so
// `jobs()` clamps rather than spending a request to be told no.
const MAX_PAGE = 200;
// The shape of each kind of id the API names in a path, exactly as it issues them. A method
// that puts an id in its path takes one of these and nothing else, because anything else builds
// some other request than the one the method names: `..` is a dot segment that fetch resolves
// before sending, so `revokeKey("..")` would be `DELETE /v1/`, and encoding does not help,
// since `%2e%2e` is resolved the same way.
const IDS = { job: /^job_[0-9a-f]{24}$/, key: /^key_[0-9a-f]{24}$/ } as const;

/**
 * A random key for safely repeating a submission.
 *
 * Generate one per *logical request* and reuse it for every attempt at that request:
 *
 *   const key = newIdempotencyKey();          // once, before the first attempt
 *   for (let attempt = 0; attempt < 3; attempt++) {
 *     try {
 *       job = await cv.submit(inputKey, { idempotencyKey: key, scale: 4 });
 *       break;
 *     } catch (e) {
 *       if (!(e instanceof CraterViewError)) continue;  // same key, at most one job
 *       throw e;
 *     }
 *   }
 *
 * Generating a fresh key per attempt defeats the purpose entirely — the server has
 * nothing to match against and each attempt starts its own job. That is the mistake this
 * function exists to make harder, not easier: it is deliberately not called for you,
 * because only the caller knows where one request ends and the next begins.
 *
 * Reusing a key with a *different* request body is rejected with 409 rather than silently
 * returning the earlier result.
 *
 * `submit()` does not retry on your behalf: the loop above is yours to write. `run()`, which is
 * one whole request from upload to result, keeps a key of its own and asks once more.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(24);
  // Present in Node 18+ and every browser. Math.random is not a substitute: two clients
  // starting together would draw the same sequence and collide on the server.
  globalThis.crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `idem_${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * The media type a file's bytes are, from the signature at their start, or `""` for one this
 * does not recognise. Formats the API does not take are named too, so that a refusal says
 * what the file is rather than that it is unknown.
 */
export async function sniffType(blob: Blob): Promise<string> {
  const b = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const at = (offset: number, text: string) =>
    [...text].every((c, i) => b[offset + i] === c.charCodeAt(0));
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)
      || starts(0x49, 0x49, 0x2b, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2b)) return "image/tiff";
  if (starts(0xff, 0x0a) || (starts(0, 0, 0, 0x0c) && at(4, "JXL "))) return "image/jxl";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(4, "ftyp")) {
    // An ISO base media file names its brands: the major one, then the compatible ones to
    // the end of the `ftyp` box. An AVIF may declare the generic `mif1` first and `avif`
    // among the rest, so every brand is read before deciding.
    const word = (o: number) => String.fromCharCode(...b.slice(o, o + 4));
    const end = Math.min(new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0), b.length);
    const major = word(8);
    const brands = [major];
    for (let o = 16; o + 4 <= end; o += 4) brands.push(word(o));
    if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
    if (["heic", "heix", "heim", "heis"].includes(major)) return "image/heic";
    if (["mif1", "mif2", "msf1"].includes(major)) return "image/heif";
  }
  return "";
}

/** `value`, if it is a `kind` id as the API issues them; otherwise a {@link CraterViewError}. */
function issued(kind: keyof typeof IDS, value: unknown, argument: string): string {
  if (typeof value === "string" && IDS[kind].test(value)) return value;
  throw new CraterViewError(`${argument} must be a ${kind} id as the API returned it — ${kind}_ `
    + `and 24 hexadecimal digits — not ${JSON.stringify(value)}; nothing was sent`);
}

/** How long `run()` waits before asking a submission again: the pause the web page, the phone
 *  app and the assistant connector take. */
const RESUBMIT_AFTER_MS = 2_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No answer, or a failure on the platform's side or on the way to it: asked again, the request
 *  may be answered. `fetch` rejects with a `TypeError` only when nothing came back. A refusal, a
 *  4xx, is the same answer the next time. */
function worthAskingAgain(e: unknown): boolean {
  return (e as Error)?.name === "TimeoutError" || e instanceof TypeError
    || (e instanceof CraterViewError && (e.status ?? 0) >= 500);
}

/** The API's own 503 to a submission: the one status it answers before anything is recorded,
 *  so nothing was queued or charged. A 503 page from something on the way carries no trace id
 *  and says nothing about the job. */
function queuedNothing(e: unknown): boolean {
  return e instanceof CraterViewError && e.status === 503 && e.traceId !== undefined;
}

/**
 * `status` is the HTTP status where there was one. `traceId` is the API's `X-Trace-Id` for a
 * request it answered and refused — the id to quote when asking about it. Absent when the
 * refusal came from storage rather than the API.
 *
 * `jobId` is the job an error is about, where there is one: a job that failed, one whose wait
 * ran out while it carried on, or one whose result could not be fetched. Quote it when asking
 * about the job, and collect a job still going by it.
 */
export class CraterViewError extends Error {
  constructor(message: string, readonly status?: number, readonly traceId?: string,
              readonly jobId?: string) {
    super(message);
    this.name = "CraterViewError";
  }
}

/**
 * 429 — too fast, or too much at once. Five different limits answer with this, and the
 * message says which:
 *
 * - the key's request rate, per minute;
 * - the account's new keys, per hour — counted across all its keys, and only from
 *   `createKey`;
 * - the account's upload URLs, per minute — counted across all its keys;
 * - the account's cap on jobs queued or running at the same time, which exists so one
 *   caller cannot occupy the whole fleet. `usage()` reports the cap and what you currently
 *   hold against it;
 * - the queue itself, when it is full and taking no more work. Nothing you sent is wrong;
 *   an account with credit or a subscription submits on a queue that fills separately.
 *
 * `retryAfter` is seconds to wait, and what it means depends on which limit you hit: for
 * the two per-minute limits it is when the window rolls over; for new keys, when the account
 * may be given another; for the in-flight cap and the full queue it is an interval to poll
 * on, since nothing here predicts when a slot frees.
 */
export class RateLimited extends CraterViewError {
  constructor(message: string, readonly retryAfter?: number, traceId?: string) {
    super(message, 429, traceId);
    this.name = "RateLimited";
  }
}

/**
 * The job ran and did not succeed.
 *
 * `message` says what you can do about it and `errorCode` is the half to branch on, because
 * the prose is written for a person and gets reworded. `inference_failed` means the fault was
 * ours, nothing was charged, and the same call is worth making again.
 *
 * An unfamiliar code is a failure with no special handling, not an error in itself: new ones
 * appear as new things become worth telling apart. `jobId` is the job, to quote when asking
 * about it.
 */
export class JobFailed extends CraterViewError {
  constructor(message: string, readonly errorCode?: string, jobId?: string) {
    super(message, undefined, undefined, jobId);
    this.name = "JobFailed";
  }
}

export const SIGNATURE_HEADER = "CV-Signature";
export const TIMESTAMP_HEADER = "CV-Timestamp";

/**
 * How far out of date a delivery's timestamp may be before {@link verifyWebhook} refuses it.
 * Generous enough to cover a delivery that was retried before it reached you, tight enough
 * that a copy captured earlier is no longer accepted.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * A delivery did not verify. Do not act on the body.
 *
 * Thrown for every reason a delivery can fail to check out — a wrong signature, a missing
 * header, a timestamp too old — because from a receiver's point of view they are one
 * outcome: this is not something we sent, so it does not get to do anything.
 */
export class InvalidSignature extends CraterViewError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignature";
  }
}

/**
 * Check that a callback really came from CraterView, and return its parsed body.
 *
 *     app.post("/hooks/craterview", async (req, res) => {
 *       const raw = await rawBody(req);            // the bytes, not req.body
 *       const event = await verifyWebhook(raw, req.headers, MY_SECRET);
 *       res.sendStatus(200);                        // answer first, work afterwards
 *     });
 *
 * Throws {@link InvalidSignature} if it does not check out. **Verify before you parse**, and
 * pass the raw body exactly as received — most frameworks parse JSON for you, and
 * re-serializing it changes the bytes the signature was computed over. In Express that means
 * `express.raw({ type: "application/json" })` on this route.
 *
 * Async because it uses WebCrypto, which is what makes this work unchanged in Node and in a
 * browser or edge runtime without pulling in a crypto dependency.
 *
 * Get your secret from {@link CraterView.webhookSecret}, or from the dashboard.
 */
export async function verifyWebhook(
  body: string | Uint8Array | ArrayBuffer,
  headers: Record<string, string | string[] | undefined> | Headers,
  secret: string,
  options: { toleranceSeconds?: number } = {},
): Promise<WebhookEvent> {
  const { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = options;
  // Before the delivery is looked at: an unset secret is this receiver's configuration, not a
  // delivery that failed to check out, and refusing every delivery as forged would hide it.
  if (!secret) {
    throw new CraterViewError("verifyWebhook was given no secret: pass the one "
      + "webhookSecret() returns, or the one on the dashboard");
  }

  const signature = readHeader(headers, SIGNATURE_HEADER);
  const timestamp = readHeader(headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    throw new InvalidSignature("delivery is missing its signature headers");
  }

  // Whole seconds in ASCII digits, as the platform writes it, and nothing else: `Number()`
  // would also take whitespace of any script, a sign, an exponent or hex. Fifteen digits is
  // past any time a clock will show.
  if (!/^[0-9]{1,15}$/.test(timestamp)) {
    throw new InvalidSignature("delivery has an unreadable timestamp");
  }
  const sentAt = Number(timestamp);
  // Both directions. A clock ahead of ours is as much a reason to distrust a delivery as one
  // behind it, and only checking the past accepts anything dated next year.
  const age = Date.now() / 1000 - sentAt;
  if (toleranceSeconds && age > toleranceSeconds) {
    throw new InvalidSignature(`delivery was signed ${age.toFixed(0)}s ago, longer ago than the `
      + `${toleranceSeconds}s allowed: a copy replayed late, or a clock here that is wrong`);
  }
  if (toleranceSeconds && -age > toleranceSeconds) {
    throw new InvalidSignature(`delivery is dated ${(-age).toFixed(0)}s ahead of this machine's `
      + `clock, more than the ${toleranceSeconds}s allowed: check the clock here`);
  }

  const bytes = toBytes(body);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix, 0);
  signed.set(bytes, prefix.length);

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, signed);
  const expected = "sha256=" + Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  // A list, because a rotated secret keeps signing alongside its replacement for a while —
  // so accept the delivery if any entry matches, and you can deploy a new secret whenever
  // suits rather than the moment you asked for one.
  const matched = signature.split(",").some((entry) => timingSafeEqual(expected, entry.trim()));
  if (!matched) throw new InvalidSignature("signature does not match");

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as WebhookEvent;
  } catch {
    throw new InvalidSignature("delivery verified but its body is not JSON");
  }
}

/** One header, however the caller's framework spells its container. */
function readHeader(
  headers: Record<string, string | string[] | undefined> | Headers,
  name: string,
): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const plain = headers as Record<string, string | string[] | undefined>;
  const found = plain[name] ?? plain[name.toLowerCase()];
  return Array.isArray(found) ? found[0] : found;
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body instanceof ArrayBuffer ? new Uint8Array(body) : body;
}

/**
 * Compare without returning early. A comparison that stops at the first difference leaks,
 * one character at a time, how much of a guess was right.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i++) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differing === 0;
}

/**
 * One entry from the model catalog, exactly as it arrives. Snake case is the wire's, as
 * with `JobData` — there is no wrapper class here because there is no behavior to add.
 */
export interface ModelInfo {
  /** The public name, and what you pass as `model` when submitting. */
  name: string;
  version: string;
  title: string;
  description: string;
  accepts: string[];
  /**
   * The media type a result usually comes back as, and advisory: a model that keeps the
   * format you sent returns what you sent. Null on a model that returns no file at all,
   * whose answer is in the job's own fields.
   */
  produces: string | null;
  /**
   * Announced, and not in service yet: submitting to this model is refused with 409 until
   * it launches. Everything else here — the price, the schema, the ceilings — is final, so
   * an integration written now needs no change on the day it opens.
   */
  coming_soon?: boolean;
  /**
   * Whether video for this model is on its way, which is why `accepts` names no video type
   * yet. False on a model that takes video already and on one that never will — those two
   * look identical in `accepts` alone.
   */
  video_coming_soon?: boolean;
  /**
   * What kind of model this is. `fixed` is a lasting part of the service; `comet` is a
   * utility or fun experiment.
   */
  tenure?: "fixed" | "comet";
  max_input_bytes: number;
  /**
   * The ceilings **your key** is held to, not the model's widest. Community work is bounded
   * more tightly than paid work, so these move when `community` below does — check them
   * before uploading rather than learning them from a rejected job.
   *
   * `max_frame_megapixels` bounds one frame you send, and applies to images too since a
   * still is one frame. `max_frames` bounds how many frames one job may carry. Zero means
   * that axis is unbounded for you.
   *
   * For a duration, divide: `max_frames / reference_fps` is the longest clip you may send, in
   * seconds. It is not published as its own field on purpose — one limit with two spellings
   * is one that can disagree with itself, and frames are what the platform counts, enforces
   * and bills on.
   */
  max_frame_megapixels: number;
  max_frames: number;
  /**
   * The largest frame you may get **back**, in megapixels, and for a model that enlarges it
   * is the ceiling that decides whether a job runs: what returns is the frame you send
   * multiplied by the enlargement in each direction, so a modest photograph at a large
   * enlargement is refused where the same photograph unenlarged is not.
   *
   * Check it before uploading:
   *
   * ```ts
   * const result = megapixels * scale ** 2;
   * if (model.max_output_megapixels && result > model.max_output_megapixels) {
   *   // send a smaller region of the image, or ask for less enlargement
   * }
   * ```
   *
   * Sending a smaller region keeps every pixel of what it covers; asking for less
   * enlargement keeps the whole picture. Zero means this axis is unbounded for you.
   */
  max_output_megapixels: number;
  /**
   * The most of a picture this model works on in one job, in megapixels: the region you
   * name with `roi`, or the whole image. Where it is set it binds at every enlargement, so
   * the largest frame you may send is the smaller of this and `max_output_megapixels`
   * divided by the square of the enlargement — and asking for less enlargement does not
   * help with it, where a smaller region does. Zero means this axis is unbounded for you.
   */
  max_input_megapixels: number;
  /**
   * The most of a picture this model works on in one job with `denoise` sent as true, in
   * megapixels; `max_input_megapixels` applies otherwise. Null for a model that takes no
   * `denoise`. Zero means this axis is unbounded for you.
   */
  max_denoise_input_megapixels?: number | null;
  /** Whole credits. The price is flat and knowable before you send anything. */
  credits_per_image: number;
  /** Whole credits. Null means this model takes stills only. */
  credits_per_video_second?: number | null;
  reference_fps: number;
  params_schema: Record<string, unknown>;
  /**
   * Every name in `params_schema`'s `properties`, in the order a form presents them. JSON does
   * not order an object's keys, so a form drawn from the schema reads its order from here.
   */
  params_order: string[];
  /**
   * JSON Schema for the fields a finished job of this model states under `result`, beside
   * any files it links. Empty for a model whose whole answer is its file.
   */
  result_schema: Record<string, unknown>;
  /**
   * Whether your key's work goes to the community queue, which runs on shared, free capacity
   * and can wait longer at busy times. False while the account is paying — holding credit, or
   * on a subscription — which puts its work on paid compute that scales with demand.
   *
   * The same field, meaning the same thing, as `Job.community`. How long a wait will be
   * is answered on the job, once you have one — `Job.eta_seconds` — and nowhere else.
   */
  community: boolean;
  /** Of `params_schema`, the ones that apply to still images only. */
  image_only_params: string[];
}

/** One key on the account. Never the key itself — only the prefix, which identifies it. */
export interface KeyInfo {
  id: string;
  /** The first few characters. Enough to tell one key from another, not enough to use. */
  prefix: string;
  name: string;
  created_at: string | null;
  /** When it stopped working, or null while it still does. */
  revoked_at?: string;
  rate_limit_per_minute: number;
  /**
   * Whether this is the key you are calling with. It cannot be revoked by id while it is;
   * `DELETE /v1/keys/current` ends it on request, unless it is the account's only way
   * back in. This client has no method for that call.
   */
  current: boolean;
}

/** A freshly minted key. The only response that carries a usable value. */
export interface NewKey {
  id: string;
  /** The key itself, returned once and never again. */
  key: string;
  prefix: string;
  name: string;
  rate_limit_per_minute: number;
}

/**
 * The body of a callback, once {@link verifyWebhook} has checked it came from us.
 *
 * A job, delivered rather than fetched: the same fields a read of the job states, under the
 * same names, every one present and null where it does not apply — so a receiver parses one
 * shape rather than branching on which keys arrived.
 */
export interface WebhookEvent extends Required<JobData> {}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

/** A job's standing with the public gallery: `pending` under review, `approved` once shown. */
export interface GalleryState {
  status: "pending" | "approved";
  /** The submission's id, which is what withdrawing it takes. */
  post_id: string;
}

/** How far a running job has got. */
export interface JobProgress {
  /** `starting` while your file is fetched and read, `processing` while the model runs,
   * `saving` while the result is stored. */
  stage: "starting" | "processing" | "saving";
  /** Roughly how much of the run is done, from 0 up to but never reaching 1, estimated from
   * how long recent jobs like this one have taken. Null when no estimate holds. */
  fraction: number | null;
}

/** The API's job representation, exactly as it arrives. Snake case is the wire's. */
export interface JobData {
  id: string;
  model: string;
  status: JobStatus;
  /**
   * Whatever you passed as `customId` at submit, handed straight back. Stored and echoed;
   * nothing on the platform interprets it, and jobs cannot be looked up by it.
   */
  custom_id?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  /**
   * The stable half of `error` — branch on this rather than on the sentence, which is
   * written for a person and may be reworded. `inference_failed` means the platform
   * declined to explain the failure, and a retry is worth trying.
   */
  error_code?: string | null;
  /**
   * Everything this job produced, in one object: the model's own answer, plus an `output`
   * section carrying the file's links when the model produced one. Some models return only
   * the answer and no file, so read this rather than assuming there is something to
   * download.
   *
   * This is the only place those links are sent. `outputUrl` and the accessors beside it
   * read them out of `result.output`.
   */
  result?: Record<string, unknown> | null;
  /**
   * A small JPEG of the job's picture, for a listing: the result, or the image the model
   * worked from when it produced no file. Absent until the job succeeds, where none could be
   * drawn, and once the job's pictures are deleted.
   */
  thumbnail_url?: string | null;
  /** Whole credits. TypeScript cannot say integer, but the API only ever sends one. */
  credits?: number | null;
  eta_seconds?: number | null;
  /** How far the job has got while it runs. Absent while queued and once settled. */
  progress?: JobProgress | null;
  /** Retained past the ordinary expiry because its owner asked, links and all. */
  kept?: boolean;
  /**
   * Where this job stands with the public gallery, when you have offered it: present while
   * it is being reviewed or shown, absent or null when it is not offered — including after
   * you withdraw it.
   */
  gallery?: GalleryState | null;
  community?: boolean;
  /**
   * Whether an automated check thought this job's images may fall outside what the
   * service allows: the part of your image the job worked on (all of it, unless you
   * named a region), and for some jobs the one that came back. Absent means they were
   * not all checked.
   */
  flagged?: boolean | null;
}

/**
 * A submitted job. Mirrors the API's job representation field for field.
 *
 * `credits` is what you were billed, and it is the only figure about cost the API states.
 * For how long a job took, `finishedAt` minus `createdAt` is the wait you actually had,
 * queue included — both are here and both are on the webhook, which states the same fields
 * by the same names.
 *
 * `result` is the whole of what the job produced. Where the model wrote a file,
 * `result.output` carries its links, and `outputUrl` / `downloadUrl` /
 * `contentType` / `outputBytes` read out of it. `outputUrl` and `downloadUrl` are the same
 * object signed two ways: one to display, one to hand a person as a file. The disposition
 * is signed in, so the second cannot be derived from the first without the storage
 * credential. Both are presigned and expire — fetch the result rather than storing the link.
 *
 * `thumbnailUrl` is a small JPEG of the job's picture — the result, or the image the model
 * worked from when it produced no file — for showing a page of jobs without downloading a
 * page of full-size pictures. `inputUrl` is the picture the model worked from, so a result
 * can be shown against what it was made from. Both expire with the job's other pictures.
 *
 * `etaSeconds` is the whole of what is reported about waiting: how long until the result,
 * counting time spent waiting for a GPU as well as time spent on one. An estimate and never
 * a promise — read it as guidance, not a deadline. Absent once a job has settled.
 *
 * `progress` is how far a running job has got: its stage, and roughly what fraction of the
 * run is done — an estimate that never reaches 1 before the job finishes, and null when none
 * holds. Null while the job is queued and once it has settled.
 *
 * `community` says the job is on the community queue, which runs on shared, free capacity —
 * so it waits longer at busy times, and never stops. That is where an account's work goes
 * when it is not paying, by holding credit or by subscribing. An empty balance is never itself
 * a reason to refuse a job — paying moves work onto paid compute that scales with demand, not
 * the right to submit — but on some models the community queue takes smaller files.
 * `models()` lists each model's limits for your key, and a file over them is refused with
 * the limit named.
 */
export class Job {
  constructor(private readonly data: JobData) {}

  get id() { return this.data.id; }
  get model() { return this.data.model; }
  get status() { return this.data.status; }
  get error() { return this.data.error ?? null; }
  /** The stable half of `error`. Branch on this; show the other. */
  get errorCode() { return this.data.error_code ?? null; }
  get credits() { return this.data.credits ?? null; }
  get etaSeconds() { return this.data.eta_seconds ?? null; }
  get progress() { return this.data.progress ?? null; }
  /** Your own name for this job, or null if you did not send one. */
  get customId() { return this.data.custom_id ?? null; }
  // Defaulted rather than nulled: a server too old to send the field is not running a
  // community queue at all, so its jobs are paid work.
  get community() { return this.data.community ?? false; }
  // Nulled rather than defaulted, unlike `community` above: absent means the image was not
  // checked, and `false` would say it was checked and cleared. The two are different
  // answers and only one of them is true.
  get flagged() { return this.data.flagged ?? null; }
  /** Retained past the ordinary expiry because you asked. */
  get kept() { return this.data.kept ?? false; }
  /** A small JPEG of the job's picture, for a listing. Null where there is none. */
  get thumbnailUrl() { return this.data.thumbnail_url ?? null; }
  /** Where this job stands with the public gallery, or null when it is not offered. */
  get gallery() { return this.data.gallery ?? null; }
  /** The whole answer, including where the file is when there is one. */
  get result() { return this.data.result ?? null; }
  /**
   * The `output` section of the result, or an empty object.
   *
   * Empty both for a job that has not finished and for one whose model produces no file at
   * all — a detector's answer is entirely `result` fields. The accessors below therefore
   * return null rather than throwing: "no file yet" and "never going to be one" is the
   * caller's distinction to draw from `status`, not this library's.
   */
  private get output(): Record<string, unknown> {
    const out = (this.data.result ?? {})["output"];
    return (out && typeof out === "object") ? out as Record<string, unknown> : {};
  }

  get outputUrl() { return (this.output["url"] as string) ?? null; }
  /**
   * The same object signed to save rather than display. Not derivable from `outputUrl`:
   * the disposition is signed in, so re-signing needs the storage credential.
   */
  get downloadUrl() { return (this.output["download_url"] as string) ?? null; }
  /**
   * A link to the picture the model worked from. Where you named a region, this is that
   * region — so what was used is something you can look at rather than something to take on
   * trust. It is not the file you uploaded: yours stays yours and is removed on its own
   * schedule.
   *
   * Null for a job that has not finished. A model that answers about a picture rather than
   * producing one has it too: it is the picture that answer is about.
   */
  get inputUrl() {
    const given = (this.data.result ?? {})["input"];
    return (given && typeof given === "object")
      ? ((given as Record<string, unknown>)["url"] as string) ?? null
      : null;
  }
  get contentType() { return (this.output["content_type"] as string) ?? null; }
  get outputBytes() { return (this.output["bytes"] as number) ?? null; }

  /** Null when absent or unparseable — never a bad Date, which compares false to itself. */
  get createdAt(): Date | null { return this.moment(this.data.created_at); }

  /** When the job settled, or null while it is still queued or running. */
  get finishedAt(): Date | null { return this.moment(this.data.finished_at); }

  private moment(value: string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  get succeeded() { return this.data.status === "succeeded"; }
  get done() { return this.data.status === "succeeded" || this.data.status === "failed"; }

  /** Download the result. */
  async blob(): Promise<Blob> {
    const url = this.outputUrl;
    if (!url) throw new CraterViewError(this.noFile(), undefined, undefined, this.id);
    const resp = await fetch(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    // A link is as old as the read that brought it, and storage answers one past its expiry
    // with 403 — so that is what a 403 almost always is, and a fresh read the fix.
    if (resp.status === 403) {
      throw new CraterViewError(`storage refused the result of job ${this.id} (HTTP 403): its `
        + `link has most likely expired. Read the job again, cv.job("${this.id}"), for fresh `
        + `links.`, 403, undefined, this.id);
    }
    if (!resp.ok) {
      throw new CraterViewError(`storage refused the result of job ${this.id}: HTTP `
        + `${resp.status}`, resp.status, undefined, this.id);
    }
    return await resp.blob();
  }

  /** Why there is no file to download, which depends on where the job stands. */
  private noFile(): string {
    if (!this.done) {
      return `job ${this.id} has no result yet: it is still ${this.status}. Wait for it with `
        + `waitFor() first.`;
    }
    if (this.status === "failed") {
      const code = this.errorCode ? ` (${this.errorCode})` : "";
      return `job ${this.id} failed, so it has no result: `
        + `${this.error ?? "no reason was given"}${code}`;
    }
    // Succeeded, with no file. Either its model answers in `result` alone, or the file has
    // gone; a job read after its files expire looks the same as one that never had any, so
    // both are said rather than one guessed at.
    return `job ${this.id} has no file to download: its model answers in \`result\` alone, `
      + "or its file has expired or been deleted";
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return await (await this.blob()).arrayBuffer();
  }
}

export interface CraterViewOptions {
  apiKey?: string;
  baseUrl?: string;
  /**
   * Milliseconds to wait for the API to answer a request before giving up, 60 000 by default.
   * A request that times out throws the runtime's `TimeoutError`, not a `CraterViewError`:
   * nothing answered, so it is one to repeat with the same idempotency key — except from
   * `run()`, which uploads afresh each time, where the message says to look in `jobs()` for
   * the job instead. Uploads and downloads go to storage and are given five minutes whatever
   * this says.
   */
  timeoutMs?: number;
}

/** How long a transfer to or from storage may take, however large the picture. */
const TRANSFER_TIMEOUT_MS = 300_000;

/**
 * Width × height ÷ 10⁶ from the file's header, or `undefined` for a file the reader does not
 * know. Reads the first megabyte only — every format's dimensions sit near the front, and a
 * Blob of any size costs one bounded copy — and never throws: a size the client cannot read
 * is simply not declared.
 */
async function megapixelsOf(blob: Blob): Promise<number | undefined> {
  try {
    const head = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
    const { width, height } = imageSize(head);
    if (!width || !height) return undefined;
    return Math.round((width * height) / 1e6 * 1e4) / 1e4 || undefined;
  } catch {
    return undefined;
  }
}

export interface SubmitOptions {
  wait?: number;
  idempotencyKey?: string;
  /**
   * Where to POST the signed callback once this job settles. An absolute `http` or `https`
   * URL — anything else is refused when you submit, rather than becoming a delivery that
   * fails somewhere you cannot see.
   */
  webhookUrl?: string;
  /**
   * Your own name for this job, returned on every read of it and on the webhook. Named here
   * rather than swept up by the index signature below on purpose: anything left to that
   * becomes a model parameter, is checked against the model's schema, and would be refused.
   */
  customId?: string;
  /**
   * The size of the file you uploaded, in megapixels (width × height ÷ 1,000,000). Used
   * only to estimate `eta_seconds` for your image rather than for a typical one — it does
   * not affect the price, the queue or whether the job is accepted, all of which read the
   * file itself. Left unset, the size `upload()` read from the file is sent for a key this
   * client uploaded; set it to override or to supply one for a key uploaded elsewhere.
   */
  inputMegapixels?: number;
  model?: string;
  [param: string]: unknown;
}

/**
 * The API's `detail` as one sentence, or `undefined` where it holds no words.
 *
 * Usually a string. A request its validator refuses comes back as a list instead, one entry
 * per field, which reads here as "field: what is wrong" — and without the validator's own
 * "Value error, " in front of a sentence the API wrote for a reader.
 */
function spoken(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail || undefined;
  if (!Array.isArray(detail)) return undefined;
  const said = detail
    .filter((e): e is { loc?: unknown[]; msg: string } => typeof e?.msg === "string" && !!e.msg)
    .map(({ loc, msg }) => {
      const message = msg.replace(/^Value error, /, "");
      // A location of one part — the body as a whole — names no field worth printing.
      return Array.isArray(loc) && loc.length > 1 ? `${loc[loc.length - 1]}: ${message}` : message;
    });
  return said.join("; ") || undefined;
}

export class CraterView {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  // What `upload()` read from each file's header, by the key it came back with, so a later
  // `submit()` of that key declares the size without the caller carrying it. Bounded: a
  // long-lived client uploading thousands of files keeps the most recent few hundred.
  private readonly sizes = new Map<string, number>();

  constructor(options: CraterViewOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.headers = { "User-Agent": `craterview-ts/${VERSION}` };
    if (options.apiKey) this.headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  private async request<T>(method: string, path: string, body?: unknown,
                           extraHeaders: Record<string, string> = {}): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method,
      headers: { ...this.headers, ...extraHeaders,
                 ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    const traceId = resp.headers.get("X-Trace-Id") ?? undefined;
    if (!resp.ok) {
      const detail = await this.detail(resp);
      if (resp.status === 429) {
        throw new RateLimited(detail, Number(resp.headers.get("Retry-After") ?? 0), traceId);
      }
      throw new CraterViewError(detail, resp.status, traceId);
    }
    // A 204 carries no body, so asking for JSON throws on a call that succeeded.
    if (resp.status === 204) return undefined as T;
    try {
      return await resp.json() as T;
    } catch {
      throw new CraterViewError(this.notTheApi(resp.status), resp.status, traceId);
    }
  }

  /** The API's own words for a refusal, or a sentence saying the answer was not its. */
  private async detail(resp: Response): Promise<string> {
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return this.notTheApi(resp.status);
    }
    return spoken((body as { detail?: unknown } | null)?.detail) ?? this.notTheApi(resp.status);
  }

  /**
   * For an answer that is not the API's JSON: an error page from something between here and
   * the API, or a `baseUrl` that names something else. Its body is left out — a page of markup
   * buries the one line worth reading.
   */
  private notTheApi(status: number): string {
    const said = `${new URL(this.baseUrl).host} answered HTTP ${status} with something other `
      + "than the API's JSON";
    if (status >= 500) {
      return `${said}: a failure on the way to the API rather than a refusal. Worth repeating — `
        + "with the same idempotency key, for a submission, so it cannot start a second job.";
    }
    if (status === 429) return `${said}.`;
    return `${said}; check that baseUrl is the API's address (${DEFAULT_BASE_URL} by default).`;
  }

  /**
   * Available models: parameter schemas, prices, limits, and which queue you are on.
   *
   * Prices are published here, so the cost of a job is knowable before submitting it.
   *
   * `community` and the limits are answered **for the queue your key would use**. The API
   * looks up the account's standing and reports the queue a job from this key would land
   * in — so two keys asking at the same moment can get different answers, and paying —
   * credit or a subscription — changes yours.
   *
   * A model that is available is not always listed — a model in trial, or being retired,
   * stays usable by name while absent from this catalog.
   */
  async models(): Promise<ModelInfo[]> {
    return await this.request("GET", "/v1/models") as ModelInfo[];
  }

  /**
   * Put an image in storage and return its key. Bytes go straight to object storage on a
   * presigned URL, never through the API.
   *
   * The image's size is read from its header on the way past and remembered against the
   * key, so `submit()` can tell the API what you sent and `eta_seconds` is estimated for
   * your image rather than a typical one. A file the reader does not know is uploaded just
   * the same; only the estimate is less specific.
   *
   * The type sent is `contentType` when given, else the one the bytes' signature shows, else
   * the Blob's own, else none — an undeclared upload is accepted and identified when the job
   * runs. The bytes come before the Blob's type because that is usually read off the file's
   * name, and a misnamed file is then refused here rather than as a job. A type the API does not take is refused by the first request, before any
   * bytes are sent, with the list of what it does take.
   */
  async upload(image: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<string> {
    const blob = image instanceof Blob ? image : new Blob([image as BlobPart]);
    // Sent, it would come back as a refusal of `content_length`, a field the caller never
    // wrote. Said here in their terms instead, before anything is requested.
    if (!blob.size) {
      throw new CraterViewError("the image given is empty (0 bytes): there is nothing to upload");
    }
    const type = contentType || await sniffType(blob) || blob.type || "application/octet-stream";

    // Declared, then signed into the URL, so it has to be the size actually sent — storage
    // refuses any other with a signature error. Taken from the Blob rather than trusted from
    // a caller: it is the same object the PUT below sends.
    const slot = await this.request<{ input_key: string; upload_url: string }>(
      "POST", "/v1/uploads", { content_type: type, content_length: blob.size });

    const put = await fetch(slot.upload_url, {
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      method: "PUT", body: blob, headers: { "Content-Type": type },
    });
    if (!put.ok) throw new CraterViewError(`upload failed: ${put.status}`, put.status);
    const megapixels = await megapixelsOf(blob);
    if (megapixels) {
      if (this.sizes.size >= 512) this.sizes.delete(this.sizes.keys().next().value!);
      this.sizes.set(slot.input_key, megapixels);
    }
    return slot.input_key;
  }

  /**
   * Queue a job. `wait` holds the response open for a settled result, for up to that many
   * seconds; the API holds one for at most 30, so a longer wait is asked as 30.
   *
   * Pass `idempotencyKey` — see `newIdempotencyKey` — if you intend to retry this
   * submission. Without one, a repeat after a failed or uncertain request starts a second
   * job and is billed for both.
   */
  async submit(inputKey: string, options: SubmitOptions = {}): Promise<Job> {
    const { wait = 0, idempotencyKey, webhookUrl, customId, inputMegapixels,
            model = "cv-enhance-v3", ...params } = options;
    const declared = inputMegapixels ?? this.sizes.get(inputKey);
    // Annotated, not inferred: without this the two branches unify to a type whose key
    // may be `undefined`, which is not assignable to Record<string, string>.
    const headers: Record<string, string> = idempotencyKey
      ? { "Idempotency-Key": idempotencyKey }
      : {};
    // Held to the API's ceiling, so a longer wait is a long poll rather than a refusal. None at
    // all is the API's own default, and is left unsaid.
    const held = Math.min(wait, MAX_SERVER_WAIT);
    const path = held > 0 ? `/v1/jobs?wait=${held}` : "/v1/jobs";
    const data = await this.request<JobData>("POST", path, {
      model, input_key: inputKey, params,
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      ...(customId ? { custom_id: customId } : {}),
      ...(declared && declared > 0 ? { input_megapixels: declared } : {}),
    }, headers);
    return new Job(data);
  }

  /**
   * One job, by the `id` the API gave it. Anything that is not a job id throws a
   * `CraterViewError` without a request being made.
   */
  async job(id: string): Promise<Job> {
    return new Job(await this.request<JobData>("GET", `/v1/jobs/${issued("job", id, "id")}`));
  }

  /**
   * The account's job history, newest first, paging transparently.
   *
   * Scoped to the account rather than to this key, so a key sees every job the account has
   * run and not only the ones it submitted itself.
   *
   * `limit` is how many jobs one request fetches, not how many you get: iteration continues
   * until the history runs out. 200 is the largest page the API serves, and a bigger number
   * is fetched as 200 rather than sent and refused.
   */
  async *jobs(options: { limit?: number; status?: JobStatus } = {}): AsyncGenerator<Job> {
    let before: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        limit: String(Math.min(options.limit ?? 50, MAX_PAGE)),
      });
      if (options.status) params.set("status", options.status);
      if (before) params.set("before", before);

      const page = await this.request<{ data: JobData[]; has_more: boolean; next_before?: string }>(
        "GET", `/v1/jobs?${params}`);
      for (const item of page.data) yield new Job(item);
      if (!page.has_more || !page.next_before) return;
      // A cursor that does not advance would loop forever, hammering the API from inside
      // the caller's app with no error to show for it. Stop instead.
      if (page.next_before === before) return;
      before = page.next_before;
    }
  }

  /**
   * The account's credit balance, what it has spent, and what is in flight.
   *
   * All-time, not monthly: credits are granted and deplete rather than renewing. A job is
   * charged when it succeeds, so queued and running work is not in the figures yet, and a
   * failed job costs nothing.
   *
   * `credits_remaining` is always a number, floored at zero. `jobs_in_flight` and
   * `max_jobs_in_flight` are the state of the queue and are what a 429 on submit is about.
   *
   * Account-wide, so every key on an account reports the same figures.
   */
  async usage(): Promise<unknown> {
    return await this.request("GET", "/v1/usage");
  }

  /**
   * The secret your callbacks are signed with, created the first time you ask.
   *
   * Pass it to {@link verifyWebhook}. Unlike an API key this can be read back whenever you
   * need it — but treat it as a credential all the same: anyone holding it can produce a
   * delivery your receiver will accept as genuine.
   */
  async webhookSecret(): Promise<string> {
    const body = await this.request("GET", "/v1/webhooks/secret") as { secret: string };
    return body.secret;
  }

  /**
   * Replace the signing secret and return the new one.
   *
   * The secret you were using keeps being sent alongside it for a window, so deliveries in
   * that period carry a signature under each and {@link verifyWebhook} accepts either.
   * Deploy the new one whenever suits; nothing fails in between.
   */
  async rotateWebhookSecret(): Promise<string> {
    const body = await this.request("POST", "/v1/webhooks/secret/rotate") as { secret: string };
    return body.secret;
  }

  /**
   * Every key on the account, including revoked ones, by prefix rather than value, newest
   * first. The API serves the list a page at a time; this fetches every page and returns them
   * together.
   */
  async keys(): Promise<KeyInfo[]> {
    const found: KeyInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ limit: String(MAX_PAGE) });
      if (before) params.set("before", before);
      const page = await this.request<{ data: KeyInfo[]; has_more: boolean; next_before?: string }>(
        "GET", `/v1/keys?${params}`);
      found.push(...page.data);
      // As in `jobs`: a missing or non-advancing cursor stops rather than spinning.
      if (!page.has_more || !page.next_before || page.next_before === before) return found;
      before = page.next_before;
    }
  }

  /**
   * Mint another key. **The value is in this response and nowhere else** — keys are stored
   * as hashes, so one that is not written down has to be replaced rather than recovered.
   *
   * Several keys on an account is the ordinary arrangement, one per service or environment.
   * They share the account's credits and history. This is also how you rotate without
   * downtime: create the new key, move your clients onto it, then revoke the old one.
   *
   * An account is given a limited number of new keys an hour, whichever of its keys asks:
   * past it this throws `RateLimited`, whose `retryAfter` says when to ask again.
   */
  async createKey(name = "api"): Promise<NewKey> {
    return await this.request("POST", "/v1/keys", { name }) as NewKey;
  }

  /**
   * Stop a key working. Immediate, and not reversible.
   *
   * You cannot revoke the key this client is authenticating with: it is refused with status
   * 409, because it would leave you unable to make another. Create a replacement, move onto
   * it, then revoke this one.
   *
   * `keyId` is a key's `id` from `keys()` or `createKey()`, never its value or its prefix.
   * Anything else throws a `CraterViewError` without a request being made.
   */
  async revokeKey(keyId: string): Promise<void> {
    await this.request("DELETE", `/v1/keys/${issued("key", keyId, "keyId")}`);
  }

  /**
   * Wait until a job settles. Prefer `wait` on submit for short jobs.
   *
   * Past `timeoutMs` this throws a `CraterViewError` with the job's `jobId`. Only the wait has
   * ended: the job carries on, and is collected by calling this again with that id.
   *
   * A read that gets no answer, a failure on the way to the API or a request to slow down is
   * not the job's, and the wait goes on through it until `timeoutMs`. A refusal it throws
   * carries the `jobId` too, so no failure here loses the job.
   */
  async waitFor(job: Job | string, timeoutMs = 600_000, pollMs = 1000): Promise<Job> {
    const id = issued("job", typeof job === "string" ? job : job.id, "job");
    let current = typeof job === "string" ? undefined : job;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        current = await this.job(id);
      } catch (e) {
        if (e instanceof RateLimited || worthAskingAgain(e)) {
          await pause(Math.max(pollMs, ((e as RateLimited).retryAfter ?? 0) * 1000));
          continue;
        }
        if (e instanceof CraterViewError && !e.jobId) {
          throw new CraterViewError(e.message, e.status, e.traceId, id);
        }
        throw e;
      }
      if (current.done) return current;
      await pause(pollMs);
    }
    const where = current ? `still ${current.status}` : "not finished";
    throw new CraterViewError(`job ${id} is ${where} after ${timeoutMs / 1000}s of waiting. It `
      + "has not failed: it carries on, and is charged only if it succeeds. Collect it with "
      + `waitFor("${id}") or job("${id}"); submitting the request again starts a second job, `
      + "charged as well.", undefined, undefined, id);
  }

  /**
   * Upload, submit and wait, in one call — the common case. Uses server-side waiting
   * first so a fast job costs a single round trip, then polls for anything slower. The
   * server is asked to hold the submission for at most half this client's own `timeoutMs`,
   * so its answer arrives before the client stops listening for it.
   *
   * Past `timeoutMs` the job is not given up on, only waited for: the error carries its
   * `jobId`, to collect it by with `waitFor`.
   *
   * **One submission, asked at most twice.** A submission that got no answer, or met a failure
   * on the platform's side, may have made the job before it failed, so it is asked once more
   * under one idempotency key, and the API answers with the job the first attempt made if it
   * made one — never a second. Pass `idempotencyKey` to choose the key. Refused both times by
   * the API's own 503, which it answers before anything is recorded, the error says so in its
   * words.
   */
  async run(image: Blob | ArrayBuffer | Uint8Array,
                options: SubmitOptions & { timeoutMs?: number } = {}): Promise<Job> {
    const { timeoutMs = 600_000, wait = MAX_SERVER_WAIT, idempotencyKey = newIdempotencyKey(),
            ...rest } = options;
    const inputKey = await this.upload(image);
    const submitted = () => this.submit(inputKey, {
      ...rest, idempotencyKey, wait: Math.min(wait, this.timeoutMs / 2000) });
    let job: Job;
    let first: unknown;
    try {
      try {
        job = await submitted();
      } catch (e) {
        if (!worthAskingAgain(e)) throw e;
        first = e;
        await pause(RESUBMIT_AFTER_MS);
        job = await submitted();
      }
    } catch (e) {
      if (!worthAskingAgain(e)) throw e;
      if (queuedNothing(first) && queuedNothing(e)) {
        const refused = e as CraterViewError;
        throw new CraterViewError(
          `the submission was asked twice, and both times CraterView said why: ${refused.message}`,
          refused.status, refused.traceId);
      }
      // Thrown as the kind it was, so a caller telling no answer from a refusal by type sees
      // what it saw before. Only the advice changes: run() uploads afresh each time.
      const said = `the submission was asked twice and answered neither time `
        + `(${(e as Error).message}), so a job may have been made; if it was, it runs and is `
        + "charged only if it succeeds. Look for it with jobs(), newest first, before running "
        + "this again: run() uploads afresh, so repeating it starts a second job.";
      if (e instanceof CraterViewError) throw new CraterViewError(said, e.status, e.traceId);
      if ((e as Error).name === "TimeoutError") throw new DOMException(said, "TimeoutError");
      throw new TypeError(said);
    }
    if (!job.done) job = await this.waitFor(job, timeoutMs);
    if (!job.succeeded) {
      throw new JobFailed(job.error ?? "job failed", job.errorCode ?? undefined, job.id);
    }
    return job;
  }
}
