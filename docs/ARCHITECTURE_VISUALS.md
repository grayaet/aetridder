# Architecture Visuals

Status: educational architecture notes for the current Reddit Reader MVP.

This page explains the current implementation shape with diagrams. It is not a new product promise, not deployment approval, not owner Acceptance, and not a replacement for source code, tests, or ops handoff notes.

## 1. System Overview

The accepted runtime splits Reddit extraction from translation/rendering. The laptop performs browser-render extraction because direct VPS Reddit access may be blocked. The VPS remains the product runtime for API, state, validation, Codex translation, artifacts, diagnostics, and reader UI.

```mermaid
flowchart LR
    User["User / iPhone"] --> Shortcut["iOS Shortcut"]
    Shortcut --> API["VPS API / Express"]
    API --> State["Latest-job state<br/>memory + latest-job-state.json"]
    API --> Worker["In-process worker"]
    Worker --> Provider["ExtractorProvider boundary"]
    Provider --> RemoteProvider["RemoteHttpExtractorProvider"]
    RemoteProvider --> Tunnel["Reverse SSH tunnel"]
    Tunnel --> Agent["Laptop extractor-agent"]
    Agent --> Reddit["Rendered Reddit page"]
    Worker --> Validator1["Raw thread validator"]
    Validator1 --> Codex["Codex CLI / GPT-5.5"]
    Codex --> Validator2["Translated thread validator"]
    Validator2 --> Artifacts["runtime/latest artifacts"]
    Artifacts --> Reader["Reader UI / /t/:jobId"]
    Artifacts --> Diagnostics["Bearer-protected diagnostics"]
```

Key idea: the laptop is an extractor station, not a second app server and not a translator. Codex/OpenAI translation stays on the VPS runtime.

## 2. Normal Successful Job

This is the happy path when the laptop extractor-agent and reverse tunnel are active, Reddit extraction succeeds, and Codex writes the translated JSON to the fixed output path.

```mermaid
sequenceDiagram
    autonumber
    actor User as "User / iPhone"
    participant Shortcut as "iOS Shortcut"
    participant API as "VPS API"
    participant State as "Latest-job state"
    participant Worker as "Worker"
    participant Provider as "Remote extractor provider"
    participant Agent as "Laptop extractor-agent"
    participant Reddit as "Reddit page"
    participant Files as "Runtime files"
    participant Codex as "Codex CLI"
    participant UI as "Reader UI"

    User->>Shortcut: "Share Reddit URL"
    Shortcut->>API: "POST /api/threads + Bearer token"
    API->>API: "Validate and normalize URL"
    API->>State: "Create queued latest job"
    API-->>Shortcut: "jobId + viewUrl"
    Shortcut->>UI: "Open /t/:jobId"
    API->>Worker: "Schedule job"

    Worker->>State: "status=extracting"
    Worker->>Provider: "extract(job)"
    Provider->>Agent: "POST /extract extractor.v1"
    Agent->>Reddit: "Playwright render + partial comments"
    Reddit-->>Agent: "DOM / partial HTML"
    Agent-->>Provider: "rawThread JSON"
    Provider-->>Worker: "thread + extractorReport"

    Worker->>Files: "Write thread.raw.json + extractor-report.json"
    Worker->>Worker: "Validate raw thread"
    Worker->>State: "status=translating"
    Worker->>Codex: "codex exec with schema + fixed output path"
    Codex-->>Files: "thread.translated.json"
    Worker->>Worker: "Validate translated thread"
    Worker->>Files: "Write validation-report.json + artifact-manifest.json"
    Worker->>State: "status=ready or ready_with_warning"
    UI->>API: "GET /t/:jobId refresh"
    API-->>UI: "Translated reader page"
```

Important invariant: `ready_with_warning` is still a successful terminal state. For example, `partial_comments` means the reader result is usable but extraction could not prove all comment expansion was complete.

## 3. Extractor Unavailable Failure

The extractor path should fail quickly and safely when the reverse tunnel or laptop agent is unavailable. It should not poll continuously or expose internal logs/secrets to the reader.

```mermaid
sequenceDiagram
    autonumber
    participant API as "VPS API"
    participant Worker as "Worker"
    participant Provider as "RemoteHttpExtractorProvider"
    participant Tunnel as "Reverse SSH tunnel"
    participant Files as "Runtime files"
    participant State as "Latest-job state"
    participant UI as "Reader UI"
    participant Diag as "Diagnostics"

    API->>Worker: "Schedule latest job"
    Worker->>State: "status=extracting"
    Worker->>Provider: "extract(job)"
    Provider->>Tunnel: "POST /extract"
    Tunnel--xProvider: "refused / timeout / unauthorized"
    Provider-->>Worker: "typed safe error"
    Worker->>Files: "extractor-report.json"
    Worker->>Files: "validation-report.json + worker.log"
    Worker->>State: "terminal failure status + safe errorCode"
    UI->>API: "GET /t/:jobId"
    API-->>UI: "Safe error page"
    Diag->>API: "GET /api/diagnostics/extractor"
    API-->>Diag: "Safe provider summary, no secrets"
```

