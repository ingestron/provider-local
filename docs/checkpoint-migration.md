# Transport a reviewed checkpoint upgrade

The private local provider 0.4.14 candidate transports `checkpoint_preview` and
`checkpoint_apply` to a source package that explicitly declares the compatible
runtime-upgrade protocol in its locked runtime assets. PostgreSQL 1.1.7 is the
installed-qualified source candidate. An older or unsupported source receives
upgrade guidance before its runtime is invoked.

The provider checks one flow, the retained build's project/environment/configuration
and paths within the selected project. It uses the prepared locked environment,
passes the current and previous source configurations, and supplies the current
output namespace. It installs no dependencies, discovers no source and owns no
checkpoint compatibility or cursor logic. Maintenance suppresses incidental
Python bytecode writes in the retained bundle.

Both actions use the durable finaliser and original-operation acknowledgement
protocol. A completed acknowledgement contains bounded source migration metadata
or a defined checkpoint failure code. It retains no source message or row values.
Original recovery reads the acknowledgement without replaying maintenance. Core
keeps both managed builds protected while the original outcome is uncertain.

Installed SDK, CLI and MCP acceptance verifies review/apply and cursor continuation
on a copied synthetic PostgreSQL project, plus repeated apply and original
acknowledgement. Process fixtures cover adapter death for all seven setup and
maintenance actions. Core/CLI retention preserves the original managed build
and core verifies its sealed inventory before maintenance. Real migration-finaliser death,
Studio/editor controls, distributed target reservations and cloud/vendor
qualification remain unfinished.
