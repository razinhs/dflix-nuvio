# AGENTS.md — DFLIX + CircleFTP Providers for Nuvio

This file is the operational handoff for AI agents working in this repository. Read it before changing code. It documents the project’s runtime contract, architecture, upstream interfaces, security invariants, tests, release process, and known limitations.

## 1. Project purpose

This repository publishes two on-device playback providers for Nuvio:

- **DFLIX Cloud** — resolves TMDB or IMDb identifiers to exact DFLIX titles and returns direct DFLIX media files.
- **CircleFTP** — resolves TMDB or IMDb identifiers to canonical metadata, conservatively matches CircleFTP posts by title/year/type, and returns direct CircleFTP movie or episode files.

The providers are separate manifest entries. Users may enable either one independently. A failure in one provider must not suppress the other.

This is not a catalog addon, media proxy, transcoder, index, or persistent local service. It participates in Nuvio’s normal **Search → Play** flow and returns direct playback URLs.

## 2. Current release baseline

Update this section whenever publishing a release.

| Component | Version | Baseline |
|---|---:|---|
| Repository manifest/package | `1.5.1` | Bounded CircleFTP size enrichment |
| DFLIX scraper | `1.4.3` | IMDb normalization supported |
| CircleFTP scraper | `1.0.1` | Initial provider plus bounded size enrichment |
| Metadata Worker package | `0.2.0` | TMDB and IMDb normalization |
| Branch | `main` | Published directly by this small repository |
| Remote | `git@github.com:razinhs/dflix-nuvio.git` | GitHub |

Installation manifest:

```text
https://raw.githubusercontent.com/razinhs/dflix-nuvio/main/manifest.json
```

## 3. Repository map

```text
.
├── AGENTS.md                 # This handoff
├── README.md                 # User-facing installation and behavior
├── manifest.json             # Nuvio repository manifest; separate scraper entries
├── package.json              # Root version and combined test command
├── dflix.js                  # DFLIX QuickJS/Nuvio provider
├── circleftp.js              # CircleFTP QuickJS/Nuvio provider
├── test.js                   # DFLIX, manifest, and integration regressions
├── circleftp.test.js         # CircleFTP unit/security/runtime regressions
└── worker/
    ├── package.json          # Worker test command and package version
    ├── wrangler.toml         # Cloudflare Worker and rate-limit binding
    ├── src/index.mjs         # Narrow TMDB/IMDb metadata normalization Worker
    └── test.mjs              # Worker contract, cache, rate-limit, and secrecy tests
```

Do not add generated assets, local credentials, `.dev.vars`, `.env`, `node_modules`, or `.wrangler` state to Git.

## 4. Nuvio provider runtime contract

Each provider must expose:

```js
async function getStreams(identifier, mediaType, season, episode)
```

Production export:

```js
if (typeof globalThis !== 'undefined') globalThis.getStreams = getStreams;
```

The conditional CommonJS export exists only so Node’s built-in test runner can load the provider:

```js
if (typeof module !== 'undefined') module.exports = { getStreams: getStreams };
```

### Inputs

- `identifier`
  - canonical positive decimal TMDB ID, or
  - lowercase IMDb ID matching `tt` plus 7–10 digits.
- `mediaType`
  - exactly `movie` or `tv`.
- For TV:
  - `season` must be a safe integer greater than or equal to `0`;
  - `episode` must be a safe integer greater than or equal to `1`.

IMDb and TMDB are different namespaces. **Never create a TMDB ID by stripping `tt` from an IMDb ID.** Resolve IMDb IDs through the metadata Worker.

### Stream result shape

Normal results use Nuvio’s direct-stream shape:

```js
{
  title: 'display label',
  name: 'DFLIX' /* or CircleFTP */,
  url: 'direct media URL',
  quality: 'optional string or null',
  size: 'optional string or null',
  language: 'optional string or null',
  provider: 'DFLIX' /* or CircleFTP */,
  type: 'direct'
}
```

No-match cases return `[]`. Provider/runtime failures currently return a bounded diagnostic-shaped result and log the error. Preserve tests if changing this behavior; Nuvio does not currently expose a dedicated diagnostic result type.