Typical safe outcomes:

- `extraction_unavailable` + `extractor_unavailable`
- `extraction_unavailable` + `extractor_unauthorized`
- `timeout` + `extractor_timeout`
- `reddit_unavailable` + `reddit_verification_or_block_page`

## 4. Job State Machine

The app is a single-slot latest-job system. A new job replaces the previous one. Scratch work directories are discarded after publish or stale-job detection.

```mermaid
stateDiagram-v2
    [*] --> queued: "POST /api/threads"
    queued --> extracting: "worker starts"
    extracting --> extracted: "rawThread accepted"
    extracting --> extraction_unavailable: "extractor offline / unauthorized"
    extracting --> reddit_unavailable: "Reddit block / verification"
    extracting --> timeout: "extractor timeout"
    extracting --> extraction_failed: "raw validation failed"

    extracted --> translating: "raw artifacts saved"
    translating --> validating: "translated file written"
    translating --> translation_failed: "Codex failure / missing output"
    translating --> timeout: "translation timeout"

    validating --> ready: "translated validation ok, no warnings"
    validating --> ready_with_warning: "translated validation ok, warningCodes present"
    validating --> validation_failed: "translated validation failed"

    queued --> replaced: "newer job submitted"
    extracting --> replaced: "newer job submitted"
    extracted --> replaced: "newer job submitted"
    translating --> replaced: "newer job submitted"
    validating --> replaced: "newer job submitted"

    ready --> [*]
    ready_with_warning --> [*]
    extraction_unavailable --> [*]
    reddit_unavailable --> [*]
    extraction_failed --> [*]
    translation_failed --> [*]
    validation_failed --> [*]
    timeout --> [*]
    replaced --> [*]
```

Operational note: smoke scripts must stop on both `ready` and `ready_with_warning`.

## 5. Extractor Provider Boundary

The provider boundary lets the worker stay stable while extraction placement changes.

```mermaid
flowchart TD
    Worker["Worker<br/>processJob(job)"] --> Interface["ExtractorProvider<br/>extract(job, context)<br/>diagnostics()"]

    Interface --> Remote["RemoteHttpExtractorProvider"]
    Interface --> Local["LocalPlaywrightExtractorProvider"]
    Interface --> Fixture["FixtureExtractorProvider"]

    Remote --> Protocol["extractor.v1 request/response"]
    Protocol --> Agent["Laptop extractor-agent"]
    Agent --> Browser["Playwright / Chromium"]
    Browser --> Reddit["Reddit rendered page"]

    Local --> LocalBrowser["Playwright / Chromium in app runtime"]
    LocalBrowser --> Reddit

    Fixture --> Tests["Deterministic fixtures"]

    Remote --> Report["extractor-report.json"]
    Local --> Report
    Fixture --> Report
```

Why this matters: `remote-http` is a deployment placement choice, not a different product feature. It does not add Reddit OAuth/API, cookies, proxy behavior, or fallback translation.

## 6. Artifact Flow

Artifacts are the evidence trail for one latest job. The reader-facing API only exposes safe translated reader data, while diagnostics and local files hold richer evidence.

```mermaid
flowchart LR
    A["Extractor Agent"] --> B["rawThread JSON"]
    B --> C["Raw validator"]
    C --> D["thread.raw.json"]
    C --> R["extractor-report.json"]
    D --> E["Codex GPT-5.5"]
    E --> F["thread.translated.json"]
    F --> G["Translation validator"]
    G --> H["validation-report.json"]
    H --> I["artifact-manifest.json"]
    I --> J["Reader UI"]
    I --> K["Diagnostics"]
    E --> L["codex-events.jsonl"]
    E --> M["worker.log"]
```

Reader-facing rule: `/api/view/:jobId` and `/t/:jobId` must not expose original English bodies, raw HTML, screenshots, worker logs, Codex event logs, or validation internals.

## 7. Control-Loop Analogy

This is not literal industrial control software, but the analogy is useful for understanding the shape of the system: the user issues a command, the worker controls a process, sensors return structured state, quality gates validate, and the UI reports back.

```mermaid
flowchart TD
    Operator["Operator<br/>iPhone User"] --> Command["Command<br/>Share URL"]
    Command --> Controller["Controller<br/>VPS Worker"]
    Controller --> Actuator["Actuator<br/>Laptop Extractor"]
    Actuator --> Process["Process<br/>Reddit page rendering"]
    Process --> Sensor["Sensor output<br/>rawThread JSON"]
    Sensor --> Controller
    Controller --> Quality["Quality Gate<br/>schema/invariant validation"]
    Quality --> Translator["Translator<br/>Codex GPT-5.5"]
    Translator --> Quality2["Quality Gate<br/>translated JSON validation"]
    Quality2 --> HMI["HMI<br/>Native-language Reader UI"]
    HMI --> Operator
```

