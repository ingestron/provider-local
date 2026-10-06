# Durable setup-operation acknowledgement

The private local provider 0.4.14 candidate runs preparation, catalogue, discovery,
review, approval and declared checkpoint maintenance through an independently grouped finaliser. The original
adapter can disappear while that worker finishes its original operation. The
worker commits a bounded acknowledgement after executable work and owned-child
cleanup finish. Graceful termination interrupts the worker and permits that
cleanup; a missing acknowledgement retains uncertainty.

Private receipts live in the project's runtime cache, outside generated assets.
They bind the original ID, action, flow selection and managed build fingerprint.
The worker also verifies its private submission nonce. Receipt folders reject
symlink boundaries and unsafe identities. Each build fingerprint is limited to
10000 operation submissions; reviewed archive management remains unfinished.

A provider acknowledgement request reads the original committed result. It does
not invoke a source, install dependencies or rewrite discovery/review evidence.
Repeated submission of an already completed setup identity returns its original
result. Pending work, foreign bindings and malformed receipts are refused without
replaying the operation. Failed acknowledgements contain no upstream error text. Defined checkpoint failures retain only their allowlisted error code.

The provider declares the `provider-execution-acknowledgement` host feature and
`provider-journal/v1` capability. Hosts lacking that feature refuse it before
execution. Existing data-run retry continues to use source-owned commit evidence.

Verification includes actual owned adapter termination for each setup and checkpoint action,
pending recovery and original acknowledgement through immutable installed
core/CLI/provider packages. Process-regression fixtures also verify the original
worker survives and executes once. These are local synthetic checks, not native
cloud, browser interaction or all-source crash qualification. Reviewed
abandonment, legacy migration and Studio setup controls remain unfinished.
