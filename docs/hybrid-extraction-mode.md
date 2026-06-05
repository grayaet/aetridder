# Hybrid Extraction Mode

Status: current MVP architecture after VPS direct Reddit extraction proved blocked by Reddit verification pages.

The product still has one extraction strategy: unauthenticated browser-render Reddit HTML through Playwright. The hybrid mode changes where that browser extraction runs. It does not add Reddit OAuth/API, cookies, login, proxies, anti-bot behavior, fallback translators, deployment adoption, or archive scope.

## Current Components

```mermaid
flowchart LR
    User["User / iPhone Shortcut"] --> API["VPS API / Express"]
    API --> Worker["In-process Worker"]
    Worker --> Provider["ExtractorProvider boundary"]
    Provider --> Remote["RemoteHttpExtractorProvider"]
    Remote --> Tunnel["Reverse SSH tunnel"]
    Tunnel --> Agent["Laptop extractor-agent"]
    Agent --> Reddit["Reddit public rendered page"]
    Worker --> Codex["Codex CLI / GPT-5.5"]
    Worker --> Files["runtime/latest + job files"]
    API --> Reader["/t/:jobId Reader UI"]
```

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User as "User / iPhone"
    participant Shortcut as "iOS Shortcut"
    participant API as "VPS API / Express"
    participant State as "In-memory job map + latest-job-state.json"
    participant FS as "Runtime files"
    participant Worker as "In-process Worker"
    participant Provider as "ExtractorProvider"
    participant Tunnel as "Reverse SSH tunnel"
    participant Agent as "Laptop extractor-agent"
    participant Reddit as "Reddit public page"
    participant Codex as "Codex CLI / GPT-5.5"
    participant UI as "Reader UI / Safari"

    User->>Shortcut: "Share Reddit URL"
    Shortcut->>Shortcut: "Local Reddit URL precheck"
    Shortcut->>API: "POST /api/threads + Bearer token"
    API->>API: "Auth + allowlist + normalize URL"
    API->>State: "Create latest job queued, currentJobId, generation"
    API->>FS: "Reset runtime/latest"
    API-->>Shortcut: "jobId + viewUrl"
    Shortcut->>UI: "Open /t/:jobId"

    UI->>API: "GET /t/:jobId"
    API->>State: "Read job state"
    API-->>UI: "Loading HTML with meta refresh"

    API->>Worker: "scheduleJob(job) in same Node process"
    Worker->>FS: "Create runtime/work/<jobId>, worker.log"
    Worker->>State: "status=extracting"
    Worker->>Provider: "extract(job)"

    alt "remote extractor unavailable"
        Provider->>Tunnel: "POST /extract"
        Tunnel--xProvider: "connection refused / timeout / unauthorized"
        Provider-->>Worker: "typed extractor error"
        Worker->>FS: "extractor-report.json + validation-report.json + worker.log"
        Worker->>State: "status=extraction_failed or reddit_unavailable"
        API-->>UI: "Safe error placeholder on next /t refresh"
    else "laptop extractor active"
        Provider->>Tunnel: "POST /extract extractor.v1 request"
        Tunnel->>Agent: "Forward request to laptop localhost agent"
        Agent->>Agent: "Auth token check, URL normalize"
        Agent->>Reddit: "Playwright render public Reddit page"
        Reddit-->>Agent: "Rendered page / DOM / partial comments"
        Agent->>Agent: "Extract post + comments tree best-effort"
        Agent-->>Tunnel: "extractor.v1 rawThread response"
        Tunnel-->>Provider: "rawThread JSON"
        Provider-->>Worker: "thread + extractorReport"

        Worker->>Worker: "Validate extracted schema/usability"
        Worker->>FS: "Save thread.raw.json + extractor-report.json"
        Worker->>State: "status=extracted"
        Worker->>State: "status=translating"

        Worker->>Codex: "codex exec with configured model/effort + schema + fixed output path"
        Codex-->>FS: "Write thread.translated.json"
        Codex-->>Worker: "Exit code + JSONL/stdout/stderr evidence"
        Worker->>FS: "Save codex-events.jsonl + worker.log"

        Worker->>Worker: "Validate translated JSON, ids, order, metadata, counts"
        Worker->>FS: "Save validation-report.json + artifact-manifest.json"
        Worker->>FS: "Publish runtime/latest artifacts"
        Worker->>State: "status=ready or ready_with_warning"

        loop "Meta refresh until terminal state"
            UI->>API: "GET /t/:jobId"
            API->>State: "Read latest job"
            API-->>UI: "Loading / ready / warning / error HTML"
        end
    end
```

## Before And After

Before this refactor, the app selected extraction by calling either direct Playwright code or a remote HTTP helper from the worker. The behavior was working, but the boundary was implicit.

After this refactor, the worker calls an `ExtractorProvider` interface. Current providers:

- `RemoteHttpExtractorProvider`: VPS calls a private endpoint, usually through reverse SSH to the laptop agent.
- `LocalPlaywrightExtractorProvider`: app process performs local Playwright extraction directly.
- `FixtureExtractorProvider`: tests inject deterministic extraction.

The provider boundary makes extraction placement explicit while preserving the existing product promise: one latest Reddit thread, translated native-language reader page, no original-text display, no Reddit account actions, and no alternate translator.

## Limits

- The laptop extractor-agent must be running and reachable through the private tunnel for hybrid extraction.
- Direct VPS Playwright extraction remains runtime-specific and may be blocked by Reddit.
- The remote provider has a small local circuit breaker for repeated extractor failures. It is process-local, not durable, and only prevents repeated immediate calls during the configured cooldown.
- The app plus worker still run in one Node process for MVP simplicity. A separate worker process can be a future work order if throughput, isolation, or restart semantics become important.
- SQLite is still not used. Latest-job state remains file-backed plus in-memory, which fits the single-slot MVP.
