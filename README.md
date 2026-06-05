# Aetridder

Private single-user Reddit thread reader for iPhone. The app receives one public Reddit or redd.it URL from an iOS Shortcut, creates a latest-job processing task, extracts public thread structure with Playwright/Chromium best effort locally or through a configured local extractor agent, translates the structured JSON into a configurable native language through Codex CLI using the configured Codex model, and renders a private mobile reader page at `/t/:jobId`.

This is a candidate app for local manual review. It is not deployed, not public, not adopted by any project, and not a permanent Reddit archive.

## Scope

- Private single-user tool.
- One Reddit thread at a time.
- Latest job only. Creating a new job replaces the previous job.
- Old reader URLs show a replaced or expired placeholder after replacement.
- Successful translations also get static saved result pages under `/results/:jobId`; only the latest telemetry-history window is retained.
- Reader output is translated text in the configured target language. Original source text is not rendered.
- Diagnostics are read-only API endpoints.
- No retry, cancel, purge, restart, reprocess, upload, deploy, publication, registration, proxy rotation, anti-bot circumvention, Reddit login, cookies, voting, replying, or Reddit account action.
- No fallback translator. Translation uses bounded Codex CLI. Defaults are `CODEX_MODEL=gpt-5.5`, `CODEX_REASONING_EFFORT=high`, and Ukrainian target output; the content target is controlled by `REDDIT_READER_TARGET_LANGUAGE_*`.
- Translation is incremental: the post is translated first, then comments are translated in bounded ordered batches. The reader page updates without full-page refresh while preserving comment order.
- Codex usage telemetry is available for shakedown at `/codex-usage`. It is protected by diagnostics auth by default and does not expose original Reddit text, prompts, logs, secrets, raw artifacts, or full job URLs. The linked saved result pages do render translated content.

## Reddit Extraction Modes

The current candidate feature is designed to use unauthenticated browser-render HTML extraction through Playwright/Chromium. It is not designed to use Reddit public `.json` as the primary product path.

The app supports two placement modes for that same product extraction strategy:

- `playwright`: the app process runs Playwright extraction directly from the same runtime.
- `external`: the VPS app calls a configured private extractor endpoint such as a laptop agent reached through a reverse SSH tunnel. The laptop performs Reddit/Playwright extraction and returns structured `rawThread` through the `extractor.v1` protocol; the VPS continues validation, Codex translation, and rendering.

Diagnostic probes may separate three Reddit auth modes, but OAuth/API and cookie/session modes are not product features in this MVP:

- `public_json_unauthenticated`: diagnostic probe only; if Reddit returns `403`, `429`, verification, or Cloudflare/block HTML, that does not prove the parser works or fails.
- `official_reddit_oauth_api`: not selected, preferred, implemented, or configured by this MVP.
- `browser_session_fetch_with_cookies`: not selected, preferred, implemented, or configured by this MVP. Personal Reddit cookies are not requested, read, or logged.

Acceptance for live extraction requires `live_reddit_proof`: one real subreddit listing and one real thread with comments fetched, raw thread persisted, parsed, and rendered from the intended runtime/mode.

Local laptop `live_reddit_proof` does not prove isolated VPS direct Reddit viability. If Reddit blocks VPS/browser extraction, configure `external` mode and prove the full chain with the laptop extractor agent active. This MVP still does not select or prefer OAuth/API, cookies, proxy rotation, or anti-bot behavior.

## Comment Extraction

The parser reads visible `shreddit-comment` nodes and expands relevant rendered `faceplate-partial` more-comments nodes with bounded, sequential, same-origin Playwright fetches. Hidden input fields such as `cursor` are part of the request identity, so identical partial URLs with different cursor values are fetched separately. Fetched partial HTML is saved as `reddit-comments-partial-N.html`, parsed for comments, and scanned for nested more-comments partials until the queue is empty or configured limits are reached.

Extraction remains best-effort. Reddit DOM and partial endpoint behavior may change. If partial requests fail, remain unresolved, or hit limits, the job keeps usable comments and exposes `partial_comments`; it does not claim complete extraction. No OAuth/API, Reddit login, personal cookies, proxy rotation, stealth plugins, CAPTCHA/verification bypass, or anti-bot behavior are added.

## Local Run

1. Install dependencies if needed with the existing package lock:

   ```powershell
   npm ci
   ```

2. Create local environment values from `.env.example`. Set a real local value for:

   ```text
   REDDIT_READER_API_TOKEN
   ```

3. Start the local server:

   ```powershell
   npm start
   ```

   By default the app binds to `127.0.0.1:4173`. Set `REDDIT_READER_HTTP_HOST` explicitly only when a deployment/reverse-proxy contour should expose the process elsewhere.

   To run the laptop extractor agent instead of the VPS app:

   ```powershell
   npm run start:extractor-agent
   ```

