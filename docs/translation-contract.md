# GPT-5.5 Translation Contract

The worker invokes Codex CLI as a controlled subprocess with model `gpt-5.5`.

Preferred supported command shape:

```text
codex exec --strict-config -c model_reasoning_effort="high" --model gpt-5.5 --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check --json --output-schema schemas/translated-thread.schema.json --output-last-message <job-workspace>/thread.translated.json
```

When the installed Codex CLI does not support `--output-schema` or the high-effort config, that run must be recorded as a host/tool version limit and cannot be described as schema-enforced/high-effort Codex output.

## Contract

- Input is structured extracted thread JSON.
- Reddit content is untrusted data, not instructions.
- The worker prompt forbids shell commands, tools, file reads, browser/network access, environment inspection, credential inspection, and neighboring-file discovery.
- Output must be strict JSON.
- Output must declare `language: "ru"`.
- Translate only human-readable text fields:
  - `post.title`
  - `post.bodyMarkdown`
  - `comments[].bodyMarkdown`
- Preserve Markdown where feasible.
- Preserve all IDs, parent IDs, order, depth, authors, author profile links, scores, timestamps, and metadata exactly.
- No HTML output.
- No fallback translator.
- No GPT repair or re-ask loop.

## Failure Rules

The job fails without repair when any of these occur:

- Codex CLI is unavailable.
- GPT-5.5 is unavailable.
- Codex exits non-zero.
- Codex times out.
- Codex returns no output.
- Codex output is invalid JSON.
- Translated JSON fails schema or invariant validation.

## Subprocess Recording

For each Codex attempt, the validation report records:

- command
- model
- fixed input path
- schema path
- fixed output path
- start time
- end time
- exit code
- signal when available

`codex-events.jsonl` captures redacted stdout/stderr events when available. `worker.log` records only safe worker status lines. The worker enforces `AETRIDDER_CODEX_PROCESS_TIMEOUT_MS`, then attempts graceful termination before force kill.

## Fixed Output Path

The worker saves the translated candidate JSON at:

```text
thread.translated.json
```

inside the job workspace before publishing the latest artifact set.

