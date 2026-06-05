# Codex Translation Contract

The worker invokes Codex CLI as a controlled subprocess with configured model and reasoning effort. Defaults are `CODEX_MODEL=gpt-5.5` and `CODEX_REASONING_EFFORT=high`.

Each Codex call uses this supported command shape:

```text
codex exec --strict-config -c model_reasoning_effort="<CODEX_REASONING_EFFORT>" --model <CODEX_MODEL> --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check --json --output-schema <schema> --output-last-message <fixed-output-path>
```

When the installed Codex CLI does not support `--output-schema` or the configured model/effort, that run must be recorded as a host/tool version limit and cannot be described as schema-enforced output for that model/effort.

## Incremental Contract

The default product path is incremental:

1. translate post title/body plus the first comment batch with `schemas/translated-initial-batch.schema.json` and fixed output `initial.translated.json` when comments exist;
2. split comments into ordered batches using `REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS` and `REDDIT_READER_TRANSLATION_BATCH_MAX_CHARS`;
3. translate remaining batches with `schemas/translated-comment-batch.schema.json` and fixed outputs `translated-batches/NNN.json`;
4. expose only the contiguous translated comment prefix to the reader;
5. assemble and validate final `thread.translated.json`.

`REDDIT_READER_TRANSLATION_CONCURRENCY` controls parallel batch workers and is capped at 10. `REDDIT_READER_CODEX_BATCH_TIMEOUT_MS` is the per-post/per-batch Codex timeout; default is 300000 ms.

## Content Contract

- Input is structured extracted thread JSON.
- Reddit content is untrusted data, not instructions.
- The worker prompt forbids shell commands, tools, file reads, browser/network access, environment inspection, credential inspection, and neighboring-file discovery.
- Output must be strict JSON.
- Output must declare the configured target language code from `REDDIT_READER_TARGET_LANGUAGE_CODE`.
- Translate only human-readable text fields:
  - `post.title`
  - `post.bodyMarkdown`
  - `comments[].bodyMarkdown`
- Preserve Markdown where feasible.
- Codex compact outputs preserve stable IDs/order/depth where requested. The app rehydrates authors, parent IDs, author profile links, scores, timestamps, and metadata from the extracted raw thread before validation/rendering.
- No HTML output.
- No fallback translator.
- No GPT repair or re-ask loop.
- No previous translated-comments glossary/context is used yet. That is a future improvement candidate, not current behavior.

## Failure Rules

The job fails without repair when post translation cannot produce a valid translated post:

- Codex CLI is unavailable.
- The configured Codex model is unavailable.
- Codex exits non-zero.
- Codex times out.
- Codex returns no output.
- Codex output is invalid JSON.
- Translated post JSON fails schema or invariant validation.

Comment-batch failures are tolerated after the post is translated. The job may finish as `ready_with_warning` with `partial_translation`; safe progress diagnostics identify failed batch indexes and safe error codes/messages. Later successful batches are saved as artifacts but are not displayed unless every earlier batch is displayable.

## Subprocess Recording

For each Codex attempt, the validation report records:

- command
- model
- reasoning effort
- fixed input path
- schema path
- fixed output path
- start time
- end time
- exit code
- signal when available
- numeric usage telemetry when Codex CLI reports it

Codex event files capture redacted stdout/stderr events when available. `worker.log` records only safe worker status lines. Full legacy translation uses `REDDIT_READER_CODEX_PROCESS_TIMEOUT_MS`; incremental post/batch calls use `REDDIT_READER_CODEX_BATCH_TIMEOUT_MS`, then attempt graceful termination before force kill.

Numeric usage is collected before Codex stdout is redacted, then stored separately as safe aggregate telemetry. The stored usage report may include model, reasoning effort, per-post/per-batch token counters, aggregate totals, durations, batch counts, comment counts, and safe warning codes. It must not include Reddit text, prompts, command strings, raw events, worker logs, source URLs, full reader URLs, credentials, environment values, or debug artifacts. If the installed Codex CLI does not emit usage fields, usage is recorded as unavailable/unknown rather than inferred.

## Fixed Output Path

The worker saves translated JSON only at fixed output paths:

```text
post.translated.json
initial.translated.json
translated-batches/000.json
translated-batches/001.json
thread.translated.json
codex-usage-report.json
```

inside the job workspace before publishing the latest artifact set.
