# Validate and release

Use Node 22, pnpm 10.15.0, Git and Python 3.12 on macOS/Linux.

```sh
pnpm install --frozen-lockfile
pnpm validate
node scripts/install-cli.mjs
pnpm acceptance
git diff --exit-code -- plugin src/execution-source.mjs
```

The acceptance installer uses published npm CLI 0.15.1 and core 0.12.4, pinned in
`scripts/cli-baseline.json`. It verifies both installed versions before acceptance.
Update this baseline deliberately when qualifying another release. Runtime assets
remain at provider 0.4.1; changing acceptance tooling does not move its release tag.

The standalone gate installs the provider and a test-only source from separate
local Git origins, creates real managed Python environments, writes and reads
three JSON rows per flow using a separately installed synthetic model contract, rejects unapproved and stale runs, and checks retry/status.
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
`plugin/` assets, pass both gates, then tag the reviewed commit with its new version.
Tags must match the manifest and must never be moved after publication. Users
install through Git; this repository's private npm build package is not an npm
publication target. No extra runtime dependency on core is needed: the CLI hosts
the provider through core's versioned ABI. `minimumCli: 4.2.0` is that legacy ABI
level, not the npm CLI version.
