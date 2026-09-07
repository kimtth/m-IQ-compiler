# Open audit controls — Northwind Platform

Status as of 2026-02-06. All entries fabricated for testing.

| Control | Scope | Framework | Version on file | Regions | State |
|---|---|---|---|---|---|
| CTL-NP-001 | Access control and least privilege | SOC 2 | TSC 2017, rev. 2022 | EU, UK, KR | Met |
| CTL-NP-002 | Change management and code review | SOC 2 | TSC 2017, rev. 2022 | EU, UK, JP | Met |
| CTL-NP-003 | Vulnerability management | ISO 27001 | 2022 | EU, UK, JP, KR | Under review |
| CTL-NP-004 | Supplier and subprocessor review | ISO 27001 | 2022 | EU, UK, JP, KR | Under review |
| CTL-NP-005 | Encryption of data at rest | SOC 2 | TSC 2017, rev. 2022 | EU, UK, KR | Met |
| CTL-NP-006 | Cardholder data segmentation | PCI DSS | 4.0 | US, CA | Testing |
| CTL-NP-007 | Client-side script integrity | PCI DSS | 4.0 | US, CA | Testing |

## Open questions

- **PCI DSS 4.0.1** was published in January and is not yet reflected in
  CTL-NP-006. Whether it applies to an assessment already under way against 4.0
  depends on the transition dates, which we have not read against our audit
  window.
- **CTL-NP-007** is being tested against the same `render-grid` version that is
  driving the `RENDER-230` pipeline failures. If the package changes, the
  evidence is invalidated and CTL-NP-007 restarts.

## Blocking assessment

Nothing currently blocks the EU renewal. The US assessment is exposed through
CTL-NP-007.