4. Submit a thread URL:

   ```powershell
   $headers = @{ Authorization = "Bearer <REDDIT_READER_API_TOKEN>" }
   $body = @{ url = "https://www.reddit.com/r/example/comments/example/example/" } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4173/api/threads" -Headers $headers -Body $body -ContentType "application/json"
   ```

The response includes `jobId` and `viewUrl`. Open `viewUrl` on the phone or desktop browser.

## Target Language

The translated content language is configured through:

```text
REDDIT_READER_TARGET_LANGUAGE_CODE
REDDIT_READER_TARGET_LANGUAGE_NAME
REDDIT_READER_TARGET_LOCALE
```

Change these values to translate into a different native language. Codex prompts receive the configured language name/code, and runtime validation rejects translated JSON that declares a different language code. Legacy deployment aliases remain supported for existing installations and are documented separately in `docs/configuration.md`.

The public repository default is:

```text
REDDIT_READER_TARGET_LANGUAGE_CODE=uk
REDDIT_READER_TARGET_LANGUAGE_NAME=Ukrainian
REDDIT_READER_TARGET_LOCALE=uk-UA
```

Deployment-owned environment overrides may intentionally choose another language without changing product source.

## iOS Shortcut Setup

Create a Shortcut named `Reddit Reader` with these actions:

1. Receive URLs from Share Sheet.
2. Get the first shared URL.
3. If the URL host is not `reddit.com`, a `*.reddit.com` host, or `redd.it`, stop with an error.
4. Send `POST` to `https://<your-host>/api/threads`.
5. Use JSON body:

   ```json
   { "url": "Shortcut Input" }
   ```

6. Add header:

   ```text
   Authorization: Bearer <REDDIT_READER_API_TOKEN>
   ```

7. Get `viewUrl` from the JSON response.
8. Open `viewUrl`.

The Shortcut should not put the token in the URL. The reader page uses the unguessable `jobId` in `/t/:jobId` as the local MVP privacy boundary.

## Auth And Privacy Model

- `POST /api/threads` requires `Authorization: Bearer <REDDIT_READER_API_TOKEN>`.
- Diagnostics endpoints require `Authorization: Bearer <REDDIT_READER_DIAGNOSTICS_TOKEN>` when configured, otherwise the same API token.
- `/t/:jobId` is protected only by an unguessable random `jobId` for this local MVP.
- `/codex-usage`, `/api/codex-usage`, and `/results/:jobId` require diagnostics auth by default. They can be made public only with explicit `REDDIT_READER_PUBLIC_DEBUG_PAGES=1` for a private shakedown contour.
- Browser access to protected debug pages may use HTTP Basic auth with any username and the diagnostics token as the password. Script access may use `Authorization: Bearer <REDDIT_READER_DIAGNOSTICS_TOKEN>`.
- Tokens and full view URLs are not logged. Worker logs and diagnostic log tails redact Bearer values, configured tokens, and full `/t/:jobId` URLs.

## API

### `POST /api/threads`

Body:

```json
{ "url": "https://www.reddit.com/r/example/comments/example/example/" }
```

Response:

```json
{
  "jobId": "unguessable-id",
  "viewUrl": "http://127.0.0.1:4173/t/unguessable-id"
}
```

The endpoint accepts only Reddit or redd.it URLs. The worker also validates the final redirect target before extraction output is accepted.

### `GET /api/threads/:jobId/status`

Bearer protected. Returns the safe status contract:

- `jobId`
- `status`
- `sourceUrl`
- `normalizedUrl`
- `finalUrlAfterRedirect`
- `createdAt`
- `updatedAt`
- `stageTimestamps`
- `warningCodes`
- `errorCode`
- `errorMessageSafe`
- redacted `artifactManifest`
- `isCurrentLatestJob`

### `GET /api/view/:jobId`

Reader-facing JSON endpoint. It is not Bearer protected; access is limited by the unguessable `jobId`, matching `/t/:jobId` for this local MVP.

It returns only safe reader data:

- `jobId`
- `status`
- `warningCodes`
- `errorMessageSafe`
- translated `thread` in the configured target language when the job is ready
- safe partial translated `thread` while the job is still translating, when available
- safe `translationProgress` and comment-count summary
- minimal reader metadata

It does not expose original English bodies, debug artifact contents, raw HTML, screenshots, worker logs, Codex event logs, validation internals, diagnostics-only fields, or artifact manifests.

### `GET /codex-usage`

Protected engineering page for shakedown. It shows the rolling latest Codex translation jobs, capped by `REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT` with a default of `30`.