The useful lesson from the analogy: the system becomes easier to reason about when each boundary has a clear signal:

- command: Reddit URL
- sensor output: `rawThread`
- quality gates: schema and invariant validation
- actuator health: extractor diagnostics
- HMI: native-language reader page and safe warning/error states

## 8. EPC Process View

EPC notation describes a process as alternating events and functions, with logical connectors such as AND and XOR. Mermaid does not provide a native EPC renderer, so this diagram uses EPC-compatible conventions:

- events: hexagons
- functions: rectangles
- connectors: circles labeled `AND` or `XOR`

```mermaid
flowchart TD
    E0{{"Event: Reddit URL available from Share Sheet"}}:::event
    F1["Function: iOS Shortcut performs local URL precheck"]:::function
    E1{{"Event: Candidate Reddit URL accepted"}}:::event
    F2["Function: POST /api/threads with Bearer token"]:::function
    E2{{"Event: Latest job created as queued"}}:::event
    A1(("AND")):::connector
    F3["Function: Open reader URL on phone"]:::function
    F4["Function: Schedule worker in VPS process"]:::function
    E3{{"Event: Reader shows loading state"}}:::event
    E4{{"Event: Worker starts extraction"}}:::event
    F5["Function: Call ExtractorProvider"]:::function
    X1(("XOR")):::connector

    E0 --> F1 --> E1 --> F2 --> E2 --> A1
    A1 --> F3 --> E3
    A1 --> F4 --> E4 --> F5 --> X1

    X1 -->|"remote extractor unavailable"| F6["Function: Record extractor failure safely"]:::function
    F6 --> E5{{"Event: Terminal failure visible as safe error"}}:::event

    X1 -->|"rawThread returned"| E6{{"Event: Raw thread received"}}:::event
    E6 --> F7["Function: Validate raw thread schema and usability"]:::function
    F7 --> X2(("XOR")):::connector

    X2 -->|"invalid raw thread"| F8["Function: Write validation failure artifacts"]:::function
    F8 --> E7{{"Event: Terminal extraction_failed"}}:::event

    X2 -->|"valid raw thread"| E8{{"Event: Raw thread accepted"}}:::event
    E8 --> F9["Function: Write thread.raw.json and extractor-report.json"]:::function
    F9 --> E9{{"Event: Raw evidence persisted"}}:::event
    E9 --> F10["Function: Run Codex CLI with fixed output path"]:::function
    F10 --> X3(("XOR")):::connector

    X3 -->|"Codex timeout or missing output"| F11["Function: Record translation failure safely"]:::function
    F11 --> E10{{"Event: Terminal translation_failed or timeout"}}:::event

    X3 -->|"translated JSON written"| E11{{"Event: Translation candidate available"}}:::event
    E11 --> F12["Function: Validate translated JSON invariants"]:::function
    F12 --> X4(("XOR")):::connector

    X4 -->|"invalid translation"| F13["Function: Write validation failure artifacts"]:::function
    F13 --> E12{{"Event: Terminal validation_failed"}}:::event

    X4 -->|"valid with no warnings"| F14["Function: Publish latest artifacts"]:::function
    F14 --> E13{{"Event: Job ready"}}:::event

    X4 -->|"valid with warnings"| F15["Function: Publish latest artifacts with warningCodes"]:::function
    F15 --> E14{{"Event: Job ready_with_warning"}}:::event

    E13 --> F16["Function: Render translated reader UI"]:::function
    E14 --> F16
    F16 --> E15{{"Event: User reads translated thread"}}:::event

    classDef event fill:#fff7e6,stroke:#b26b00,stroke-width:1px,color:#1f1f1f;
    classDef function fill:#eef6ff,stroke:#245c99,stroke-width:1px,color:#1f1f1f;
    classDef connector fill:#ffffff,stroke:#333333,stroke-width:1px,stroke-dasharray:3 3,color:#1f1f1f;
```

EPC reading tip: events describe facts that have become true, while functions describe work the system performs. The XOR points are where one path is selected: failure, invalid artifact, valid artifact, or successful terminal state.

## Reading Map

- `docs/hybrid-extraction-mode.md`: current laptop/VPS extraction architecture.
- `docs/extractor-protocol-v1.md`: remote extractor request/response contract.
- `docs/ops-production-overrides.md`: deployment-owned production config memory.
- `docs/configuration.md`: environment variables and local defaults.
- `runtime/latest/artifact-manifest.json`: latest runtime artifact inventory when the app has run.