### Runtime constraints

Nuvio executes provider JavaScript in constrained QuickJS with a native fetch bridge, not unrestricted Node.js.

Assume approximately:

- 30 seconds maximum per HTTP request;
- 60 seconds total provider invocation;
- 1 MiB maximum decoded response body.

Production provider code must not depend on Node-only facilities such as:

- `require`;
- `process`;
- `Buffer`;
- `child_process`;
- filesystem APIs;
- package imports.

Keep production files dependency-free. Prefer conservative JavaScript supported by QuickJS. Do not assume browser DOM APIs. `fetch`, JSON, standard promises, and ordinary ECMAScript are available through Nuvio’s runtime.

## 5. High-level data flow

Both providers use the fixed metadata Worker first:

```text
Nuvio identifier/media type
  → metadata Worker
  → validated canonical TMDB identity/title/original title/year
  → source-specific search
  → source-specific detail revalidation
  → exact movie files or requested TV episode
  → direct source URL returned to Nuvio
```

Direct media bodies must never pass through the metadata Worker, Cloudflare, or another proxy.

## 6. Metadata Worker

Fixed origin:

```text
https://dflix-tmdb-metadata.razin.workers.dev
```

Supported read-only routes:

```text
GET /v1/metadata/movie/<tmdb-id>
GET /v1/metadata/tv/<tmdb-id>
GET /v1/metadata/movie/<imdb-id>
GET /v1/metadata/tv/<imdb-id>
```

Canonical response:

```json
{
  "id": 603,
  "type": "movie",
  "title": "The Matrix",
  "originalTitle": "The Matrix",
  "year": 1999
}
```

IMDb responses additionally include the exact external identity:

```json
{
  "id": 603,
  "externalId": "tt0133093",
  "type": "movie",
  "title": "The Matrix",
  "originalTitle": "The Matrix",
  "year": 1999
}
```

### Worker responsibilities

- Accept only `GET` and exact route grammar.
- Reject query parameters and malformed IDs.
- For numeric input, fetch the exact TMDB movie/TV record.
- For IMDb input, use TMDB’s `/find/<imdb-id>?external_source=imdb_id` endpoint and select the requested movie or TV namespace.
- Validate canonical TMDB ID, type, titles, and release date before returning or caching.
- Preserve `externalId` for IMDb identity revalidation.
- Cache successful normalized metadata.
- Rate-limit uncached clients through `TMDB_RATE_LIMITER`.
- Return generic upstream errors without exposing the TMDB credential or upstream body.
- Fail closed when secrets, cache, or rate-limit bindings are unavailable.

### Worker configuration and secrets

`worker/wrangler.toml` defines the Worker and a simple rate-limit binding. The TMDB credential is the Cloudflare secret `TMDB_READ_ACCESS_TOKEN`; it must never appear in source, tests, docs, commits, logs, provider requests, or client settings.

If Worker code changes:

```bash
cd worker
npm test
npx wrangler deploy
```

Configure the secret through Wrangler/Cloudflare rather than a tracked file. A provider-only change usually does not require Worker deployment.

## 7. DFLIX provider

Fixed source origin:

```text
https://dflix.live
```

Observed production interfaces used by the provider:

```text
GET /api/search?q=<title>&limit=60
GET /title/<internal-title-id>
Direct playback: /api/stream/<file-id>.<container>
```

### Resolution algorithm

1. Normalize the TMDB/IMDb input through the metadata Worker.
2. Search DFLIX by canonical title and, when different, original title.
3. Rank source candidates by:
   - exact TMDB ID first;
   - exact normalized title;
   - matching year.
4. Consider at most four candidates.
5. Fetch title pages and decode their Next.js Flight/RSC payload.
6. Select the title object whose internal ID matches the requested detail page.
7. Require the DFLIX title’s TMDB ID to equal the canonical TMDB ID.
8. Require file lists to belong to that exact DFLIX title ID.
9. For TV, select exact numeric season and episode.
10. Return every unique matching file with quality, container, codec, size, and audio language when available.

### DFLIX parsing cautions

