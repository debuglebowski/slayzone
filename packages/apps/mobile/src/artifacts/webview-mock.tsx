/**
 * Test-only: `react-native-webview` for the jest suites (Node has no web view). A host
 * view that keeps every prop, so a test reads what the page would load (`source`), its
 * switches, and calls its handlers (`onShouldStartLoadWithRequest`, `onMessage`).
 * Installed for every suite by `jest.setup.js`.
 */
import { createElement } from 'react'
import { View } from 'react-native'

export function WebView(props: Record<string, unknown>) {
  return createElement(View, props)
}

export default WebView
