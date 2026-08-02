# Change: Q1 2026 Infrastructure Rebuild

*(Retroactive CR. Template: INT-251.)*


### **1. Request**


**Description**

Coordinated platform rebuild delivered between
2026-02-23 and 2026-04-07. Moves the Normain
service onto AKS, introduces per-tenant
logical + physical isolation, an automated
Marketplace-driven tenant provisioning path,
Azure Key Vault with CSI + Workload Identity
for secrets, OIDC / Entra ID for service auth
(removing SP credentials and admin cert access
to the cluster), pgaudit + WORM audit logging,
NSG segmentation for the database subnet, and
retires the legacy `iac/` tree.


**Justification**

- Enterprise onboarding requires tenant
  isolation (GDPR, contractual).
- ISO 27001 controls (A.5.15 access, A.8.2
  privileged access, A.8.15 logging, A.8.20
  network security, A.8.24 secrets).
- Remove long-lived credentials and dual
  sources of truth in IaC.
- Foundation for Marketplace distribution.


**Impact**

High. Every production runtime path changes:
auth, secret resolution, network boundary,
data placement, CI/CD identity. Downstream
dependencies across all services.


**Rollback plan**

Forward-fix program. Per-theme rollback notes
in §5. WORM retention is one-way by design;
state migrations (per-tenant DB, workloads
split) are not practically reversible once
cut over. Mitigation used: incremental
delivery, one tenant at a time, parallel
validation in dev before prod.


### **2. Assessment**

- [ ] Standard
- [X] Normal
- [ ] Emergency


### **3. Approval**

- [ ] Approved
- [ ] Denied

*Retroactive CAB signoff pending. Minutes to be
stored in the Normain data room and linked
here.*


### **4. Planning**

- [X] AKS prod baseline
- [X] Per-tenant `customer-tenant` module
- [X] `tenant-api` service + provisioning workflow
- [X] Key Vault + CSI + Workload Identity
- [X] OIDC for CI/CD, Entra ID for worker,
      remove AKS admin cert
- [X] pgaudit + Log Analytics + WORM storage
      + NSG on DB subnet + PIM
- [X] Delete legacy `iac/` tree


### **5. Implementation**


**Theme-by-theme evidence**

| # | Theme | PR(s) | Rollback posture |
|---|-------|-------|------------------|
| 1 | AKS in prod | #1608 | Forward-fix; prior hosting retired |
| 2 | Tenant separation | #1650, #1762, #1791 | Forward-fix; per-tenant state not back-mergeable |
| 3 | Tenant API + provisioning | #1656, #1659, #1786 | Disable workflow + service |
| 4 | Key Vault + CSI | #1774 | Revert CSI mounts to env vars |
| 5 | OIDC + Entra ID + RBAC | #1786, #1793, #1812 | Re-issue SP creds; flip Terraform var |
| 6 | Audit + WORM + NSG + PIM | #1731, #1796, #1798 | NSG removable; WORM retention is one-way |
| 7 | Legacy IaC removal | #1863 | Git revert |


**Build system**

Deploys via existing CI/CD pipelines (OIDC
after #1786). Dev validated before prod for
each theme.


### **6. Review**

All themes delivered and stable as of
2026-04-21. No production rollback performed.
Data-collection rule restricts audit log
ingestion to `@normain.com` principals. No
legitimate DB traffic blocked by the new NSG
in the post-cutover window.

**Known gaps addressed by this CR:**

- No prior CR filed (`NOR-noticket` commits).
- No per-change risk issue filed — risk
  captured inline here.
- No CAB approval recorded — to be signed
  retroactively.
- Segregation of duties weak for some merges
  — noted for prospective fix (see asset
  `change-mgmt-fix-plan.md`).


## Notes

- Link to `change-mgmt-fix-plan.md` asset
  (prospective remediation).
- Attach CAB meeting minutes once held.
- Suggested labels: `Change`, `Severity: High`.
- Team: `Internal Workflows`.