DFLIX title details are embedded in Next.js Flight data rather than a stable first-party detail JSON endpoint. The current parser:

- extracts `self.__next_f.push([1, "..."])` chunks;
- concatenates decoded chunks;
- finds JSON after `"title":` and `"files":` markers;
- uses a string-aware balanced-bracket scanner rather than regexing nested JSON;
- revalidates title IDs and TMDB identity.

Do not replace this with a broad regex over nested JSON. Keep unrelated Flight title/file objects from contaminating results. Fixture-driven tests are mandatory for parser changes.

## 8. CircleFTP provider

Fixed player API origin:

```text
http://new.circleftp.net:5000/api
```

Production routes used:

```text
GET /api/posts?searchTerm=<title>&order=desc
GET /api/posts/<internal-post-id>
```

Other public surfaces observed during reverse engineering include categories, homepage groupings, and index-link data. They are not needed by the playback provider.

Do not recursively crawl CircleFTP’s H5AI hierarchy (`index.circleftp.net`, `index2.circleftp.net`, numbered hosts, and year folders). That tree is large, multi-host, and unsuitable for Nuvio’s bounded runtime. The online-player API is the production path.

### CircleFTP metadata schema

Search responses are shaped like:

```json
{
  "posts": [
    {
      "id": 71940,
      "name": "The Matrix",
      "title": "The Matrix (1999) REMASTERED 1080p BluRay H264 AAC",
      "year": "1999",
      "type": "singleVideo",
      "quality": "1080p",
      "metaData": null,
      "tags": "matrix,the matrix,...",
      "categories": [],
      "image": "<image filename>",
      "imageSm": "<thumbnail filename>",
      "cover": null,
      "watchTime": null,
      "createdAt": "<timestamp>",
      "updatedAt": "<timestamp>"
    }
  ]
}
```

Full detail fields observed include:

```text
id, name, title, year, type, quality, metaData, tags, categories,
image, imageSm, cover, watchTime, view, content, createdAt, updatedAt,
createdBy, userId
```

Important semantics:

- `id` is a CircleFTP-internal post ID, **not TMDB or IMDb**.
- `metaData` is usually a plot synopsis, not an external-ID object.
- `quality` and `title` are free-form strings that may contain resolution, source, codec, and audio text such as `1080p BluRay Hin+Eng`.
- `year` may be one year (`1999`) or a range (`2008-2013`). Matching uses the starting year.
- No dependable structured TMDB ID, IMDb ID, codec, file size, rating, cast, director, or audio-language array was observed. The provider derives optional size only from a valid one-byte range response, never from CircleFTP JSON.

Supported content shapes:

Single movie:

```json
{
  "type": "singleVideo",
  "content": "http://<circle-host>/FILE/path/movie.mkv"
}
```

Multi-variant movie:

```json
{
  "type": "multiVideo",
  "content": [
    {
      "title": "variant label",
      "link": "http://<circle-host>/FILE/path/movie.mkv"
    }
  ]
}
```

Series:

```json
{
  "type": "series",
  "content": [
    {
      "seasonName": "Season 1",
      "episodes": [
        {
          "title": "S01E01",
          "link": "http://<circle-host>/FILE/path/episode.mkv"
        }
      ]
    }
  ]
}
```

### CircleFTP resolution algorithm

1. Strictly validate caller ID, media type, and TV coordinates before network I/O.
2. Start a 25-second request-launch deadline.
3. Resolve canonical metadata through the Worker.
4. Search localized/canonical title first.
5. If no exact match exists and budget remains, search original title.
6. Require exact normalized title, starting year, and media type.
7. Deduplicate source post IDs and keep at most four candidates.
8. Fetch candidate details sequentially because Nuvio’s native fetch bridge is synchronous underneath.
9. Revalidate detail ID, title, year, and type.
10. Extract all valid movie variants or only the requested TV season/episode.
11. Validate every untrusted media URL.
12. Deduplicate URLs and retain at most 100 unique streams.
13. During only the first five seconds of the invocation, probe at most the first two streams with `Range: bytes=0-0`.
14. Accept size only from HTTP `206` plus strict `Content-Range: bytes 0-0/<positive-safe-integer>`; otherwise preserve the stream with `size: null`.

