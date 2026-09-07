# Sample project — Northwind Platform

A small, fabricated project for driving the app by hand. Bind it in
**Projects**, then work against it in Co-create and IQ Cell.

Everything here is invented. No real service, vendor, customer, incident or
ticket is described, and no file contains anything that would need to be treated
as confidential if it leaked. That is deliberate: a system-test fixture that
needs handling with care is a fixture nobody will use.

The tree mirrors the domains the Neural Connectome demo library is themed
around, so the two surfaces tell the same story:

| Folder | What it holds | Neural Connectome domain |
|---|---|---|
| `releases/` | Release status and freeze notes | Releases |
| `compliance/` | Audit controls and framework deltas | Compliance |
| `vendors/`, `dependencies/` | Vendor scorecards, open upgrades, the dependency inventory | Vendors & dependencies |
| `ci/` | Pipeline failures and reruns | Build quality |
| `support/`, `incidents/` | Tickets, repeat failures, status posts | Support & incidents |

The sample IQ Cell bundles in `../iq-cells/` name paths inside this tree, so
importing one and reading its contract lines up with what is actually here.

