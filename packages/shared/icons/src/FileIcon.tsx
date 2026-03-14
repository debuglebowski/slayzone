import { getFileIconSvg } from './file-icons'

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\bon\w+\s*=\s*'[^']*'/gi, '')
}

interface FileIconProps {
  fileName: string
  className?: string
}

export function FileIcon({ fileName, className }: FileIconProps) {
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitizeSvg(getFileIconSvg(fileName)) }}
    />
  )
}
