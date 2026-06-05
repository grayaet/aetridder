# Configuration

Configuration is read from environment variables. `MAX_COMMENTS = 1000` is owner-confirmed. The other numeric values below are Builder/PM implementation defaults, not owner business decisions.

Production may intentionally override these defaults. Deployment-owned overrides are not product defaults and should be documented separately by the operator for each runtime.

| Environment variable | Default | Classification |
| --- | ---: | --- |
| `REDDIT_READER_HTTP_PORT` | `4173` | implementation default |
| `REDDIT_READER_HTTP_HOST` | `127.0.0.1` | implementation default |
| `REDDIT_READER_MAX_COMMENTS` | `1000` | owner-confirmed |
| `REDDIT_READER_EXTRACTION_TIMEOUT_MS` | `90000` | implementation default |
| `REDDIT_READER_TRANSLATION_TIMEOUT_MS` | `180000` | implementation default |
| `REDDIT_READER_TOTAL_JOB_TIMEOUT_MS` | `300000` | implementation default |
| `REDDIT_READER_MAX_INPUT_CHARS` | `300000` | implementation default |
| `REDDIT_READER_MAX_ARTIFACT_BYTES` | `10485760` | implementation default |
| `REDDIT_READER_MAX_COMMENT_PARTIAL_REQUESTS` | `50` | implementation default |
| `REDDIT_READER_MAX_COMMENT_PARTIAL_BYTES` | `10485760` | implementation default |
| `REDDIT_READER_COMMENT_PARTIAL_IDLE_MS` | `0` | implementation default |
| `REDDIT_READER_REDACTED_LOG_TAIL_BYTES` | `32768` | implementation default |
| `REDDIT_READER_CODEX_PROCESS_TIMEOUT_MS` | `180000` | implementation default |
| `REDDIT_READER_CODEX_BATCH_TIMEOUT_MS` | `300000` | implementation default |
| `REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS` | `10` | implementation default |
| `REDDIT_READER_TRANSLATION_BATCH_MAX_CHARS` | `20000` | implementation default |
| `REDDIT_READER_TRANSLATION_CONCURRENCY` | `10` | implementation default, capped at 10 |
| `REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT` | `30` | implementation default, capped at 100 |
| `REDDIT_READER_PUBLIC_DEBUG_PAGES` | `0` | explicit private-shakedown opt-in |
| `REDDIT_READER_EXTRACTION_MODE` | `playwright` | implementation default |
| `EXTRACTOR_PROVIDER` | derived from extraction mode | implementation default |
| `EXTRACTOR_PROTOCOL_VERSION` | `extractor.v1` | implementation default |
| `EXTRACTOR_REMOTE_URL` | empty | implementation default |
| `EXTRACTOR_TOKEN` | empty | private shared secret |
| `EXTRACTOR_SHARED_SECRET` | empty | private shared secret |
| `EXTRACTOR_TIMEOUT_MS` | `90000` | implementation default |
| `EXTRACTOR_HEALTH_TIMEOUT_MS` | `5000` | implementation default |
| `EXTRACTOR_MAX_CONSECUTIVE_FAILURES` | `3` | implementation default |
| `EXTRACTOR_CIRCUIT_COOLDOWN_MS` | `30000` | implementation default |
| `REDDIT_READER_EXTRACTOR_AGENT_HOST` | `127.0.0.1` | implementation default |
| `REDDIT_READER_EXTRACTOR_AGENT_PORT` | `4181` | implementation default |
| `CODEX_MODEL` | `gpt-5.5` | implementation default |
| `CODEX_REASONING_EFFORT` | `high` | implementation default |
| `REDDIT_READER_TARGET_LANGUAGE_CODE` | `uk` | public repository default |
| `REDDIT_READER_TARGET_LANGUAGE_NAME` | `Ukrainian` | public repository default |
| `REDDIT_READER_TARGET_LOCALE` | `uk-UA` | public repository default |

