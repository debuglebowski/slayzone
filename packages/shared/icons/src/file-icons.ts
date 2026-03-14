import { getIcon } from 'material-file-icons'

export function getFileIconSvg(fileName: string): string {
  return getIcon(fileName).svg
}
