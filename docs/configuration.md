# Configuration

Configuration is read from environment variables. `MAX_COMMENTS = 1000` is owner-confirmed. The other numeric values below are Builder/PM implementation defaults, not owner business decisions.

| Environment variable | Default | Classification |
| --- | ---: | --- |
| `AETRIDDER_HTTP_PORT` | `4173` | implementation default |
| `AETRIDDER_MAX_COMMENTS` | `1000` | owner-confirmed |
| `AETRIDDER_EXTRACTION_TIMEOUT_MS` | `90000` | implementation default |
| `AETRIDDER_TRANSLATION_TIMEOUT_MS` | `180000` | implementation default |
| `AETRIDDER_TOTAL_JOB_TIMEOUT_MS` | `300000` | implementation default |
| `AETRIDDER_MAX_INPUT_CHARS` | `300000` | implementation default |
| `AETRIDDER_MAX_ARTIFACT_BYTES` | `10485760` | implementation default |
| `AETRIDDER_REDACTED_LOG_TAIL_BYTES` | `32768` | implementation default |
| `AETRIDDER_CODEX_PROCESS_TIMEOUT_MS` | `180000` | implementation default |

## Required Auth Values

`AETRIDDER_API_TOKEN` must be set for `POST /api/threads`. If it is missing, authenticated API requests return a server configuration error instead of accepting unauthenticated writes.

`AETRIDDER_DIAGNOSTICS_TOKEN` is optional. When unset, diagnostics use `AETRIDDER_API_TOKEN`.

Do not put tokens in URLs. Do not put secrets in `.env.example`.

## URL Hosts

`AETRIDDER_PUBLIC_URL_ALLOWLIST` defaults to:

```text
reddit.com,redd.it,www.reddit.com,old.reddit.com,new.reddit.com
```

The URL guard also accepts subdomains of `reddit.com` and rejects lookalike hosts such as `reddit.com.example`.

## Codex CLI

The product default command is:

```text
codex
```

`CODEX_CLI_PATH` is an optional local override for hosts where Codex CLI is not on `PATH`. A host-specific path such as `D:\Codex\_opscontrol\bin\codex.cmd` is local tooling configuration, not a product default. The app does not inspect credentials or private Codex configuration.

On Windows, a `.cmd` or `.bat` `CODEX_CLI_PATH` must not contain whitespace for this MVP shim wrapper. Put Codex CLI on `PATH` or use a no-space wrapper path if the installed location contains spaces.

`CODEX_CLI_EXTRA_ARGS` is optional and empty by default. The worker always includes:

```text
exec --strict-config -c model_reasoning_effort="high" --model gpt-5.5 --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check --json --output-schema schemas/translated-thread.schema.json --output-last-message <job-workspace>/thread.translated.json
```

The schema/output flags are required for the candidate implementation. The CLI translation worker uses GPT-5.5 with high reasoning effort. If an installed Codex CLI version cannot support the schema/output flags or high-effort config, record that as a host/tool version limit and rely only on prompt plus post-validation for that run. Do not claim schema-enforced Codex output unless those flags actually ran. No fallback translation provider is configured or implemented.

## Privacy And Logging

- `/t/:jobId` uses unguessable `jobId` access only for the local MVP.
- `POST /api/threads` uses Bearer auth.
- Diagnostics use Bearer auth.
- Tokens, Bearer values, and full `/t/:jobId` view URLs are redacted from worker logs and diagnostic log tails.

## Live Reddit Runtime Boundary

The current product extraction mode is unauthenticated browser-render HTML through Playwright. Local live proof is local-runtime evidence only. It does not prove an isolated VPS will work, because Reddit may treat datacenter IPs, headless sessions, TLS/DNS paths, verification flows, or rate limits differently.

Before declaring VPS readiness, first run the current Playwright browser-render path with `npm run test:live:reddit` from the intended VPS and require listing fetch, thread fetch, comments extraction, a fresh-browser-context retry, raw persisted output, parsed output, and verification/403/429 detection. This MVP does not select or prefer OAuth/API, cookies, or alternate extraction modes. Any future production extraction mode requires a separate owner-confirmed work order. Optional live probes are diagnostic only and do not create product scope.

## Runtime Storage

Runtime files are written under:

```text
runtime/
```

`runtime/latest` contains the current latest-job artifact set. Scratch directories under `runtime/work` are temporary and are discarded after the worker publishes or detects a stale job. Runtime storage is ignored by git.

`runtime/latest-job-state.json` is a file-backed local state snapshot for the latest-job model. It persists the current job id, generation, safe status fields, URLs, stage timestamps, safe warning/error fields, artifact manifest, and current-latest marker for the active local runtime. On startup, the local candidate reloads the latest published terminal job from this snapshot and `runtime/latest` so `/t/:jobId` and diagnostics can reflect that job after restart. In-flight workers are not resumed after restart.

