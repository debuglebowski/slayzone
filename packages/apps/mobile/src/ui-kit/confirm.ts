import { Alert } from 'react-native'

/**
 * Ask before something that cannot be taken back (signing out, leaving the demo): the
 * system alert with Cancel and the action in red, named for what it does ("Sign out of
 * hub.example.com"). `onConfirm` runs only on that button.
 */
export function confirmDestructive({
  title,
  message,
  action,
  onConfirm
}: {
  title: string
  message: string
  action: string
  onConfirm: () => void
}): void {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: 'destructive', onPress: onConfirm }
  ])
}

/** Sign out of the hub called `name`, once the user says so. */
export function confirmSignOut(name: string, onConfirm: () => void): void {
  confirmDestructive({
    title: `Sign out of ${name}?`,
    message:
      'Its projects, tasks and agents leave this app until you sign in again. Nothing on the hub is deleted.',
    action: `Sign out of ${name}`,
    onConfirm
  })
}

/** Leave the demo, once the user says so: what was changed in it is gone. */
export function confirmExitDemo(onConfirm: () => void): void {
  confirmDestructive({
    title: 'Exit the demo?',
    message: 'Changes you made to the sample projects are discarded.',
    action: 'Exit demo',
    onConfirm
  })
}
