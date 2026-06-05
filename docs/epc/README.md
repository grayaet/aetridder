# EPC Artifact

This folder contains a standalone EPC model for the Reddit Reader latest-job process.

## Files

- `reddit-reader-job-process.epml`: EPML/XML process model for import into EPC-capable tooling.

## Format

EPML is an XML interchange format for Event-driven Process Chains. This artifact uses the core EPC control-flow vocabulary:

- `event`
- `function`
- `xor`
- `and`
- `or`
- `arc` with nested `flow source="..." target="..."`

The diagram is intentionally focused on the event/function/control-flow layer. Application, role, and data-object overlays are described elsewhere in the docs because EPML importer support for extended EPC objects varies by tool.

## Process Scope

The model covers:

- iOS Shortcut URL precheck
- `POST /api/threads`
- latest-job creation
- reader loading branch
- worker extraction branch
- extractor unavailable failure
- raw thread validation
- Codex translation
- translated thread validation
- `ready`
- `ready_with_warning`
- safe failure terminal states

This artifact is educational documentation. It is not product behavior, not runtime proof, not deployment approval, and not owner Acceptance.

## Related Docs

- `../ARCHITECTURE_VISUALS.md`
- `../hybrid-extraction-mode.md`
- `../extractor-protocol-v1.md`