The page polls `GET /api/codex-usage` in the browser and updates the metric cards/table without a full page reload.
Each successful job links to a static translated result page under `/results/:jobId`. Those result links are retained only while their job remains in the rolling history.

The page shows only safe numeric telemetry:

- status and safe warning codes
- model and reasoning effort
- per-job translation and total job duration
- translated/reported comment counts
- completed/total batch counts
- per-job total/input/output/cached/reasoning token counts when Codex CLI reports them
- static translated result link when available

The telemetry page/API do not expose Reddit post/comment text, source URLs, prompts, command strings, worker logs, Codex event logs, secrets, raw artifacts, screenshots, or full reader URLs. The linked static result pages do render translated thread content and Reddit outbound links from the translated reader page.

`GET /api/codex-usage` returns the same safe numeric history as JSON for local inspection scripts. Both endpoints use diagnostics auth unless `REDDIT_READER_PUBLIC_DEBUG_PAGES=1` is explicitly set.

### `GET /results/:jobId`

Protected static translated result page for successful jobs. It is generated from the translated reader output after the job reaches `ready` or `ready_with_warning`.

Saved results are intended for debugging and lightweight sharing in an explicitly private contour. They are not a permanent archive. Result pages older than the rolling `REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT` window are deleted. Public access requires explicit `REDDIT_READER_PUBLIC_DEBUG_PAGES=1`.

### Diagnostics

All diagnostics are Bearer protected and read-only:

- `GET /api/diagnostics/health`
- `GET /api/diagnostics/job`
- `GET /api/diagnostics/artifacts`
- `GET /api/diagnostics/extractor`

Diagnostics expose health, storage reachability, worker heartbeat, queue/current job, stage timestamps, last error, artifact manifest, redacted log tail, and safe extractor provider summaries. They do not expose retry, cancel, purge, restart, reprocess, delete, upload, deploy, or any state-changing control.

## Artifacts

The app stores latest-job artifacts under `runtime/latest` at runtime and persists the current latest-job state in `runtime/latest-job-state.json`. On startup, the local candidate reloads the latest terminal ready/error state from `latest-job-state.json` and `runtime/latest` so `/t/:jobId` and diagnostics can reflect the latest published job after restart. In-flight workers are not resumed after restart. Runtime files are ignored by git.

Manifest entries are maintained for:

- `reddit-page.html`
- `screenshot.png`
- `thread.raw.json`
- `thread.translated.json`
- `worker.log`
- `codex-events.jsonl`
- `post.translated.json`
- `post.codex-events.jsonl`
- `translation-progress.json`
- `codex-usage-report.json`
- `extractor-report.json`
- `validation-report.json`
- `artifact-manifest.json`

Any additional file copied into `runtime/latest`, such as public comment partial HTML captured during extraction or `translated-batches/NNN.json` comment-batch translation artifacts, is listed in `artifact-manifest.json` under `additionalArtifacts`.

`thread.raw.json` includes parser expansion metrics such as visible comment count, discovered/unique/fetched/failed/unresolved more-comment request counts, duplicate request count, limit status, extracted unique comment count, maximum extracted depth, and partial artifact count.

`codex-usage-report.json` is numeric-only per-job telemetry: model, reasoning effort, post/batch usage counters when available, aggregate totals, durations, safe warning codes, and counts. The rolling history is stored in `runtime/codex-usage-history.json` and capped to the configured limit.

Static translated result pages are stored in `runtime/saved-results`. They are pruned to the same rolling limit as `codex-usage-history.json`.

Only the latest job is published to `runtime/latest`. Per-job worker scratch directories are discarded after publish or stale-job detection.

## Tests

Run fixture and unit coverage:

```powershell
npm test
```

Run the iPhone-like renderer check:

```powershell
npm run test:mobile
```

The mobile check uses a `390x844` viewport when Playwright Chromium is available and writes a local screenshot under `runtime/mobile-render-check`.
If Playwright or Chromium is unavailable, the check fails by default. Set `REDDIT_READER_ALLOW_MOBILE_RENDER_SKIP=1` only when recording an explicit host-limit skip.

## More Detail

- Configuration: `docs/configuration.md`
- Architecture visuals: `docs/ARCHITECTURE_VISUALS.md`
- EPC artifact: `docs/epc/reddit-reader-job-process.epml`
- Laptop extractor agent and reverse SSH tunnel: `docs/laptop-extractor-agent.md`
- Hybrid extraction architecture: `docs/hybrid-extraction-mode.md`
- Extractor protocol: `docs/extractor-protocol-v1.md`
- Translation contract: `docs/translation-contract.md`
- JSON schemas: `schemas/`
- Fixtures: `fixtures/`