### CircleFTP title matching

CircleFTP lacks external IDs, so matching is necessarily less certain than DFLIX. Preserve these rules:

- Normalize with lowercase and optional NFKD decomposition.
- Remove combining marks while preserving non-ASCII identity.
- Do not reduce titles to ASCII only; mixed-script titles such as `愛 Love` and `كره Love` must not collide on `love`.
- Reject empty normalized titles.
- Require equality with canonical title or original title.
- Require exact starting-year equality.
- Require movie types `singleVideo`/`multiVideo` or TV type `series`.
- Revalidate on detail; search results alone are untrusted.

## 9. Security and reliability invariants

These are release blockers. Do not weaken them without explicit tests and review.

### Fixed-origin requests

Providers may contact only their fixed metadata/source origins. Never turn a request parameter, upstream JSON field, or settings value into an arbitrary fetch target. This project must not become an open proxy or arbitrary-origin fetch mechanism.

### CircleFTP direct URL allowlist

API-supplied links are untrusted. Accepted CircleFTP media URLs must:

- use plain `http` only, matching the actual source;
- have no credentials/userinfo;
- use an exact single-label subdomain of `circleftp.net`;
- use no port or explicit port `80` only;
- use exact uppercase `/FILE/` path prefix;
- contain no control characters or backslashes;
- contain no `.` or `..` segments;
- survive repeated bounded decoding and final revalidation;
- leave no residual/deeper percent encoding;
- contain no fragment;
- end in an allowed video extension: `mkv`, `mp4`, `avi`, `mov`, `m4v`, `webm`, or `ts`.

Regression coverage must include:

- raw traversal;
- encoded, double-encoded, and triple-encoded traversal;
- encoded slashes and backslashes;
- credentials/userinfo;
- hostname suffix tricks;
- unexpected ports and schemes;
- non-`/FILE/` paths;
- non-video extensions;
- fragments and malformed encodings.

### Bounds

Current CircleFTP limits:

```text
MAX_CANDIDATES = 4
MAX_LINKS_PER_POST / cumulative output cap = 100
MAX_REQUEST_LAUNCH_MS = 25000
MAX_SIZE_PROBES = 2
SIZE_PROBE_LAUNCH_MS = 5000
Detail and size-probe concurrency = 1
```

The launch deadline is not an HTTP cancellation mechanism. It prevents a new request from starting too late, leaving room for one possible native 30-second request under Nuvio’s approximately 60-second invocation ceiling.

Apply link/output limits cumulatively, not separately to every nested season. A malicious `100 seasons × 100 episodes × 4 posts` response must still produce no more than 100 unique streams.

### Strict schemas

Do not rely on JavaScript coercion for security or identity decisions.

- IDs must match canonical grammar and safe-integer limits.
- CircleFTP post IDs must be actual numbers, not numeric strings.
- Years must be typed and valid.
- Required source fields must have expected scalar/array/object types.
- TV season/episode arguments must be actual safe integers, not arrays, booleans, strings, or objects with `valueOf()`.
- Optional display text must be accepted only as bounded strings.
- Unknown or malformed source data should be skipped rather than guessed.

### Secrets and privacy

- Never expose `TMDB_READ_ACCESS_TOKEN`.
- Client providers must not send authorization headers to the Worker.
- Do not log secrets or raw upstream error bodies.
- Do not proxy media.
- CircleFTP API and video traffic is unencrypted HTTP and may be visible to the local network/ISP.
- CircleFTP may only work on supported ISP/private networks.

## 10. Testing

Requires Node.js 20 or newer. The repository has no runtime npm dependencies.

Run all root tests:

```bash
npm test
```

Run Worker tests:

```bash
npm test --prefix worker
```

Run syntax checks:

```bash
node --check dflix.js
node --check circleftp.js
node --check test.js
node --check circleftp.test.js
node --check worker/src/index.mjs
node --check worker/test.mjs
```

Parse JSON metadata and check whitespace:

```bash
node -e "for (const f of ['manifest.json','package.json','worker/package.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
git diff --check
```

