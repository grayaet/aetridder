# Reddit RU Reader 001

Shipyard-local candidate private single-user Reddit thread reader for iPhone. The app receives one public Reddit or redd.it URL from an iOS Shortcut, creates a latest-job processing task, extracts public thread structure with Playwright/Chromium best effort, translates the structured JSON into Russian through Codex CLI using `gpt-5.5` only, and renders a private mobile reader page at `/t/:jobId`.

This is a candidate app for local manual review. It is not deployed, not public, not adopted by any project, and not a permanent Reddit archive.

## Scope

- Private single-user tool.
- One Reddit thread at a time.
- Latest job only. Creating a new job replaces the previous job.
- Old reader URLs show a replaced or expired placeholder after replacement.
- Reader output is Russian translated text only. Original English text is not rendered.
- Diagnostics are read-only API endpoints.
- No retry, cancel, purge, restart, reprocess, upload, deploy, publication, registration, proxy rotation, anti-bot circumvention, Reddit login, cookies, voting, replying, or Reddit account action.
- No fallback translator. Translation is GPT-5.5 high only through bounded Codex CLI.

## Reddit Fetch Modes

The current candidate feature is designed to use unauthenticated browser-render HTML extraction through Playwright/Chromium. It is not designed to use Reddit public `.json` as the primary product path.

Diagnostic probes may separate three auth modes, but only the first product mode below is implemented in this MVP:

- `public_json_unauthenticated`: diagnostic probe only; if Reddit returns `403`, `429`, verification, or Cloudflare/block HTML, that does not prove the parser works or fails.
- `official_reddit_oauth_api`: not selected, preferred, implemented, or configured by this MVP.
- `browser_session_fetch_with_cookies`: not selected, preferred, implemented, or configured by this MVP. Personal Reddit cookies are not requested, read, or logged.

Acceptance for live extraction requires `live_reddit_proof`: one real subreddit listing and one real thread with comments fetched, raw thread persisted, parsed, and rendered from the intended runtime/mode.

Local `live_reddit_proof` does not prove isolated VPS production viability. Before calling this app VPS-ready, first run the same Playwright browser-render gate from the intended VPS with a fresh browser context retry, verification/403/429 detection, raw persistence, parsing, and rendering evidence. This MVP does not select or prefer OAuth/API, cookies, or alternate extraction modes. Any future production extraction mode requires a separate owner-confirmed work order. Optional live probes are diagnostic only and do not create product scope.

## Local Run

1. Install dependencies if needed with the existing package lock:

   ```powershell
   npm ci
   ```

2. Create local environment values from `.env.example`. Set a real local value for:

   ```text
   REDDIT_RU_API_TOKEN
   ```

3. Start the local server:

   ```powershell
   npm start
   ```

4. Submit a thread URL:

   ```powershell
   $headers = @{ Authorization = "Bearer <REDDIT_RU_API_TOKEN>" }
   $body = @{ url = "https://www.reddit.com/r/example/comments/example/example/" } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4173/api/threads" -Headers $headers -Body $body -ContentType "application/json"
   ```

The response includes `jobId` and `viewUrl`. Open `viewUrl` on the phone or desktop browser.

## iOS Shortcut Setup

Create a Shortcut named `Reddit RU` with these actions:

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
   Authorization: Bearer <REDDIT_RU_API_TOKEN>
   ```

7. Get `viewUrl` from the JSON response.
8. Open `viewUrl`.

The Shortcut should not put the token in the URL. The reader page uses the unguessable `jobId` in `/t/:jobId` as the local MVP privacy boundary.

## Auth And Privacy Model

- `POST /api/threads` requires `Authorization: Bearer <REDDIT_RU_API_TOKEN>`.
- Diagnostics endpoints require `Authorization: Bearer <REDDIT_RU_DIAGNOSTICS_TOKEN>` when configured, otherwise the same API token.
- `/t/:jobId` is protected only by an unguessable random `jobId` for this local MVP.
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
- Russian translated `thread` when the job is ready
- minimal reader metadata

It does not expose original English bodies, debug artifact contents, raw HTML, screenshots, worker logs, Codex event logs, validation internals, diagnostics-only fields, or artifact manifests.

### Diagnostics

All diagnostics are Bearer protected and read-only:

- `GET /api/diagnostics/health`
- `GET /api/diagnostics/job`
- `GET /api/diagnostics/artifacts`

Diagnostics expose health, storage reachability, worker heartbeat, queue/current job, stage timestamps, last error, artifact manifest, and redacted log tail. They do not expose retry, cancel, purge, restart, reprocess, delete, upload, deploy, or any state-changing control.

## Artifacts

The app stores latest-job artifacts under `runtime/latest` at runtime and persists the current latest-job state in `runtime/latest-job-state.json`. On startup, the local candidate reloads the latest terminal ready/error state from `latest-job-state.json` and `runtime/latest` so `/t/:jobId` and diagnostics can reflect the latest published job after restart. In-flight workers are not resumed after restart. Runtime files are ignored by git.

Manifest entries are maintained for:

- `reddit-page.html`
- `screenshot.png`
- `thread.raw.json`
- `thread.translated.json`
- `worker.log`
- `codex-events.jsonl`
- `validation-report.json`
- `artifact-manifest.json`

Any additional file copied into `runtime/latest`, such as public comment partial HTML captured during extraction, is listed in `artifact-manifest.json` under `additionalArtifacts`.

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

## More Detail

- Configuration: `docs/configuration.md`
- Translation contract: `docs/translation-contract.md`
- JSON schemas: `schemas/`
- Fixtures: `fixtures/`
