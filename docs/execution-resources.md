# Inspect a local output namespace

The private local0.4.11 candidate, qualified with core0.12.31 and CLI0.17.14,
declares the exact `data/<flow>` output directory in a compiled package. Its
offline `execution resources` command returns the `local-filesystem` namespace
and directory identity for each selected flow. Core converts these identities
to opaque keys before returning SDK, terminal or MCP inspection results.

The command takes the canonical POSIX `packageRoot` and unique compiled `flows`.
It does not inspect files, install dependencies, read sources or create outputs.
Selecting a flow in the same package retains its key. Compiling another package
directory produces another actual data namespace. Output formats and committed
snapshot/checkpoint behaviour remain owned by the installed source package.

Core consumes these keys in the portable scheduler's existing project journal
and managed-build execution claims. This declaration does not establish shared
reservations across projects, build directories or machines. Existing source
output locks and stable-run retry rules continue to apply.

The installed local0.4.11/files1.5.8 acceptance verifies three independent flow
identities, scheduler parity and a real three-order source commit. Retrying the
same run after its CSV becomes malformed returns the unchanged commit. Source
extraction and native platform execution require their existing explicit authority.

The provider requires the `provider-execution-resources` host feature. Older
published hosts cannot consume this private capability; their baseline behaviour
and dependency pins are unchanged.
