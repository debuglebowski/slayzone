/**
 * Test-only: `react-native-webview` for the jest suites (Node has no web view). A host
 * view that keeps every prop, so a test reads what the page would load (`source`), its
 * switches, and calls its handlers (`onShouldStartLoadWithRequest`, `onMessage`); what
 * the app injects through its ref is in `injectedJavaScript`.
 * Installed for every suite by `jest.setup.js`.
 */
import { createElement, type Ref, useImperativeHandle } from 'react'
import { View } from 'react-native'

/** Every script given to a web view's `injectJavaScript` (its ref), in order. */
export const injectedJavaScript: string[] = []

export function WebView({
  ref,
  ...props
}: Record<string, unknown> & { ref?: Ref<{ injectJavaScript: (script: string) => void }> }) {
  useImperativeHandle(ref, () => ({
    injectJavaScript: (script: string) => {
      injectedJavaScript.push(script)
    }
  }))
  return createElement(View, props)
}

export default WebView
