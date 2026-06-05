# Extractor Protocol v1

Status: internal MVP contract between the app worker and a private extractor provider.

The protocol exists to keep Reddit extraction placement separate from product behavior. The VPS app owns the job lifecycle, validation, Codex translation, artifact publication, diagnostics, and reader UI. A remote laptop agent owns only browser-render Reddit extraction.

This protocol does not add OAuth/API extraction, Reddit login, cookies, proxies, stealth plugins, CAPTCHA bypass, fallback translators, or original-text display.

## Request

Schema: `schemas/extractor-request.schema.json`

```json
{
  "protocolVersion": "extractor.v1",
  "jobId": "opaque-job-id",
  "generation": 1,
  "requestId": "opaque-attempt-id",
  "sourceUrl": "https://www.reddit.com/r/example/comments/abc/title/",
  "normalizedUrl": "https://www.reddit.com/r/example/comments/abc/title/",
  "limits": {
    "maxComments": 1000,
    "maxPartialRequests": 50,
    "timeoutMs": 90000,
    "maxArtifactBytes": 10485760
  }
}
```

`jobId`, `generation`, and `requestId` are echoed in the response. The worker rejects a success response when `jobId` or `generation` does not match the active job.

## Success Response

Schema: `schemas/extractor-response.schema.json`

```json
{
  "protocolVersion": "extractor.v1",
  "ok": true,
  "jobId": "opaque-job-id",
  "generation": 1,
  "requestId": "opaque-attempt-id",
  "rawThread": {},
  "warningCodes": ["partial_comments"],
  "metrics": {
    "visibleCommentCount": 10,
    "extractedUniqueCommentCount": 25,
    "discoveredMoreRequestCount": 3,
    "uniqueMoreRequestCount": 3,
    "fetchedMoreRequestCount": 2,
    "failedMoreRequestCount": 1,
    "unresolvedMoreRequestCount": 1,
    "partialArtifactsCount": 2
  },
  "extractor": {
    "provider": "local-playwright",
    "agentVersion": "aetridder-extractor-agent.v1",
    "startedAt": "2026-06-03T00:00:00.000Z",
    "endedAt": "2026-06-03T00:00:01.000Z",
    "browserReady": true
  }
}
```

The `rawThread` value must match `schemas/extracted-thread.schema.json` after the worker validates it. `partial_comments` remains a warning, not a fatal error, when useful comments were extracted but more-comment expansion was unresolved or bounded.

## Error Response

Schema: `schemas/extractor-error.schema.json`

```json
{
  "protocolVersion": "extractor.v1",
  "ok": false,
  "jobId": "opaque-job-id",
  "generation": 1,
  "requestId": "opaque-attempt-id",
  "errorCode": "reddit_verification_or_block_page",
  "errorMessageSafe": "Reddit returned a verification or block page.",
  "retryable": true,
  "extractor": {
    "provider": "local-playwright",
    "agentVersion": "aetridder-extractor-agent.v1",
    "startedAt": "2026-06-03T00:00:00.000Z",
    "endedAt": "2026-06-03T00:00:01.000Z",
    "browserReady": true
  }
}
```

Safe error codes used by the worker:

- `extractor_unavailable`: tunnel or remote endpoint is offline or unreachable.
- `extractor_timeout`: extractor did not respond in time.
- `extractor_unauthorized`: shared token mismatch or missing auth.
- `extractor_bad_response`: remote endpoint returned invalid JSON or a nonsuccess HTTP response that is not a known Reddit block condition.
- `extractor_schema_invalid`: response did not match the requested job or protocol.
- `reddit_verification_or_block_page`: Reddit served a verification or block page to the extractor.
- `reddit_login_gated`: Reddit required login for the page.
- `reddit_unavailable`: other safe Reddit availability failure.

## Compatibility

The remote provider still accepts a legacy success body with `thread` or `rawThread` and no `protocolVersion` for local tests and old helper scripts. New laptop agents should return `extractor.v1`.

Legacy success compatibility is not treated as schema-enforced proof. A run should only claim extractor protocol proof when the request and response used `protocolVersion: extractor.v1`.

## Evidence

Each extraction attempt writes `extractor-report.json` when it reaches or fails inside a provider. The report includes provider, protocol version, agent version when available, duration, parser metrics, warning codes, safe error code, and nonsecret transport metadata.

Diagnostics expose only safe summary fields through `GET /api/diagnostics/extractor`. They must not expose tokens, raw HTML, original bodies, screenshots, worker logs, Codex logs, or full artifact contents.