The `REDDIT_READER_*` prefix is the public configuration surface. Existing deployments may still use legacy aliases with the previous deployment prefix; keep those aliases working unless an ops-approved migration removes them.

## Required Auth Values

`REDDIT_READER_API_TOKEN` must be set for `POST /api/threads`. If it is missing, authenticated API requests return a server configuration error instead of accepting unauthenticated writes.

`REDDIT_READER_DIAGNOSTICS_TOKEN` is optional. When unset, diagnostics use `REDDIT_READER_API_TOKEN`.

Do not put tokens in URLs. Do not put secrets in `.env.example`.

`/codex-usage`, `/api/codex-usage`, and `/results/:jobId` use the diagnostics token by default. Browsers may use HTTP Basic auth with any username and the diagnostics token as the password; scripts may use `Authorization: Bearer <token>`. Set `REDDIT_READER_PUBLIC_DEBUG_PAGES=1` only for an explicitly private shakedown contour where public access to retained translated result pages is acceptable.

## URL Hosts

`REDDIT_READER_PUBLIC_URL_ALLOWLIST` defaults to:

```text
reddit.com,redd.it,www.reddit.com,old.reddit.com,new.reddit.com
```

The URL guard also accepts subdomains of `reddit.com` and rejects lookalike hosts such as `reddit.com.example`.

## Comment Partial Expansion

The parser expands visible `faceplate-partial` more-comments nodes on the rendered Reddit page through bounded same-origin Playwright `fetch` calls. Request identity includes HTTP method, normalized partial URL, and sorted child input fields such as hidden `cursor` values; the same partial URL with different cursor values is treated as distinct work.

Partial expansion is sequential and bounded by `REDDIT_READER_MAX_COMMENT_PARTIAL_REQUESTS`. `REDDIT_READER_MAX_COMMENT_PARTIAL_BYTES` limits each fetched partial HTML payload before it is saved as `reddit-comments-partial-N.html`. `REDDIT_READER_COMMENT_PARTIAL_IDLE_MS` is `0` by default and can insert a small delay between sequential partial requests if a local run needs it.

Comment extraction remains best-effort. Reddit DOM structure and `/svc/shreddit/more-comments/` partial endpoints may change. If relevant partial requests fail, remain unresolved, or hit configured limits, the worker keeps usable extracted comments and adds `partial_comments`. This work order does not add OAuth/API, Reddit login, personal cookies, proxy rotation, stealth plugins, CAPTCHA/verification bypass, or anti-bot behavior.

## External Extractor Mode

`REDDIT_READER_EXTRACTION_MODE` may be:

- `playwright`: the app runtime performs Reddit Playwright extraction directly.
- `external`: the app runtime calls `REDDIT_READER_EXTERNAL_EXTRACTOR_URL`, normally a private endpoint reachable through a reverse SSH tunnel to the owner's laptop.

`EXTRACTOR_PROVIDER` is the newer explicit selector used by the provider layer:

- `local-playwright`: run Playwright extraction in the app process.
- `remote-http`: call a private HTTP extractor endpoint.
- `auto`: derive the provider from `REDDIT_READER_EXTRACTION_MODE`.

`REDDIT_READER_EXTRACTION_MODE=external` remains supported and maps to `EXTRACTOR_PROVIDER=remote-http`.

For `external` mode, set:

```text
REDDIT_READER_EXTRACTION_MODE=external
REDDIT_READER_EXTERNAL_EXTRACTOR_URL=http://127.0.0.1:<vps_extractor_port>/extract
REDDIT_READER_EXTERNAL_EXTRACTOR_TOKEN=<same private token as the laptop agent, if configured>
```

The newer aliases are also supported:

```text
EXTRACTOR_PROVIDER=remote-http
EXTRACTOR_REMOTE_URL=http://127.0.0.1:<vps_extractor_port>/extract
EXTRACTOR_TOKEN=<same private token as the laptop agent, if configured>
```

