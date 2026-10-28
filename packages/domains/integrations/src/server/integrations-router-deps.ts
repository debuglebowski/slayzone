import type { IntegrationOps } from './handlers-store'

// Integration ops — the domain ops built by the composition root
// (`createIntegrationOps(db)`, which pulls the provider clients), injected via
// `setIntegrationOps()` so the `integrations.*` router and the still-live IPC handlers
// share one instance (coexistence until slice 5). A router call before that throws.
let integrationOps: IntegrationOps | null = null

export function setIntegrationOps(ops: IntegrationOps): void {
  integrationOps = ops
}

export function getIntegrationOps(): IntegrationOps {
  if (!integrationOps)
    throw new Error('integrationOps not initialized — call setIntegrationOps() in main host first')
  return integrationOps
}
