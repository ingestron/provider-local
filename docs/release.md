# Validate and release

Use Node 22, pnpm 10.15.0, Git and Python 3.12 on macOS/Linux.

```sh
pnpm install --frozen-lockfile
pnpm validate
node scripts/install-cli.mjs
pnpm acceptance
git diff --exit-code -- plugin src/execution-source.mjs
```

The acceptance installer builds public `ingestron/cli` commit
`798444c5ebd969d9846fc6912afdf72bb298d876` (CLI 0.12.0), packages it, and installs
it with `@ingestron/core@0.12.0` from npm. CLI 0.12.0 was not available from npm
at qualification time. This exact GitHub source is the tested CLI baseline.
Update the pin deliberately when qualifying another release.

The standalone gate installs the provider and a test-only source from separate
local Git origins, creates real managed Python environments, writes and reads
three JSON rows per flow, rejects unapproved and stale runs, and checks retry/status.
It checks two flows reuse the same environment. CI runs the same gate. This is
synthetic compatibility evidence, not production connector or performance evidence.

For a separately authorised connector qualification, set
`INGESTRON_TEST_SOURCE_DIRECTORY` to an external directory containing
`faker/connector.yaml`, its runtime assets and licence. The gate uses that source
instead of the synthetic fixture; external code is never copied into this repo.
Set `INGESTRON_TEST_PUBLIC_PROVIDER=1` to install the tagged release directly
from public GitHub instead of the local plugin fixture. Both overrides are for explicit
maintainer qualification and are unnecessary for normal validation.

Update package and generated manifest versions together. Commit deterministic
`plugin/` assets, pass both gates, then tag the reviewed commit as `0.4.1`.
Tags must match the manifest and must never be moved after publication. Users
install through Git; this repository's private npm build package is not an npm
publication target. No extra runtime dependency on core is needed: the CLI hosts
the provider through core's versioned ABI. `minimumCli: 4.2.0` is that legacy ABI
level, not the npm CLI version.
