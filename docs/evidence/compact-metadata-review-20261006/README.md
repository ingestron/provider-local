# Compact metadata and review — 2026-10-06

An installed local Studio project now completes preparation, review, approval and
execution for twenty tables with 200 columns and multilingual field descriptions.
Configurations use compact JSON. Reviews retain one complete copy of authored
contracts, with an explicit project-contract marker. Older reviewed bundles remain
readable within the existing bounds. The compiler and source runtime keep their
existing size limits and data, receipt and checkpoint codecs.

[Acceptance](acceptance.json) records the private CLI 0.17.21/core 0.12.53/local
provider 0.4.16 candidate and frozen source packages. These are local candidates;
public pins and the connector catalogue remain unchanged. The first Core 0.12.52
candidate is retained separately to show the failure and subsequent repair.

Twenty physical Parquet outputs contain 60 measured rows, complete 200-column
schemas and exact recorded hashes. Static actual mapping views cover 4,000 fields
across 160 pages. Previews display 50 columns and correctly report 200 in total.
The complete 1,609,401-byte review matches across seven SDK, CLI and read-only MCP
pages and the actual frozen Studio reader. Approval binds the whole report.
Five refusal and restoration checks preserve all 21 committed output files.

An additional project produces a 2,717,398-byte encoded review. The runtime refuses
it before publishing a review or managed output. Its durable failure record keeps
only the allowed `SOURCE_METADATA_LIMIT` code; Studio receives safe, specific
size guidance. The first candidate dropped that code during acknowledgement and
showed a generic provider failure. Both the failed test and installed repair remain
inspectable. Upstream messages and source values are withheld.

Core passes 270 tests and installed export checks. The local provider passes
17 Node and 18 Python tests; connectors pass five Node and 293 runtime tests.
Fresh synthetic qualification covers sixteen sources: 48 preparation checks,
144 shared-host checks and 22 business-quality checks. Seventeen frozen packages
match 773 consumed owner files; compiler and CLI archives match 156 and 29 files.
Five shared Studio/editor assets remain exact, including the packaged editor copy.
The static mapping fixture matches its 52 consumed source files.

## Limits and remaining qualification

The hundred-table/200-column project still exceeds the existing two-million-byte
connection preparation transport limit. Its 4,452,977-byte input receives measured,
actionable guidance, but successful execution at that scale remains open. The
oversized review above proves safe refusal, not larger-project readiness.

Files use real synthetic local data. API and object-storage tests use loopback
HTTP; databases and SFTP use transport stand-ins. Vendor accounts, native drivers,
TLS/SSH services and independent engineers are not qualified here. Static rendering
does not establish mounted, keyboard or narrow-layout usability. Complete older
source-version checkpoint migration was not rerun. The original preview retains
its original compiler and eight registrations; no release or cloud action occurred.
All sixteen product workflows remain implementing and enterprise readiness is open.

## Inspectable evidence

[Source hashes](source-hashes.json) and the [scoped source diff](scoped-source-change.patch)
separate this repair from inherited changes. Generated runtime bodies are represented
by their hashes and bundle audit rather than repeated in the diff.
[Raw provenance](raw-source-provenance.json) records the original executed output hashes;
formatted JSON copies retain the same content.
[canonical hashes](canonical-hashes.json) bind the final formatted evidence.
Executed harnesses are retained under `harness/`.

[The preceding compiler identity repair](../../../../connectors/docs/evidence/compiler-project-identity-20261006/README.md)
records the multilingual codec correction and original twenty-table failures.
Its oversized generated-code diff was preserved in private working evidence and
replaced by a source diff plus hashes to respect the existing text-package bounds.
