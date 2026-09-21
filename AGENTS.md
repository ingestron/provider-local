# Ingestron local provider

Own deterministic local execution preparation and its Python execution adapter.
Source implementations, protocols, dependency locks and snapshot semantics belong
to separately installed source packages. Do not bundle production connectors.

Use Node 22, pnpm 10.15.0 and Python 3.12 on POSIX. Work on scoped branches.
Run pnpm validate and installed-package acceptance for behavioural changes.
Build commits plugin assets deterministically; keep CI and instructions standalone.
Use explicit owner/repository@version plugin references and immutable release tags.

Original code is Apache-2.0, licensed by Otrera Limited. Preserve third-party
notices and customer output. Tests use synthetic data only. Public source release
does not authorise cloud execution, customer data access or publishing connectors.
