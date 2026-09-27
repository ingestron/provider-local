# SQL runtime diagnostics

Date: 2026-09-27. Local provider 0.4.3 candidate.

The adapter recognises three bounded source codes: SQL_CONNECT, SQL_READ and
SQL_TABLE. It returns fixed recovery guidance and discards arbitrary upstream
error text, preserving the existing source/runtime boundary.

The full component gate passed. Installed-provider acceptance passed runtime
preparation/reuse, review, extraction, retry and status with synthetic data against
the existing published CLI/core baseline. The source-code disclosure regression
includes all three SQL categories and an unknown code.

A second fresh installed candidate project used local provider source commit
`0ea6783`, SQL connector commit `133d5aa` and core 0.12.7. With owner-authorised
Northwind read access, discovery/review/approval/read returned 91 customer and 830
order rows. Credentials remained host-side. Registry publication and catalogue
qualification are separate release steps; native ADF execution was not attempted.