Optional coverage:

```bash
node --experimental-test-coverage --test test.js circleftp.test.js
```

### What tests must protect

DFLIX tests cover:

- manifest independence;
- exact TMDB movie/TV resolution;
- IMDb-to-canonical-TMDB identity;
- Flight payload isolation;
- title/file ID ownership;
- every movie/episode variant;
- bounded candidate work and partial failures;
- no client credentials;
- visible diagnostics.

CircleFTP tests cover:

- exact movie variants;
- exact season/episode selection;
- four-candidate and sequential-detail limits;
- localized/original-title fallback and deadline behavior;
- IMDb identity revalidation;
- caller/media/season/episode grammar before network I/O;
- malformed post IDs, years, details, and optional fields;
- wrong title/year/type rejection;
- Unicode and mixed-script collision prevention;
- direct URL allowlist adversaries;
- cumulative 100-result ceiling;
- deduplication and multi-video content;
- two-probe size cap, strict `206 Content-Range` parsing, five-second launch window, and no stream loss on enrichment failure;
- graceful source failures.

Worker tests cover:

- TMDB and IMDb normalization;
- canonical identity validation;
- malformed input rejection before upstream access;
- cache validation and poisoned-cache refresh;
- rate limiting;
- missing secret/binding failures;
- safe cache writes;
- generic error handling and secret redaction.

When fixing a bug, add a failing regression first, confirm RED, make the minimum implementation change, then confirm focused and full GREEN.

## 11. Live verification

Only perform bounded, read-only verification against public endpoints.

For source resolution, test at least:

- one numeric TMDB movie;
- one IMDb movie;
- one numeric or IMDb TV episode;
- one no-match/wrong-episode case.

For direct playback, never download a full media body. Request one byte:

```http
Range: bytes=0-0
```

Expected evidence for a working direct file:

- HTTP `206 Partial Content`;
- media content type such as `video/mp4` or `video/x-matroska`;
- `Accept-Ranges: bytes` when supplied;
- `Content-Range: bytes 0-0/<total>`.

Treat network/ISP restrictions as a caveat, not a reason to bypass access controls. Do not bypass authentication, DRM, CAPTCHA, geographic restrictions, or source denials.

## 12. Manifest and versioning

`manifest.json` contains two independently toggleable scrapers. Preserve that separation.

There are three version layers:

1. repository/package version (`manifest.json` and root `package.json`);
2. per-scraper versions in `manifest.json`;
3. Worker package version in `worker/package.json`.

Version intentionally and consistently:

- Provider behavior or manifest release: bump repository/package version.
- DFLIX-only behavior: bump DFLIX scraper version.
- CircleFTP-only behavior: bump CircleFTP scraper version.
- Worker contract/deployment change: bump Worker package version and deploy it.

Do not overwrite an already published release version. Update `README.md` and this file when behavior, limits, routes, or requirements change.

## 13. Safe development workflow

1. Confirm repository state:

   ```bash
   git status --short --branch
   git fetch origin main
   git rev-list --left-right --count HEAD...origin/main
   ```

2. Read the affected provider, tests, manifest, README, Worker contract, and this file.
3. Reproduce or specify the desired behavior with a test.
4. Make the smallest compatible change.
5. Run focused tests.
6. Run full root and Worker tests.
7. Run syntax, JSON, and `git diff --check` gates.
8. Review the complete changed and untracked tree for:
   - fixed origins;
   - schema coercion;
   - URL bypasses;
   - request/output bounds;
   - QuickJS compatibility;
   - credentials;
   - DFLIX regressions;
   - manifest/version consistency.
9. Perform bounded live resolution/range checks when source behavior changed.
10. Commit only reviewed files with a conventional message.
11. Push through Git SSH.
12. Verify local `HEAD`, `origin/main`, and `git ls-remote origin refs/heads/main` match.
13. Fetch raw GitHub artifacts and compare them byte-for-byte with reviewed local files.
14. Smoke-test the published raw provider when provider code changed.

Do not claim publication before remote identity and raw artifact checks pass.

## 14. Adding another provider

