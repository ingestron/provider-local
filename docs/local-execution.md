# Run a reviewed local flow

Use CLI 0.12.1/core 0.12.0, provider 0.4.1, Node 22 and Python 3.12 on macOS/Linux.
Install a source package implementing `ingestron.snapshot/python/v1` separately.
The provider supplies compute and orchestration; the source supplies discovery,
review, approval, extraction and snapshot recovery. There is no bundled public
connector catalogue. The repository's synthetic example exercises the boundary
using JSON output, not a production source.

## Configure and build

Install `ingestron/provider-local@0.4.1`. Install your source using its explicit
`owner/repository/path/connector.yaml@version` reference. Lock both packages and
commit the project lockfile. Configure `providers.packages`, a `local` provider
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
