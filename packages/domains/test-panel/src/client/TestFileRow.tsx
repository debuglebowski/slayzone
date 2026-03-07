import { Card } from '@slayzone/ui'

interface TestFileRowProps {
  path: string
}

export function TestFileRow({ path }: TestFileRowProps): React.JSX.Element {
  return (
    <Card className="cursor-default px-3 py-2.5">
      <p className="text-sm truncate">{path}</p>
    </Card>
  )
}
