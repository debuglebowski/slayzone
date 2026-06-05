import { Search } from 'lucide-react'
import { Input } from '@slayzone/ui'

export function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search servers..."
        className="h-8 pl-8 text-xs"
      />
    </div>
  )
}
