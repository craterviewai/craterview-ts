/**
 * CraterView.ai TypeScript client.
 *
 *   import { CraterView } from "craterview";
 *
 *   const cv = new CraterView({ apiKey: "cv_..." });
 *   const job = await cv.run(file, { style: "photo" });
 *   const blob = await job.blob();
 *
 * Zero dependencies: fetch and Blob are standard in Node 18+ and every browser, so the
 * client stays installable anywhere without dragging a transitive tree behind it.
 *
 * **This file is published.** It goes to GitHub and npm, and `main` points at the source, so
 * every comment here ships and a doc-comment on an exported member appears in a consumer's
 * editor. Write for someone who can see this package and nothing else: what the client does
 * and what a caller has to know, never how the service behind it is built.
 */

// Mirrored from package.json, which is the number a release bumps. It cannot be imported
// from there — this ships as TypeScript, so the import would have to resolve in the
// consumer's toolchain — so test/version.test.ts asserts the two agree.
export const VERSION = "0.1.1";
const DEFAULT_BASE_URL = "https://api.craterview.ai";
// The server rejects a longer wait outright, so asking for one costs a 422 rather than a
// longer wait. Keep in step with MAX_WAIT_SECONDS in the gateway.
const MAX_SERVER_WAIT = 30;

/**
 * A random key for safely repeating a submission.
 *
 * Generate one per *logical request* and reuse it for every attempt at that request:
 *
 *   const key = newIdempotencyKey();          // once, before the first attempt
 *   for (let attempt = 0; attempt < 3; attempt++) {
 *     try {
 *       job = await cv.submit(inputKey, { idempotencyKey: key, style: "photo" });
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
 * This client does not retry on your behalf. The loop above is yours to write.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(24);
  // Present in Node 18+ and every browser. Math.random is not a substitute: two clients
  // starting together would draw the same sequence and collide on the server.
  globalThis.crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `idem_${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export class CraterViewError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CraterViewError";
  }
}

/**
 * 429 — too fast, or too much at once. Two different limits answer with this: the key's
 * request rate, and the account's cap on jobs queued or running at the same time, which
 * exists so one caller cannot occupy the whole fleet.
 *
 * `retryAfter` is seconds to wait, and how good a number it is depends on which limit you
 * hit: exact for the rate limit, where it is when the window rolls over, and a hint for
 * the in-flight cap, where a slot frees when one of your own jobs finishes and the server
 * can only quote the model's typical duration. `usage()` reports the cap and what you
 * currently hold against it.
 */
export class RateLimited extends CraterViewError {
  constructor(message: string, readonly retryAfter?: number) {
    super(message, 429);
    this.name = "RateLimited";
  }
}

/**
 * The job ran and did not succeed.
 *
 * `message` says what you can do about it and `errorCode` is the half to branch on, because
 * the prose is written for a person and gets reworded. `inference_failed` means the fault was
 * ours, the credits were refunded, and the same call is worth making again.
 *
 * An unfamiliar code is a failure with no special handling, not an error in itself: new ones
 * appear as new things become worth telling apart.
 */
