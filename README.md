# Ingestron local provider

Build and run reviewed ingestion flows on your own machine using Ingestron and
Python. The provider prepares execution files, manages locked Python environments,
and launches independently installed source packages. It does not bundle connectors.

**Compatibility:** Ingestron CLI 0.12.0, `@ingestron/core` 0.12.0, Node 22,
Python 3.12, and macOS/Linux. Local foreground execution is a preview; source
connectivity and snapshot behaviour depend on the selected source package.

```sh
ingestron plugin install ingestron/provider-local@0.4.0
```

Configure a compatible source package, connection and ODCS table in your project,
then build and execute:

```sh
ingestron build
ingestron runtime prepare --provider local
ingestron run --provider local --action discover
ingestron run --provider local --action review
# Inspect each generated flow's review.json before approving.
ingestron run --provider local --action approve
ingestron run --provider local --run-id snapshot-001
ingestron run status snapshot-001
```

`local` here is your project configuration name. Installation uses the explicit
GitHub repository reference. The [execution guide](docs/local-execution.md)
explains source requirements, output ownership and recovery.

## Try the synthetic example

This repository includes a test-only source that writes three JSON records. It
exercises the installed CLI, registry core, Git plugin installation, Python
environment preparation, approval, execution and retry without private packages.
It is not a production connector or a Parquet implementation.

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/install-cli.mjs
pnpm acceptance
```

The installer builds the exact public CLI GitHub commit documented in
[release instructions](docs/release.md), then installs its package and registry
core in `.cli-host`. It does not use sibling checkouts. The example and results
are retained in `build/execution-acceptance`; the script replaces this disposable
folder on each run. Source files start at [project.yaml](examples/synthetic/project.yaml).

## Development

Run `pnpm validate` for source, Python, documentation and secret-pattern checks.
Run `pnpm acceptance` separately for the installed command boundary. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Licensed under Apache-2.0 by Otrera Limited. Source packages and dependencies
retain their own licences.