If the configured extractor endpoint is offline, refused, timed out, or unauthorized, the job fails quickly with a safe status/error pair such as `extraction_unavailable` + `extractor_unavailable`, `timeout` + `extractor_timeout`, or `extraction_unavailable` + `extractor_unauthorized`. It does not poll continuously.

The remote provider uses the `extractor.v1` request/response contract documented in `docs/extractor-protocol-v1.md`. It writes `extractor-report.json` and exposes a Bearer-protected safe summary through `GET /api/diagnostics/extractor`.

The remote provider also has a process-local circuit breaker. After `EXTRACTOR_MAX_CONSECUTIVE_FAILURES` failures it temporarily refuses more remote extraction attempts for `EXTRACTOR_CIRCUIT_COOLDOWN_MS`. This is an MVP guard against repeated immediate tunnel failures, not durable queue management.

The laptop extractor agent is started with `npm run start:extractor-agent` and uses:

```text
REDDIT_READER_EXTRACTOR_AGENT_HOST=127.0.0.1
REDDIT_READER_EXTRACTOR_AGENT_PORT=4181
REDDIT_READER_EXTRACTOR_AGENT_TOKEN=<optional private token>
```

The external mode is a placement change, not a Reddit auth-mode change. Reddit egress happens from the laptop; Codex/OpenAI translation, validation, rendering, and `/t/:jobId` remain on the app runtime. See `docs/laptop-extractor-agent.md`.

## Codex CLI

The product default command is:

```text
codex
```

`CODEX_CLI_PATH` is an optional local override for hosts where Codex CLI is not on `PATH`. A host-specific path such as `D:\Codex\_opscontrol\bin\codex.cmd` is local tooling configuration, not a product default. The app does not inspect credentials or private Codex configuration.

On Windows, a `.cmd` or `.bat` `CODEX_CLI_PATH` must not contain whitespace for this MVP shim wrapper. Put Codex CLI on `PATH` or use a no-space wrapper path if the installed location contains spaces.

`CODEX_CLI_EXTRA_ARGS` is optional and empty by default. The worker uses an incremental translation pipeline by default:

- post title/body plus the first comment batch with `schemas/translated-initial-batch.schema.json` when comments exist;
- post title/body alone with `schemas/translated-post.schema.json` only when there are no comments or an alternate translator implementation does not expose the initial-batch method;
- remaining comments in ordered batches with `schemas/translated-comment-batch.schema.json`;
- final assembled thread with `schemas/translated-thread.schema.json` and post-validation.

## Target Language

The content translation target is configurable. The public repository default is Ukrainian:

```text
REDDIT_READER_TARGET_LANGUAGE_CODE=uk
REDDIT_READER_TARGET_LANGUAGE_NAME=Ukrainian
REDDIT_READER_TARGET_LOCALE=uk-UA
```

Set it explicitly for another reader native language when a deployment needs that:

```text
REDDIT_READER_TARGET_LANGUAGE_CODE=es
REDDIT_READER_TARGET_LANGUAGE_NAME=Spanish
REDDIT_READER_TARGET_LOCALE=es-ES
```

Change these values to translate Reddit threads into another native language, for example:

```text
REDDIT_READER_TARGET_LANGUAGE_CODE=de
REDDIT_READER_TARGET_LANGUAGE_NAME=German
REDDIT_READER_TARGET_LOCALE=de-DE
```

Codex prompts and translation inputs include this target language. Fixed-output schemas allow a configurable language code, and runtime validation enforces the configured code before the translated thread is accepted. The reader chrome is intentionally minimal; the main product behavior is translating Reddit post/comment content into the configured target language.

