# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/ingestron/provider-local/security/advisories/new).
Do not put credentials or customer records in public issues.

Provider JavaScript prepares files offline. Explicit runtime preparation installs
locked source dependencies; discovery and execution run trusted Python source code
in the user's environment. Neither Python execution nor dependency installation is
a sandbox. Install only reviewed sources and dependency locks, using least-privilege
source access. Source code owns its approval and snapshot guarantees.

Secret values stay out of generated configuration; the CLI passes only declared
secret environment variables. Upstream diagnostic output is withheld. Local
receipts and source-generated files may still contain sensitive metadata or data:
keep the project and runtime directories within an appropriate filesystem boundary.
