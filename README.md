# craterview

TypeScript client for the [CraterView](https://craterview.ai) image enhancement and
restoration API.

```bash
npm install craterview
```

**The package ships TypeScript source.** `index.ts` is what npm installs — there is no build
step and no compiled JavaScript in the tarball — so whatever compiles your own TypeScript
compiles this too: any bundler, `tsx` or `ts-node`, Bun, Deno, or Node 22.6 and newer with
type stripping (`--experimental-strip-types`, which recent releases enable by default). A
plain JavaScript project invoking `node` directly cannot import it.

The code itself needs Node 18 or newer, or any modern browser. **One runtime dependency**,
[`image-size`](https://www.npmjs.com/package/image-size), pure JavaScript that runs in
both: it reads an image's dimensions from its header — nothing is decoded — so `upload()`
can tell the API how big your file is and `etaSeconds` is estimated for that file rather
than for a typical one. `fetch`, `Blob` and `crypto.getRandomValues` are standard in both.

## Quickstart

```ts
import { CraterView } from "craterview";

const cv = new CraterView({ apiKey: "cv_..." });
const job = await cv.run(file, { scale: 4 });
const blob = await job.blob();
```

`run()` collapses the upload → submit → poll sequence into one call. That sequence is the
API's shape rather than an accident, but it is not something every caller should have to
reimplement.

Build against `echo` first. It costs no credits, needs no GPU and returns a real result — a
plain upscale — so the request, the parameters and the response are the ones a paid model
gives, and your integration needs no change when you switch. When you are ready, swap the
model name for the one you want.

```ts
const job = await cv.run(file, {
  // echo is free, for building against. Swap in a paid model when you are ready —
  // cv-enhance-v3 to enlarge, cv-restore-v1 to repair, cv-headshot-v1 for portraits.
  model: "echo",
  scale: 2, wait: 30,
});
const blob = await job.blob();
```

A parameter one model publishes is not one another accepts — `cv.models()` says which — and
a value a model does not publish is refused at submit rather than ignored.

## An API key

Keys begin with `cv_` and are issued from your dashboard.

```ts
const cv = new CraterView({ apiKey: process.env.CV_API_KEY });
```

A key carries your whole allowance and does not expire. **Do not ship one to a browser** —
it is extractable from anything you send there. Call the API from your server and give the
browser a session instead.

## The one call

```ts
const job = await cv.run(image, {          // Blob | ArrayBuffer | Uint8Array
  model: "cv-enhance-v3",                   // default
  wait: 30,                                // seconds to hold the connection open
  timeoutMs: 600_000,                      // total before giving up
  scale: 4,                                // model parameters pass straight through
});
```

It waits server-side first, so a job that finishes quickly costs a single round trip, then
falls back to polling for anything slower. A job that fails throws `JobFailed`.

Which parameters a model accepts is published by the API rather than hard-coded here — see
`cv.models()`.

## The explicit path

Useful when you want to hold the key, submit later, or fan out.

```ts
const inputKey = await cv.upload(file);                        // → "inputs/..."
let job = await cv.submit(inputKey, { scale: 4 });
job = await cv.waitFor(job, 600_000);
const blob = await job.blob();
```

Image bytes never pass through the API. `upload()` PUTs them straight to object storage on
a presigned URL and `blob()` GETs the result the same way; the API moves keys, not pixels.

## Retries are yours to write

**This client does not retry.** That is deliberate: only the caller knows where one logical
request ends and the next begins, and a retry the client invented would be a second job you
are billed for.

What it gives you instead is a key generator. Make one key per *logical request* and reuse
it for every attempt at that request:

```ts
import { newIdempotencyKey, CraterViewError } from "craterview";

const key = newIdempotencyKey();           // once, before the first attempt
let job;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    job = await cv.submit(inputKey, { idempotencyKey: key, scale: 4 });
    break;
  } catch (e) {
    if (e instanceof CraterViewError) throw e;   // the server answered; do not retry
    continue;                                    // same key, so at most one job is created
  }
}
```

Generating a fresh key per attempt defeats the point entirely — the server has nothing to
match against and every attempt starts its own job. Reusing a key with a *different* body
is rejected with 409 rather than quietly handing back the earlier result. Claims are kept
for as long as the job's record is, which is not deleted; the same key always returns
the same job.

## Errors

Everything thrown by this client extends `CraterViewError`, so one `catch` handles the lot.
`.status` carries the HTTP status where there was one.

| Class | Meaning |
|---|---|
| `RateLimited` | 429. `.retryAfter` is seconds to wait: until the window rolls over for the request rate, or a short fixed interval to poll on for the in-flight cap. |
| `JobFailed` | The job ran and did not succeed. `.message` says what you can do about it; `.errorCode` is the half to branch on. |
| `CraterViewError` | Everything else, including 4xx and 5xx from the API. |

These subclass `Error` under an ES2020 target so `instanceof` works. Compiling this package
down to ES5 silently breaks that, and `catch (e) { if (e instanceof RateLimited) }` — the
exact code you write to handle a 429 — would never match.

## `Job`

Every field the API publishes on a job is exposed here.

| | |
|---|---|
| `id`, `model`, `status` | `status` is one of `queued`, `running`, `succeeded`, `failed` |
| `createdAt` | `Date`, or `null` |
| `succeeded`, `done` | `done` covers both terminal states |
| `error` | Set when the job failed. Safe to show a user |
| `errorCode` | The same fact, as a stable identifier. Branch on this, show the other |
| `credits` | **What you were billed** |
| `etaSeconds` | Seconds until the job is expected to finish, recomputed on every read — it counts down while the job runs. Absent once the job has settled. Estimated for your image's size when `upload()` could read it (or when you pass `inputMegapixels` to `submit()`), for a typical image otherwise |
| `community` | True when the job is on the community queue: served after priority work, always taking a share of it, so it never stalls behind paid work |
| `outputUrl`, `downloadUrl` | The result, presigned. One to display, one to save |
| `thumbUrl` | A small JPEG of the result, for listings. Null when none was drawn |
| `inputUrl` | The file you sent. Null once it has expired — inputs go after a day |
| `contentType` | The result's media type |
| `outputBytes` | The result's size in bytes |
| `blob()`, `arrayBuffer()` | Download the result |

`result` is the whole of what the job produced, and the five rows above it that describe the
file are getters onto `result.output` rather than separate fields — the API states those links
once. A model with no file to hand back returns its answer in `result` and leaves every one of
them null.

`credits` is the only figure about cost the API states, and the price is fixed and published
per model, so an invoice reconciles against `credits` alone. For how long a job took, subtract
`createdAt` from `finishedAt` — that is the wait you had, queue included.

**Uploads declare their size.** `upload()` and `run()` take the length from the `Blob`
they are about to send and declare it; the API signs it into the presigned URL, so storage
accepts exactly that length and nothing else. You do not pass it — it is read off the data
in hand, which is what makes it impossible to get wrong.

**Running out of credit does not stop you.** A job submitted against a balance of zero is
accepted, charged and run — it simply waits in the community queue, which is served after
paid work and always takes a share of it, so it never stalls behind paid work. It comes back
with `community` set. There is no payment error to handle:
paying — with credit, or with a subscription — buys a place at the front of the queue rather
than the right to submit.
`etaSeconds` covers the whole wait, queue time included, so a community job simply reports
a longer one.

`outputUrl` and `downloadUrl` are the same object signed two ways; the content disposition
is signed in, so the second cannot be derived from the first. Both expire, so fetch the
result rather than storing the link.

`thumbUrl` and `inputUrl` are for building a job listing: a few-hundred-pixel preview so a
page of results costs kilobytes, and the original so a result can be shown against what made
it. They keep very different company on expiry — the preview lives as long as the result,
while inputs are deleted a day in — so treat a missing `inputUrl` as normal rather than as an
error.

## Webhooks

Pass `webhookUrl` on submit — an absolute `http` or `https` URL, refused at submit if it is
not one — and we `POST` to it once the job settles. Verify every delivery before you act on
it: anyone who learns your URL can send you a plausible-looking body.

```ts
import { CraterView, verifyWebhook, InvalidSignature } from "craterview";

const secret = await new CraterView({ apiKey: "cv_..." }).webhookSecret();

app.post("/hooks/craterview",
  express.raw({ type: "application/json" }),   // the bytes, not a parsed object
  async (req, res) => {
    let event;
    try {
      event = await verifyWebhook(req.body, req.headers, secret);
    } catch (e) {
      if (e instanceof InvalidSignature) return res.sendStatus(400);
      throw e;
    }

    // Answer now and work afterwards. A slow endpoint is retried while it is still
    // working, so treat deliveries as at-least-once and make this idempotent on `id`.
    res.sendStatus(200);
    await enqueue(event.id);
  });
```

Every copy of a delivery states the same thing, so the first one you accept is the whole
answer — later copies of an `id` you have already handled can be dropped rather than
reconciled.

**Pass the raw body.** Most frameworks parse JSON for you, and re-serializing it changes the
bytes the signature was computed over — hence `express.raw` above.

`verifyWebhook` is async because it uses WebCrypto, which is what lets it run unchanged in
Node, a browser, and edge runtimes without a crypto dependency.

The body is a `WebhookEvent`, which carries the same fields a job read does, by the same names
— including `result` and the links inside it. The one difference is what happens to a field
that does not apply: a callback states every key and sets it `null`, where a job read leaves
it out.

The links expire like any others. A delivery normally arrives within seconds of the job
settling and they are good for an hour, but a subscriber that queues work for later should
read the job again rather than storing them.

### Rotating the secret

```ts
const next = await cv.rotateWebhookSecret();
```

The old secret keeps being sent alongside the new one for a day, and `verifyWebhook` accepts
either — so deploy the new one whenever suits rather than the moment you asked for it.

## Managing keys

```ts
await cv.keys();                  // every key on the account, by prefix; revoked ones stay
await cv.createKey("staging");    // the value is in this response and nowhere else
await cv.revokeKey("key_...");    // immediate, and not reversible
```

Several keys on one account is the ordinary arrangement — one per service or environment, so
revoking one leaves the others working. They share the account's credits and history.

To rotate without downtime: create the new key, move your clients onto it, then revoke the
old one. You cannot revoke the key you are calling with.

## Everything else

```ts
await cv.models();                            // models, parameter schemas, which queue you are on
await cv.job("job_...");                      // one job by id
await cv.usage();                             // credit balance, spend and job counts

for await (const job of cv.jobs({ limit: 50, status: "succeeded" })) {
  console.log(job.id, job.status);            // newest first, paging transparently
}
```

`limit` is how many jobs one request fetches, not how many you get: the loop keeps going
until your history runs out. 200 is the largest page the API serves, and a bigger number is
fetched as 200.

## Configuration

```ts
new CraterView({
  apiKey: undefined,
  baseUrl: "https://api.craterview.ai",
});
```

`baseUrl` is what you change to point at a local server.

## From Claude Code

This repository is also a Claude Code marketplace. Two plugins: `craterview` connects
CraterView's hosted tools so the assistant enhances images in the conversation, and
`craterview-api` teaches an agent to call the API from code with this client. See
[`plugins/`](plugins/) for what each does and how it finds a key.

```
/plugin marketplace add craterviewai/craterview-ts
/plugin install craterview@craterviewai
/plugin install craterview-api@craterviewai
```

## Versioning

Semver, from `0.1.0` on. A release that removes an exported member, renames a field on `Job`
or `ModelInfo`, or changes the type of one, gets a minor bump while this is `0.x` and a major
bump after `1.0.0`; anything purely additive gets a patch. Pin what you depend on.

The API this wraps adds fields to its responses without warning, so treat an unfamiliar key in
`result` or a `status` you do not recognize as something to ignore rather than to fail on.

## License

Apache-2.0. See [LICENSE](LICENSE).
