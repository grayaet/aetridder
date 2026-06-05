# Laptop Extractor Agent

Status: MVP support for VPS environments where Reddit blocks direct unauthenticated Playwright extraction from a datacenter host.

## Architecture

- The VPS app still owns `POST /api/threads`, status, diagnostics, Codex CLI translation, validation, artifact publication, and `/t/:jobId` rendering.
- The laptop agent owns only Reddit browser-render extraction.
- The laptop opens an outbound reverse SSH tunnel to the VPS.
- No public inbound port is required on the laptop.
- The extractor endpoint must remain private: bind to loopback or a private Docker network only.
- This is not OAuth/API extraction, not Reddit login/cookies, not proxy rotation, and not anti-bot behavior.

## Laptop

Install dependencies in the same product source folder:

```powershell
npm ci
npx playwright install chromium
```

Start the extractor agent:

```powershell
$env:REDDIT_READER_EXTRACTOR_AGENT_HOST="127.0.0.1"
$env:REDDIT_READER_EXTRACTOR_AGENT_PORT="4181"
$env:REDDIT_READER_EXTRACTOR_AGENT_TOKEN="<private shared token>"
npm run start:extractor-agent
```

The agent exposes:

- `GET /health`
- `POST /extract`

If `REDDIT_READER_EXTRACTOR_AGENT_TOKEN` is set, both endpoints require `Authorization: Bearer <token>`.

`POST /extract` accepts the `extractor.v1` request documented in `docs/extractor-protocol-v1.md` and returns either a matching `rawThread` success response or a safe extractor error response. Older local helper requests with `{ "url": "..." }` are still accepted by the agent for manual smoke checks.

## Reverse SSH Tunnel

From the laptop, open an outbound tunnel to the VPS:

```powershell
ssh -N -R 127.0.0.1:4182:127.0.0.1:4181 <vps_user>@<vps_host>
```

This example means:

- laptop agent: `127.0.0.1:4181`
- VPS tunnel endpoint: `127.0.0.1:4182`
- VPS app should call: `http://127.0.0.1:4182/extract`

Use `ExitOnForwardFailure=yes` in operational scripts if the tunnel must fail fast when the remote port cannot be created.

## VPS App Env

Configure the VPS app:

```text
REDDIT_READER_EXTRACTION_MODE=external
REDDIT_READER_EXTERNAL_EXTRACTOR_URL=http://127.0.0.1:4182/extract
REDDIT_READER_EXTERNAL_EXTRACTOR_TOKEN=<same private shared token>
```

The explicit provider aliases are also supported:

```text
EXTRACTOR_PROVIDER=remote-http
EXTRACTOR_REMOTE_URL=http://127.0.0.1:4182/extract
EXTRACTOR_TOKEN=<same private shared token>
```

Keep the existing VPS values for:

```text
REDDIT_READER_API_TOKEN
REDDIT_READER_DIAGNOSTICS_TOKEN
CODEX_CLI_PATH
```

## Docker Networking Note

Inside a Docker container, `127.0.0.1` means the container itself, not necessarily the VPS host.

Ops must make the reverse tunnel endpoint reachable from the app container by one of these private approaches:

- run the SSH tunnel inside the same app container or a sidecar on the same Docker network;
- expose the tunnel on a Docker-private address and set `REDDIT_READER_EXTERNAL_EXTRACTOR_URL` to that address;
- use `host.docker.internal` with Linux `host-gateway` mapping, for example `http://host.docker.internal:4182/extract`.

Do not expose `/extract` publicly through Caddy.

## Expected Failure Behavior

If the laptop agent or tunnel is unavailable, jobs should fail quickly with:

- status: `extraction_unavailable`
- errorCode examples: `extractor_unavailable`, `extractor_timeout`, `extractor_unauthorized`

The app does not poll repeatedly. Each Reddit job attempts the configured extractor endpoint once within `REDDIT_READER_EXTRACTION_TIMEOUT_MS`.

`GET /api/diagnostics/extractor` on the VPS app is Bearer protected and returns safe provider health/last-attempt/circuit summary fields. It must not expose the shared token, Reddit HTML, screenshots, raw bodies, worker logs, Codex logs, or artifact contents.

## Acceptance Smoke

With the laptop agent and reverse tunnel active:

1. `GET /health` through the VPS-visible tunnel endpoint returns `ok: true`; include `Authorization: Bearer <token>` when `REDDIT_READER_EXTRACTOR_AGENT_TOKEN` is configured.
2. Submit a real Reddit thread to the VPS app with `POST /api/threads`.
3. The VPS job reaches `ready` or `ready_with_warning`.
4. `thread.raw.json` shows Reddit extraction metadata from the laptop extraction run.
5. `extractor-report.json` shows `extractorProvider=remote-http`, `protocolVersion=extractor.v1`, and the safe parser metrics.
6. Codex translation artifacts are produced on the VPS.
7. `/t/:jobId` renders the translated reader page from the VPS app.

This proves the selected local-host-extraction/VPS-translation MVP path. It does not prove direct Reddit extraction from the VPS.
