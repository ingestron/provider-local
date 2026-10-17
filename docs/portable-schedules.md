# Portable scheduled ingestion

The private local0.4.10 adapter accepts reviewed portable schedule handovers from
core0.12.25 with CLI0.17.11. Core owns schedule schemas, time-zone resolution,
occurrence calculation and the durable journal. This provider retains the complete
envelope in both connector configuration and project lock; it does not calculate
another clock or launch work during preparation. Its standalone command checks
scope and local policies. The host validates the complete definition and current
clock before preparation and before dispatch; the source runtime checks the
containing specification hash and approved review before reading data.

Use Node22.13 or newer, Python3.12 and POSIX. Install a separately locked source
package. The four recurrence kinds are interval, daily, weekly and monthly. Local
portable overlap is skip or queue; missed occurrences use skip or latest. Native
policies require a native execution adapter. Build, prepare the exact Python
runtime, discover, inspect the ODCS review and approve it before dispatch.

## Register and run

The shared Studio interface shows Scheduled runs for a local flow with a saved
schedule. Register current build binds the reviewed build, source and package
identities, schedule and host clock resolution. Run due now starts at most one
occurrence. Pause stops future dispatch without changing the authored definition.
Cancel queued removes only work that has not started. Retry same occurrence keeps
the source business run identity and retained claim. Recovery refuses a worker
that is still alive. An expired time interval alone does not release ownership.

SDK/CLI operations are scheduler_inspect, scheduler_status, scheduler_register,
scheduler_tick, scheduler_pause, scheduler_cancel and scheduler_retry. CLI generic
operations accept structured JSON; mutations require both --allow-write and
--allow-execute. Register, pause, cancel and retry require the reviewed digest.
Private core0.12.28/CLI0.17.12 additionally expose scheduler_worker_start,
scheduler_worker_status and scheduler_worker_stop. Register each selected flow
first, review its digest, then explicitly start the driver with both permissions.
Core owns this driver; provider preparation does not start it. Studio worker
controls remain to be integrated. Do not infer background execution from an
enabled definition.

## Current verification boundary

The installed acceptance uses immutable local0.4.10 and files1.5.8 snapshots with
core0.12.25/CLI0.17.11. Four recurrences pass preparation through the provider
sandbox. Actual interval dispatch reads two synthetic CSV tables: malformed input
fails without a commit, MCP recovery reuses the occurrence identity, and both
Parquet tables retain exact decimal values. Repeated ticks and same-run replay
preserve committed bytes. This proves the tested file route; other sources and
native targets require their own execution qualification.

The [installed harness](../scripts/schedules-acceptance.mjs) accepts
INGESTRON_ACCEPTANCE_CLI_PACKAGE, PROVIDER, SOURCE, OUTPUT and PROOF, each prefixed
with INGESTRON_ACCEPTANCE_. OUTPUT must be a disposable synthetic workspace.
Installed packages and temporary Git snapshots are independent of source imports.

The permanent [crash harness](../scripts/scheduler-crash-acceptance.mjs) qualifies
actual caller death while the file source is alive, refusal through its held
provider lock, source commit without acknowledgement, and recovery of the same
commit after source input becomes malformed. Its scope is the file route.

The [worker harness](../scripts/scheduler-worker-acceptance.mjs) uses an immutable
installed core/CLI and a previously qualified synthetic file fixture. It covers
persistent lifecycle, multiple flow dispatch, receiver authentication, failure
isolation, Parquet values, pause, drain and source interruption/recovery. Set
INGESTRON_ACCEPTANCE_CLI_PACKAGE, FIXTURE, OUTPUT and PROOF. Run it with disposable
local fixtures; it does not activate native targets.

Shared targets across flows,
changed-definition migration, backfill, bounded history archive, and distributed
workers remain open. Preserve failed occurrence claims and source receipts until
same-run recovery or a reviewed migration resolves them.