export class JobFailed extends CraterViewError {
  constructor(message: string, readonly errorCode?: string) {
    super(message);
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
export class InvalidSignature extends CraterViewError {}

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
 * re-serialising it changes the bytes the signature was computed over. In Express that means
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

  const signature = readHeader(headers, SIGNATURE_HEADER);
  const timestamp = readHeader(headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    throw new InvalidSignature("delivery is missing its signature headers");
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    throw new InvalidSignature("delivery has an unreadable timestamp");
  }
  // Both directions. A clock ahead of ours is as much a reason to distrust a delivery as one
  // behind it, and only checking the past accepts anything dated next year.
  const age = Date.now() / 1000 - sentAt;
  if (toleranceSeconds && Math.abs(age) > toleranceSeconds) {
    throw new InvalidSignature(`delivery is ${age.toFixed(0)}s out of date`);
  }

  const bytes = toBytes(body);
  const signed = new Uint8Array(timestamp.length + 1 + bytes.length);
  signed.set(new TextEncoder().encode(`${timestamp}.`), 0);
  signed.set(bytes, timestamp.length + 1);

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
 * One entry from the model catalogue, exactly as it arrives. Snake case is the wire's, as
 * with `JobData` — there is no wrapper class here because there is no behaviour to add.
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
  max_input_bytes: number;
  /**
   * The ceilings **your key** is held to, not the model's widest. Community work is bounded
   * more tightly than paid work, so these move when `community` below does — check them
   * before uploading rather than learning them from a rejected job.
   *
   * Two axes, and they are the two a job is made of. `max_frame_megapixels` bounds one
   * frame, which is what a GPU actually holds, and applies to images too since a still is one
   * frame. `max_frames` bounds how many frames one job may carry. Zero means that axis is
   * unbounded for you.
   *
   * For a duration, divide: `max_frames / reference_fps` is the longest clip you may send, in
   * seconds. It is not published as its own field on purpose — one limit with two spellings
   * is one that can disagree with itself, and frames are what the platform counts, enforces
   * and bills on.
   */
  max_frame_megapixels: number;
  max_frames: number;
  /** Whole credits. The price is flat and knowable before you send anything. */
  credits_per_image: number;
  /** Whole credits. Null means this model takes stills only. */
  credits_per_video_second?: number | null;
  reference_fps: number;
  params_schema: Record<string, unknown>;
  /**
   * Work ahead of you **on the queue your key would use** — not a platform-wide total.
   * Read it with `community`, which says which queue that is.
   */
  queue_depth: number;
  /**
   * Whether your key's work goes to the community queue, which is served after priority
   * work and takes a small share of it. False once the account holds credit.
   *
   * The same field, meaning the same thing, as `Job.community` — these are the two places
   * the API describes a wait, and they describe it the same way.
   */
  community: boolean;
  /** Of `params_schema`, the ones that apply to still images only. */
  image_only_params: string[];
  /** A representative job, for sizing a progress indicator before any eta arrives. */
}

/** One key on the account. Never the key itself — only the prefix, which identifies it. */
export interface KeyInfo {
  id: string;
  /** The first few characters. Enough to tell one key from another, not enough to use. */
  prefix: string;
  name: string;
  created_at: string | null;
  /** When it stopped working, or null while it still does. */
  revoked_at: string | null;
  rate_limit_per_minute: number;
  /** Whether this is the key you are calling with. It cannot be revoked while it is. */
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

/** The body of a callback, once {@link verifyWebhook} has checked it came from us. */
export interface WebhookEvent {
  id: string;
  custom_id: string | null;
  model: string | null;
  status: JobStatus;
  error: string | null;
  error_code: string | null;
  community: boolean;
  credits: number | null;
  created_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

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
  input_url?: string | null;
  /** Whole credits. TypeScript cannot say integer, but the API only ever sends one. */
  credits?: number | null;
  eta_seconds?: number | null;
  /** Retained past the ordinary expiry because its owner asked, links and all. */
  kept?: boolean;
  community?: boolean;
  /**
   * Whether an automated check thought this image may fall outside what the service
   * allows. Absent means it was not checked.
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
 * `result.output` carries its links, and `outputUrl` / `downloadUrl` / `thumbUrl` /
 * `contentType` / `outputBytes` read out of it. `outputUrl` and `downloadUrl` are the same
 * object signed two ways: one to display, one to hand a person as a file. The disposition
 * is signed in, so the second cannot be derived from the first without the storage
 * credential. Both are presigned and expire — fetch the result rather than storing the link.
 *
 * `thumbUrl` is a small JPEG of the result, for showing a page of jobs without downloading
 * a page of full-size outputs. `inputUrl` is the file you sent, so a result can be shown
 * against what it was made from. The two expire on very different clocks: the preview goes
 * with the result, while inputs are deleted after a day — much sooner than the output — so
 * `inputUrl` is null for most of a job's life and code that reads it should expect nothing
 * there.
 *
 * `etaSeconds` is the whole of what is reported about waiting: how long until the result,
 * counting time spent waiting for a GPU as well as time spent on one. An estimate and never
 * a promise — read it as guidance, not a deadline. Absent once a job has settled.
 *
 * `community` says the job was submitted against a balance of zero and is on the queue
 * served after priority work, which takes a small share of it rather than only what is left.
 * Nothing is refused for want of credit — credit buys a place at the front of the queue, not
 * the right to submit — so an empty balance means a longer wait and never an error.
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
  /** Your own name for this job, or null if you did not send one. */
  get customId() { return this.data.custom_id ?? null; }
  // Defaulted rather than nulled: a gateway too old to send the field is not running a
  // community queue at all, so its jobs are paid work.
  get community() { return this.data.community ?? false; }
  // Nulled rather than defaulted, unlike `community` above: absent means the image was not
  // checked, and `false` would say it was checked and cleared. The two are different
  // answers and only one of them is true.
  get flagged() { return this.data.flagged ?? null; }
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
  get thumbUrl() { return (this.output["thumbnail_url"] as string) ?? null; }
  get inputUrl() { return this.data.input_url ?? null; }
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
    if (!url) {
      throw new CraterViewError(`job ${this.id} has no result (status ${this.status})`);
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new CraterViewError(`downloading result failed: ${resp.status}`);
    return await resp.blob();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return await (await this.blob()).arrayBuffer();
  }
}

export interface CraterViewOptions {
  apiKey?: string;
  baseUrl?: string;
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
  model?: string;
  [param: string]: unknown;
}

export class CraterView {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: CraterViewOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.headers = { "User-Agent": `craterview-ts/${VERSION}` };
    if (options.apiKey) this.headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  private async request<T>(method: string, path: string, body?: unknown,
                           extraHeaders: Record<string, string> = {}): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.headers, ...extraHeaders,
                 ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const detail = await this.detail(resp);
      if (resp.status === 429) {
        throw new RateLimited(detail, Number(resp.headers.get("Retry-After") ?? 0));
      }
      throw new CraterViewError(detail, resp.status);
    }
    // A 204 carries no body, so asking for JSON throws on a call that succeeded.
    if (resp.status === 204) return undefined as T;
    return await resp.json() as T;
  }

