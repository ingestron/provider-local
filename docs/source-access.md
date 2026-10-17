# Source-access host — local candidate

Local provider 0.4.7 adds `ingestron.source-access-host/v1` using the
`local-python/v1` transport. The candidate is unpublished. It runs the exact
locked connector source entry with bounded execution time and the existing
process cancellation boundary. It verifies runtime file hashes and installed
Python dependency records. Preparation does not contact the source.

The host owns environment preparation and execution; the connector owns source
protocols. Source access needs no delivery flow or provider configuration.
Credentials are passed privately by core for the requested task and are never
written into result JSON. The installed local acceptance covers Files testing,
header metadata and offline contract drafting. Studio also exercises the existing
Northwind reader. This is POSIX host evidence, not Windows qualification or
permission to publish to Azure.

## Source sample execution

The source-access host runs the locked connector's explicit `sample` action in its
hash-verified environment. It verifies the action identity, 1–50-row request bound,
100-field shape and 1 MB response bound before returning data. The host neither
implements connector protocols nor writes preview rows. Core owns private access
receipts and removes business rows from those records. Unsupported or oversized
responses fail rather than being treated as successful metadata.
