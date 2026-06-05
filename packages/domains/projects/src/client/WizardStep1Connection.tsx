import { Loader2 } from 'lucide-react'
import { Button, Input, Label } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { WizardState } from './useProjectIntegrationSetupWizard'
import {
  providerConnectionLabel,
  providerCredentialLabel,
  providerCredentialPlaceholder,
  providerLabel
} from './ProjectIntegrationSetupWizard.helpers'

type WizardStep1ConnectionProps = Pick<
  WizardState,
  | 'provider'
  | 'connectionLocked'
  | 'connectionId'
  | 'setConnectionId'
  | 'loadingConnections'
  | 'connections'
  | 'showConnectForm'
  | 'setShowConnectForm'
  | 'connectionCredential'
  | 'setConnectionCredential'
  | 'connectingAccount'
  | 'handleConnectAccount'
>

export function WizardStep1Connection({
  provider,
  connectionLocked,
  connectionId,
  setConnectionId,
  loadingConnections,
  connections,
  showConnectForm,
  setShowConnectForm,
  connectionCredential,
  setConnectionCredential,
  connectingAccount,
  handleConnectAccount
}: WizardStep1ConnectionProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Label htmlFor="wizard-connection">Connection</Label>
      <Select value={connectionId} onValueChange={setConnectionId} disabled={connectionLocked}>
        <SelectTrigger id="wizard-connection" className="w-full max-w-md">
          <SelectValue
            placeholder={
              loadingConnections
                ? 'Loading connections...'
                : `Select a ${providerConnectionLabel(provider)} connection`
            }
          />
        </SelectTrigger>
        <SelectContent>
          {connections.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              {providerConnectionLabel(provider)} connection
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {loadingConnections ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading available connections...
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-3">
        <p className="text-xs text-muted-foreground">
          {connectionLocked
            ? `This project uses the ${providerConnectionLabel(provider)} connection chosen in Project Settings.`
            : connections.length === 0
              ? `No ${providerLabel(provider)} connection yet. Connect one to continue.`
              : `Use an existing ${providerConnectionLabel(provider)} connection or connect a new one.`}
        </p>
        {!connectionLocked ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowConnectForm((current) => !current)}
          >
            {showConnectForm ? 'Hide' : 'Connect account'}
          </Button>
        ) : null}
      </div>

      {!connectionLocked && (showConnectForm || connections.length === 0) && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="wizard-connection-credential" className="text-xs text-muted-foreground">
              {providerCredentialLabel(provider)}
            </Label>
            <Input
              id="wizard-connection-credential"
              type="password"
              value={connectionCredential}
              onChange={(event) => setConnectionCredential(event.target.value)}
              placeholder={providerCredentialPlaceholder(provider)}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!connectionCredential.trim() || connectingAccount}
              onClick={() => void handleConnectAccount()}
            >
              {connectingAccount ? 'Connecting…' : `Connect ${providerConnectionLabel(provider)}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
