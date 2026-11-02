import { Redirect } from 'expo-router'
import { HOME } from '../../../../routes'

/** `/projects`: the projects list before the board's project switcher; links to it open the board. */
export default function OldProjectsRoute() {
  return <Redirect href={HOME} />
}
