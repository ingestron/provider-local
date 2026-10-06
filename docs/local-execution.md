# Run a reviewed local flow

The private local0.4.10 candidate adds reviewed portable schedule handovers. See
[portable scheduled ingestion](portable-schedules.md) for the verified boundary
and remaining continuous-worker/source qualifications. The published baseline
below retains its own behaviour and versions.

## Private quality candidate — 2026-10-03

The local 0.4.7 candidate, with core 0.12.15 and CLI 0.17.9 candidates,
retains bounded quality-failure evidence in failed run receipts. Compatible
source packages report rule IDs, stream IDs, supported metrics and non-negative
counts. The provider strips other fields and withholds upstream error text.
A failed quality check commits no new snapshot; earlier committed output is
preserved. The Studio installed-package acceptance verified three passing
synthetic rows, followed by one rejected duplicate. This is private candidate
evidence; the published baseline and instructions below remain separate.

The repository acceptance script on its installed CLI 0.17.8/core 0.12.14
baseline cannot install this private provider manifest: its new `sourceAccess`
field requires the candidate core schema. That run does not establish published
baseline execution acceptance. The
candidate boundary passes through an installed immutable provider snapshot.

## Published baseline

Use CLI 0.15.1/core 0.12.4, provider 0.4.1, Node 22 and Python 3.12 on macOS/Linux.
Install a source package implementing `ingestron.snapshot/python/v1` separately.
The provider supplies compute and orchestration; the source supplies discovery,
review, approval, extraction and snapshot recovery. The CLI can resolve qualified public connector names; the provider does not
bundle their runtimes. The repository's synthetic example exercises the boundary
using JSON output, not a production source.

## Configure and build

Install `ingestron/provider-local@0.4.1`. Install your source using its explicit
`owner/repository/path/connector.yaml@version` reference. Lock both packages and
commit the project lockfile. Configure top-level `packages`, a `local` provider
configuration, a `kind: local` environment binding, and a connection referencing
the source package. Ingestion flows use `execution: { mode: local }` and ODCS tables.
The [synthetic project](../examples/synthetic/project.yaml) shows this structure;
its `example/source` reference is a fixture created by the acceptance script,
not a hosted package you can install independently.

```sh
ingestron build --out build/local
ingestron runtime prepare --from build/local --provider local
ingestron run --from build/local --provider local --action discover
ingestron run --from build/local --provider local --action review
```

Build writes owned execution files and never queries sources or installs Python
packages. Preparation explicitly installs the source's hash-locked dependencies
from PyPI and may execute upstream build code. Python 3.12 must already be installed
on PATH or discoverable through uv; `--python PATH` overrides preparation's
bootstrap interpreter. Python is not downloaded automatically. Private dependency
indexes and Windows execution are not supported.

## Review, approve and run

Inspect the source identity, contracts and selected fields in each generated
`flows/<flow>/review.json`. Approval and extraction are explicit:

```sh
ingestron run --from build/local --provider local --action approve
ingestron run --from build/local --provider local --run-id snapshot-001
ingestron run status snapshot-001
ingestron run --retry snapshot-001
```

The CLI writes receipts under `.ingestron/runs`. The provider gives each source
`build/local/data/<flow>` as its output root; formats, subdirectories and committed
snapshot semantics belong to that source. Compatible sources must reject extraction
before approval and safely reuse committed results for the same run ID. A new ID
requests new extraction. This provider alone cannot guarantee an arbitrary source's
correctness, throughput or idempotency.

Execution is foreground and sequential. Ctrl+C interrupts the process; check the
receipt before retrying. Host failure can leave an indeterminate receipt. There
is no scheduler, distributed execution, remote cancellation or cloud deployment.
Do not infer support for CDC or every ODCS type: supported projection types are
integer, string, boolean, floating point and decimal (precision up to 38).

## Recover safely

- **Runtime not prepared:** prepare with the same build and selection.
- **Review exists or source metadata changed:** preserve evidence, then build into
  a new output directory and repeat discovery/review/approval.
- **Build or lock changed:** create a fresh build and run ID. Existing receipts
  cannot be retried against a different build.
- **Source failure:** check the locked environment, source access and review.
  Upstream diagnostics are withheld because they can contain data or credentials.
- **Unsupported column:** change the reviewed mapping or choose a compatible
  source/provider; unsupported types fail rather than silently coercing data.

CLI 0.12.1 replaces `--env-file`, which Node can intercept before CLI startup.
Use explicit `--secrets-file .env` for source-declared secret variables and keep it
untracked. Retain wanted output and receipts before deleting a disposable project.
Do not edit generated files or add packages to `.ingestron/runtimes` manually.

For standalone scheduling, generated `run.py` uses its active interpreter. Launch
it in the prepared environment and select `--flow NAME` or `--all`. CLI receipts
are only produced by CLI execution.

### Indexed project tables

The local adapter accepts an explicit hash-bound project-table index with separate compilation projections. Core supplies those columns from validated contracts; the provider derives its existing typed selection without embedding the projection into the project lock. Complete contracts remain in generated metadata documents verified by the source runtime before review or execution. Source and provider must both opt in; ordinary inline requests keep their existing form. The adapter rejects ambiguous tables/selection, mismatched document/projection names, paths and byte/count bounds. This declaration requires the `connection-metadata-documents` host feature. It does not grant source or execution permissions.

Indexed assembly receives the original collection index and the connection assets without document bodies. It returns the exact flow directory for Core to attach its original documents. Core checks that assembly preserved the runner and references. Ordinary inline assembly remains supported. This encoding capability is distinct from installed review, approval and runtime qualification.