Keep new providers isolated as their own manifest scraper unless there is a compelling runtime reason to combine them.

Before implementation:

1. Inspect public pages and referenced JavaScript bundles using bounded `GET`/`HEAD` requests.
2. Identify stable search/detail/playback interfaces.
3. Determine whether visible IDs are external IDs or internal source IDs.
4. Prefer stable bounded JSON APIs over recursive directory crawling or framework payload parsing.
5. Document representative schemas and response sizes.
6. Validate direct delivery with a one-byte range only.
7. Check Nuvio QuickJS/runtime compatibility.
8. Define explicit request, candidate, nested-item, and output limits.
9. Treat every upstream field and URL as untrusted.
10. Add manifest, README, tests, and version changes together.

Never infer that a numeric source ID is TMDB. Never proxy full media through the Worker. Never build unrestricted recursive crawlers for Nuvio’s provider runtime.

## 15. Known limitations and maintenance risks

- CircleFTP has no dependable TMDB/IMDb mapping. Title/year/type matching is conservative but cannot equal DFLIX’s ID-level certainty.
- CircleFTP uses HTTP and may be ISP/private-network restricted.
- CircleFTP quality/audio/codec details are free-form text rather than stable structured fields.
- CircleFTP size requires an additional one-byte range request. It is best-effort, limited to two streams and a five-second launch window; an already-launched native request can still wait for Nuvio's HTTP timeout.
- DFLIX detail extraction depends on Next.js Flight serialization and can break after a frontend deployment.
- No local `qjs` executable is assumed; compatibility is primarily protected through constrained coding style, Nuvio source audits, and Node tests. When possible, use Nuvio’s actual **Test Scraper** facility before release.
- Provider diagnostic results use direct-stream-shaped objects because Nuvio lacks a dedicated diagnostic contract.
- Upstream services may change routes or schemas without notice. Fail closed rather than guessing.

## 16. Debugging guide

### Provider does not appear

- Confirm the user uses Nuvio’s Full/GitHub build with plugin support.
- Validate `manifest.json` and scraper `filename` values.
- Refresh the repository and check independent enable toggles.

### Metadata errors

- Probe the exact Worker route.
- Confirm ID grammar and movie/TV namespace.
- Run Worker tests.
- Check Cloudflare secret and rate-limit/cache bindings without printing secrets.
- Verify IMDb response `externalId` equals the caller’s exact lowercase IMDb ID.

### DFLIX no result

- Check Worker canonical ID/title.
- Check `/api/search` response.
- Inspect the relevant title page’s Flight payload.
- Verify title TMDB ID and file `titleId` ownership.
- For TV, verify exact numeric season/episode fields.

### CircleFTP no result

- Confirm the network can reach `new.circleftp.net:5000` over HTTP.
- Compare canonical and original titles with CircleFTP `name`.
- Check starting year and source type.
- Fetch the exposed internal post ID’s detail and revalidate it.
- For TV, inspect `seasonName`, episode `title`, and exact requested coordinates.
- Validate that the media link uses an allowed CircleFTP host and canonical `/FILE/` video path.

### Source returns malformed data

Do not loosen validation immediately. Save a small fixture, determine whether the new shape is legitimate and stable, add a regression, and preserve all identity/origin/bound checks.

## 17. Agent completion checklist

Before handing work to another agent or reporting completion:

- [ ] Scope and assumptions are documented.
- [ ] No secrets were read into output or committed.
- [ ] Production code remains QuickJS-compatible and dependency-free.
- [ ] Identifier namespaces remain separate.
- [ ] Source identity is revalidated at detail level.
- [ ] Direct URLs remain strictly allowlisted.
- [ ] Request, candidate, nested-item, and output bounds remain explicit.
- [ ] Root tests pass.
- [ ] Worker tests pass when relevant.
- [ ] Syntax, JSON, and diff checks pass.
- [ ] Manifest/docs/versions are consistent.
- [ ] Live checks are bounded and do not download full media.
- [ ] Git tree contains only intended files.
- [ ] Published commit and raw artifacts are verified if pushed.
- [ ] This `AGENTS.md` is updated if architecture or operational knowledge changed.