  private async detail(resp: Response): Promise<string> {
    try {
      const body = await resp.json() as { detail?: string };
      return body.detail ?? `HTTP ${resp.status}`;
    } catch {
      return `HTTP ${resp.status}`;
    }
  }

  /**
   * Available models: parameter schemas, prices, limits, and your queue.
   *
   * Prices are published here, so the cost of a job is knowable before submitting it.
   *
   * Needs a key, and not only because the figures are live: `queue_depth` and `community`
   * are answered **for the queue your key would use**. The API looks up the account's
   * balance and reports the queue a job from this key would land in — so two keys asking
   * at the same moment can get different numbers, and buying credit changes yours.
   *
   * A model that is available is not always listed — a model in trial, or being retired,
   * stays usable by name while absent from this catalogue.
   */
  async models(): Promise<ModelInfo[]> {
    return await this.request("GET", "/v1/models") as ModelInfo[];
  }

  /**
   * Put an image in storage and return its key. Bytes go straight to object storage on a
   * presigned URL, never through the API.
   */
  async upload(image: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<string> {
    const blob = image instanceof Blob
      ? image
      : new Blob([image as BlobPart], { type: contentType ?? "image/png" });
    const type = contentType ?? blob.type ?? "image/png";

    // Declared, then signed into the URL, so it has to be the size actually sent — storage
    // refuses any other with a signature error. Taken from the Blob rather than trusted from
    // a caller: it is the same object the PUT below sends.
    const slot = await this.request<{ input_key: string; upload_url: string }>(
      "POST", "/v1/uploads", { content_type: type, content_length: blob.size });

    const put = await fetch(slot.upload_url, {
      method: "PUT", body: blob, headers: { "Content-Type": type },
    });
    if (!put.ok) throw new CraterViewError(`upload failed: ${put.status}`);
    return slot.input_key;
  }

  /**
   * Queue a job. `wait` holds the response open for a settled result.
   *
   * Pass `idempotencyKey` — see `newIdempotencyKey` — if you intend to retry this
   * submission. Without one, a repeat after a failed or uncertain request starts a second
   * job and is billed for both.
   */
  async submit(inputKey: string, options: SubmitOptions = {}): Promise<Job> {
    const { wait = 0, idempotencyKey, webhookUrl, customId, model = "cv-restore-v1",
            ...params } = options;
    // Annotated, not inferred: without this the two branches unify to a type whose key
    // may be `undefined`, which is not assignable to Record<string, string>.
    const headers: Record<string, string> = idempotencyKey
      ? { "Idempotency-Key": idempotencyKey }
      : {};
    const data = await this.request<JobData>("POST", `/v1/jobs?wait=${wait}`, {
      model, input_key: inputKey, params,
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      ...(customId ? { custom_id: customId } : {}),
    }, headers);
    return new Job(data);
  }

  async job(id: string): Promise<Job> {
    return new Job(await this.request<JobData>("GET", `/v1/jobs/${id}`));
  }

  /**
   * The account's job history, newest first, paging transparently.
   *
   * Scoped to the account rather than to this key, so a key sees every job the account has
   * run and not only the ones it submitted itself.
   */
  async *jobs(options: { limit?: number; status?: JobStatus } = {}): AsyncGenerator<Job> {
    let before: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
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
   * All-time, not monthly: credits are granted and deplete rather than renewing. Counts
   * committed work rather than completed, so a queued job is already in the figures —
   * otherwise this and the balance a submission is checked against would disagree.
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

  /** Every key on the account, including revoked ones, by prefix rather than value. */
  async keys(): Promise<KeyInfo[]> {
    return await this.request("GET", "/v1/keys") as KeyInfo[];
  }

  /**
   * Mint another key. **The value is in this response and nowhere else** — keys are stored
   * as hashes, so one that is not written down has to be replaced rather than recovered.
   *
   * Several keys on an account is the ordinary arrangement, one per service or environment.
   * They share the account's credits and history. This is also how you rotate without
   * downtime: create the new key, move your clients onto it, then revoke the old one.
   */
  async createKey(name = "api"): Promise<NewKey> {
    return await this.request("POST", "/v1/keys", { name }) as NewKey;
  }

  /**
   * Stop a key working. Immediate, and not reversible.
   *
   * You cannot revoke the key this client is authenticating with — the call would succeed
   * and leave you unable to make another.
   */
  async revokeKey(keyId: string): Promise<void> {
    await this.request("DELETE", `/v1/keys/${encodeURIComponent(keyId)}`);
  }

  async waitFor(job: Job | string, timeoutMs = 600_000, pollMs = 1000): Promise<Job> {
    const id = typeof job === "string" ? job : job.id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.job(id);
      if (current.done) return current;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new CraterViewError(`job ${id} did not finish within ${timeoutMs}ms`);
  }

  /**
   * Upload, submit and wait, in one call — the common case. Uses server-side waiting
   * first so a fast job costs a single round trip, then polls for anything slower.
   */
  async run(image: Blob | ArrayBuffer | Uint8Array,
                options: SubmitOptions & { timeoutMs?: number } = {}): Promise<Job> {
    const { timeoutMs = 600_000, wait = MAX_SERVER_WAIT, ...rest } = options;
    const inputKey = await this.upload(image);
    let job = await this.submit(inputKey, { ...rest, wait: Math.min(wait, MAX_SERVER_WAIT) });
    if (!job.done) job = await this.waitFor(job, timeoutMs);
    if (!job.succeeded) throw new JobFailed(job.error ?? "job failed", job.errorCode ?? undefined);
    return job;
  }
}
