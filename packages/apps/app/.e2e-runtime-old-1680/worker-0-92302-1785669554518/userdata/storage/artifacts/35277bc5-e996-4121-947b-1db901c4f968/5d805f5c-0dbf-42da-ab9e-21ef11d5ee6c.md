# Defender → audit-compliant: close-out playbook

**Goal:** make the ISO 27001 baselines test ("Security Center recommendations are implemented", controls A.8.9 / A.8.27) + related SOC2 controls fully defensible.
**Deadline:** SOC2 observation window closes **~2026-08-04** — all of this must be in place before then.
**Principle:** a high score is NOT required. "Fully compliant" = every unhealthy item is *either fixed or formally exempted with justification*, and the evidence lives in the right place. Score climbs as a side effect.
**Effort:** ~2–3 engineer-days + ~1 day docs.

---

## A. Close the remaining High-exposure fixes  (~2 days · IaC)
Terraform in `terraform/modules/azure/` (repo `normainofficial/normain`), tracked via Linear NOR tickets + PRs (nor-28xx convention).
- [ ] **Storage shared-key access** — audit callers use Entra/SAS, then `shared_access_key_enabled = false` (13 accounts)
- [ ] **Storage secure transfer** — `https_traffic_only_enabled = true` (2)
- [ ] **Foundry network restriction** — `public_network_access_enabled = false` / `network_acls { default_action = "Deny" }` (remaining 16)
- [ ] **Service Principals with admin roles** — remove / scope down (2)
- [ ] **Privileged permanent access** — convert to PIM-eligible (3; folds into PIM rollout)

## B. Verify pod-security is real, not stale  (~½ day)
The read-only-FS/privesc counts were last evaluated 2026-06-18 — before the #2293 hardening. Confirm before trusting them.
- [ ] Trigger fresh scan: `az policy state trigger-scan --resource-group <aks-rg>` (non-destructive)
- [ ] Re-pull assessments; confirm #2293 items drop
- [ ] If still high → deploy/reconcile gap (hardened manifests not rolled), not lag — chase the rollout
- [ ] Fix the db-init Job (#2300 carve-out): prebake `curl`/`jq` into the image so the Job can run non-root + read-only

## C. Create documented exemptions  (~½ day)
For everything we are NOT fixing. Azure exemption + matching Risk Register row must say the same thing.
- [ ] **pgaudit** (2 recs) — Defender exemption, justification = "PIM JIT access + activation logging is the compensating control"
- [ ] **Defender paid-plan upsells** — *only if risk-accepted* (see open decision) — exemption + cost rationale
- [ ] Create in Azure: *Defender for Cloud → Environment settings → Exemptions*, with justification text
- [ ] Mirror each into the **Risk Register** sheet (05-InfoSec): item · risk accepted · owner · compensating control

## D. Produce the audit evidence  (~1 day · Google Drive)
- [ ] **Baseline standard** → `05-InfoSec / 01-Official InfoSec Policies` — add a section to `[Normain] Operations Security Policy.docx` (or new doc): "Azure Defender / CIS recommendations = our cloud config baseline." Follow the folder's *"Runbook - How to update official InfoSec policies"*
- [ ] Flip the relevant control in `[Normain] Statement of Applicability (ISO27001 2022).xlsx`
- [ ] **Remediation note** → `05-InfoSec / 04-Auditing` — before/after score (15% → current), what was fixed (with PR refs #2293/2313/2318/2332/2333…), what's exempted + why, owners + dates for the remaining Med tail
- [ ] **Lane A mapping** — in the note, state the dependency-CVEs are handled by the existing vuln-mgmt process (Trivy/Dependabot + nor-28xx bump PRs); cite `[Normain] Secure Development Policy.docx`. No new policy

## E. Close it in Vanta  (~½ day · EU region app.eu.vanta.com)
- [ ] Flip the baseline row "Microsoft Azure — Security Center recommendations are implemented" from No
- [ ] Attach the remediation note + a fresh secure-score capture to test `configuration-baselines`

## F. Make it durable (recommended, prevents regression)
- [ ] Diagnostic-logging as an Azure **Policy DeployIfNotExists** → Log Analytics, so new resources auto-onboard (stops the 58→61 drift)
- [ ] Add a recurring secure-score review under `05-InfoSec / 11 - Recurring reviews & Exercises`
- [ ] Once db-init + remaining pod items land, flip the AKS Policy add-on from audit → **enforce**

---

## Definition of done
Baseline row is Healthy-or-justified · every unhealthy item is fixed **or** has a live Defender exemption + Risk Register row · baseline standard + remediation note in Drive · SoA updated · Vanta test passing with evidence attached. The Med tail (private link, diagnostic-logging, PG params, namespaces, CPU/mem limits) may remain open **if** documented in the remediation note with an owner + date.

## Open decision (blocks C)
**Defender paid-plan upsells — enable (recurring cost) or risk-accept + exempt?** Determines whether ~9 items are fixed or exempted. Needed before exemptions are finalized.
