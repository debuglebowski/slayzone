import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton, Input, Label } from '@slayzone/ui'

export function McpServerFormFields({
  serverKey,
  setServerKey,
  description,
  setDescription,
  command,
  setCommand,
  args,
  setArgs,
  envVars,
  setEnvVars
}: {
  serverKey: string
  setServerKey: (v: string) => void
  description: string
  setDescription: (v: string) => void
  command: string
  setCommand: (v: string) => void
  args: string
  setArgs: (v: string) => void
  envVars: Array<{ key: string; value: string }>
  setEnvVars: (v: Array<{ key: string; value: string }>) => void
}) {
  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs">Server key</Label>
        <Input
          value={serverKey}
          onChange={(e) => setServerKey(e.target.value)}
          placeholder="my-server"
          className="h-8 text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Description</Label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this server do?"
          rows={2}
          className="border-input dark:bg-input/30 w-full rounded-md border bg-transparent px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none resize-y"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Command</Label>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Args</Label>
          <Input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="-y @foo/bar"
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Environment variables</Label>
        {envVars.map((env, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2">
            <Input
              placeholder="KEY"
              value={env.key}
              onChange={(e) => {
                const next = [...envVars]
                next[i] = { ...next[i], key: e.target.value }
                setEnvVars(next)
              }}
              className="h-8 text-xs font-mono"
            />
            <Input
              placeholder="value"
              value={env.value}
              onChange={(e) => {
                const next = [...envVars]
                next[i] = { ...next[i], value: e.target.value }
                setEnvVars(next)
              }}
              className="h-8 text-xs"
            />
            <IconButton
              aria-label="Remove variable"
              variant="ghost"
              size="icon-sm"
              onClick={() => setEnvVars(envVars.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}
        >
          <Plus className="size-3 mr-1" />
          Add variable
        </Button>
      </div>
    </>
  )
}