Comment batches are controlled by `REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS`, `REDDIT_READER_TRANSLATION_BATCH_MAX_CHARS`, `REDDIT_READER_TRANSLATION_CONCURRENCY`, and `REDDIT_READER_CODEX_BATCH_TIMEOUT_MS`. Later batches may finish before earlier batches, but the reader exposes only the contiguous translated prefix so comment order remains stable. If one or more batches fail, the job may finish as `ready_with_warning` with `partial_translation` and safe batch error summaries in diagnostics/progress.

Codex numeric usage history is controlled by `REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT`. The default keeps the latest 30 translation reports; the implementation caps this at 100 to keep the debug page bounded.

Each Codex call includes the same core command shape:

```text
exec --strict-config -c model_reasoning_effort="<CODEX_REASONING_EFFORT>" --model <CODEX_MODEL> --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check --json --output-schema <schema> --output-last-message <fixed-output-path>
```

The schema/output flags are required for the candidate implementation. Defaults are `CODEX_MODEL=gpt-5.5` and `CODEX_REASONING_EFFORT=high`; ops may set `CODEX_REASONING_EFFORT=medium` or another supported effort when cost/latency tradeoffs require it. If an installed Codex CLI version cannot support the schema/output flags or the configured model/effort, record that as a host/tool version limit and rely only on prompt plus post-validation for that run. Do not claim schema-enforced Codex output unless those flags actually ran. No fallback translation provider is configured or implemented.

## Privacy And Logging

- `/t/:jobId` uses unguessable `jobId` access only for the local MVP.
- `POST /api/threads` uses Bearer auth.
- Diagnostics use Bearer auth.
- Tokens, Bearer values, and full `/t/:jobId` view URLs are redacted from worker logs and diagnostic log tails.
- `/codex-usage`, `/api/codex-usage`, and `/results/:jobId` are diagnostics-auth protected by default. The first two must remain telemetry-safe and must not expose original Reddit text, source URLs, prompts, command strings, worker logs, Codex event logs, secrets, raw artifacts, screenshots, or full reader URLs. `/results/:jobId` renders translated reader content and is therefore protected by the same default gate.

## Live Reddit Runtime Boundary

The current product extraction strategy is unauthenticated browser-render HTML through Playwright. Direct local live proof is runtime-specific evidence only. It does not prove an isolated VPS will work, because Reddit may treat datacenter IPs, headless sessions, TLS/DNS paths, verification flows, or rate limits differently.

If direct VPS extraction returns verification/block pages, use `external` mode with the laptop extractor agent and prove the full product chain while the reverse tunnel is active. This MVP does not select or prefer OAuth/API, cookies, proxy rotation, or anti-bot behavior. Optional live probes are diagnostic only and do not create product scope.

## Runtime Storage

Runtime files are written under:

```text
runtime/
```

`runtime/latest` contains the current latest-job artifact set. Scratch directories under `runtime/work` are temporary and are discarded after the worker publishes or detects a stale job. Runtime storage is ignored by git.

`runtime/latest-job-state.json` is a file-backed local state snapshot for the latest-job model. It persists the current job id, generation, safe status fields, URLs, stage timestamps, safe warning/error fields, artifact manifest, and current-latest marker for the active local runtime. On startup, the local candidate reloads the latest published terminal job from this snapshot and `runtime/latest` so `/t/:jobId` and diagnostics can reflect that job after restart. In-flight workers are not resumed after restart.

`runtime/codex-usage-history.json` is a rolling numeric-only telemetry history for `/codex-usage` and `/api/codex-usage`. The HTML page polls the JSON endpoint in the browser and updates without a full page reload. It stores safe per-job summaries, result links, timing, counts, and token aggregates, not source content, prompts, logs, command strings, credentials, or debug artifacts. `runtime/latest/codex-usage-report.json` is the latest job's per-job numeric report and is included in the latest artifact manifest when Codex translation was attempted.

`runtime/saved-results` stores static translated result HTML pages for successful jobs. These pages are served at `/results/:jobId` and pruned to the same `REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT` window. They render translated reader content and Reddit outbound links, so they are intentionally different from the numeric-only telemetry API.
