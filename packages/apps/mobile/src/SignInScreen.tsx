import { type ComponentRef, useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { isBareAuthority } from '@slayzone/platform/hub-addr'
import { signInWithMicrosoft } from './auth/microsoft-sign-in'
import {
  type HubSession,
  type HubSignInOffer,
  normalizeHubAddress,
  probeSignInOffer,
  type SignInResult,
  signIn
} from './hub-session'
import { type ChromeColors, useTheme, useThemeVariant } from './theme'

/** The app's icon, above the first sign-in. */
const APP_ICON = require('../assets/icon.png')

/**
 * SPIKE-ONLY dev prefill: the simulator has no scriptable keyboard, so a dev bundle
 * started with these set fills the form and submits it once. Inlined at bundle time
 * by babel-preset-expo; never set in a release build.
 */
const DEV_PREFILL = __DEV__
  ? {
      hub: process.env.EXPO_PUBLIC_SPIKE_HUB ?? '',
      email: process.env.EXPO_PUBLIC_SPIKE_EMAIL ?? '',
      password: process.env.EXPO_PUBLIC_SPIKE_PASSWORD ?? ''
    }
  : { hub: '', email: '', password: '' }
const DEV_AUTO_SUBMIT = Boolean(DEV_PREFILL.hub && DEV_PREFILL.email && DEV_PREFILL.password)
/**
 * Submitted once per app launch: the sign-in screen after a sign-out (or leaving the
 * demo) must stay, or signing out could never be done in such a bundle.
 */
let devAutoSubmitted = false

/** How long the hub address must stay unchanged before the hub is asked what it offers. */
const PROBE_DELAY_MS = 400

/**
 * Sign in to a hub: the first one (`/sign-in`) or another (`/add-hub`, with Cancel).
 * Both ways keep the session in the keychain before `onSignedIn` runs.
 *
 * Once the typed address settles, the hub is asked what it offers (`/health`): "Sign in
 * with Microsoft" appears only where the hub serves it, and the email + password form
 * hides only where the hub says password sign-in is off. Until the hub answers (or when
 * it cannot be reached) the form is as it always was.
 *
 * `onTryDemo` (the first sign-in only): "Try demo" opens the app on sample data, no hub
 * or account needed (`demo/`).
 *
 * The first sign-in (no `onCancel`) shows the app's name and icon above the card. The
 * form scrolls (a small phone, landscape, the keyboard), Return moves from field to field
 * and Go signs in, the fields are read-only while signing in, and only the button of the
 * way in flight spins. An error is read out by VoiceOver; closing the Microsoft sheet
 * yourself is not one.
 */
export function SignInScreen({
  title,
  onSignedIn,
  onCancel,
  onTryDemo,
  signedInAddresses = [],
  devAutoSubmit = false
}: {
  title: string
  onSignedIn: (session: HubSession) => void
  onCancel?: () => void
  /** Offer the demo (the first sign-in): open the app on sample data. */
  onTryDemo?: () => void
  /** The hubs (`host[:port]`) the app is signed in to: signing in to one again replaces it. */
  signedInAddresses?: readonly string[]
  /** Dev bundles only: submit the `EXPO_PUBLIC_SPIKE_*` prefill (once per launch). */
  devAutoSubmit?: boolean
}) {
  const theme = useTheme()
  const keyboardAppearance = useThemeVariant()
  const styles = makeStyles(theme)
  const [hub, setHub] = useState(DEV_PREFILL.hub)
  const [email, setEmail] = useState(DEV_PREFILL.email)
  const [password, setPassword] = useState(DEV_PREFILL.password)
  /** The way of signing in in flight, if any. */
  const [busy, setBusy] = useState<'password' | 'microsoft' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** What the hub at `address` offers; kept per address, so a stale answer shows nothing. */
  const [probed, setProbed] = useState<{ address: string; offer: HubSignInOffer } | null>(null)
  const emailField = useRef<ComponentRef<typeof TextInput>>(null)
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null)

  const address = normalizeHubAddress(hub)
  useEffect(() => {
    if (!isBareAuthority(address)) return
    let current = true
    const timer = setTimeout(() => {
      void probeSignInOffer(address).then((result) => {
        if (current && result.ok) setProbed({ address, offer: result.offer })
      })
    }, PROBE_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [address])
  const offer = probed !== null && probed.address === address ? probed.offer : null
  const showMicrosoft = offer?.microsoft === true
  const showPassword = offer?.password !== false

  /** Show what went wrong, and read it out (VoiceOver does not see new text by itself). */
  const fail = (message: string): void => {
    setError(message)
    AccessibilityInfo.announceForAccessibility(message)
  }

  const run = (way: 'password' | 'microsoft', attempt: () => Promise<SignInResult>): void => {
    setBusy(way)
    setError(null)
    void attempt()
      .then((result) => {
        if (result.ok) onSignedIn(result.session)
        // Closed by the person: they know, nothing went wrong.
        else if (!result.cancelled) fail(result.error)
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
      .then(() => setBusy(null))
  }
  const submit = (): void => run('password', () => signIn(hub, email, password))
  const submitMicrosoft = (): void => run('microsoft', () => signInWithMicrosoft(hub))

  useEffect(() => {
    if (!DEV_AUTO_SUBMIT || !devAutoSubmit || devAutoSubmitted) return
    devAutoSubmitted = true
    void signIn(DEV_PREFILL.hub, DEV_PREFILL.email, DEV_PREFILL.password).then((result) => {
      if (result.ok) onSignedIn(result.session)
      else setError(result.error)
    })
  }, [onSignedIn, devAutoSubmit])

  const idle = busy === null
  const canSubmit = idle && address !== '' && email.trim() !== '' && password !== ''

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <ScrollView
        testID="sign-in-scroll"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {onCancel ? null : (
          <View style={styles.brand}>
            <Image source={APP_ICON} style={styles.icon} accessibilityIgnoresInvertColors />
            <Text style={styles.appName} accessibilityRole="header">
              SlayZone
            </Text>
          </View>
        )}
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.explainer}>
            A hub is the SlayZone server your desktop app or your team runs. Ask whoever set it up
            for its address.
          </Text>
          <Text style={styles.label}>Hub address</Text>
          <TextInput
            style={styles.input}
            value={hub}
            onChangeText={setHub}
            editable={idle}
            placeholder="hub.yourcompany.com"
            placeholderTextColor={theme.mutedForeground}
            accessibilityLabel="Hub address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            keyboardAppearance={keyboardAppearance}
            returnKeyType={showPassword ? 'next' : showMicrosoft ? 'go' : 'done'}
            submitBehavior={showPassword ? 'submit' : 'blurAndSubmit'}
            onSubmitEditing={() => {
              if (showPassword) emailField.current?.focus()
              else if (showMicrosoft && idle) submitMicrosoft()
            }}
          />
          {signedInAddresses.includes(address) ? (
            <Text style={styles.note}>
              You're already signed in to {address}. Signing in again replaces that sign-in.
            </Text>
          ) : null}
          {showMicrosoft ? (
            <Pressable
              style={[styles.button, !idle && styles.buttonDisabled]}
              onPress={submitMicrosoft}
              disabled={!idle}
              accessibilityRole="button"
              accessibilityLabel={`Sign in with ${offer?.ssoLabel ?? 'Microsoft'}`}
              accessibilityState={{ disabled: !idle, busy: busy === 'microsoft' }}
            >
              {busy === 'microsoft' ? (
                <ActivityIndicator
                  testID="sign-in-microsoft-busy"
                  color={theme.primaryForeground}
                />
              ) : (
                <Text style={styles.buttonText}>Sign in with {offer?.ssoLabel ?? 'Microsoft'}</Text>
              )}
            </Pressable>
          ) : null}
          {showMicrosoft && showPassword ? <Text style={styles.or}>or</Text> : null}
          {showPassword ? (
            <>
              <Text style={styles.label}>Email</Text>
              <TextInput
                ref={emailField}
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                editable={idle}
                placeholder="you@example.com"
                placeholderTextColor={theme.mutedForeground}
                accessibilityLabel="Email"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                keyboardAppearance={keyboardAppearance}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => passwordField.current?.focus()}
              />
              <Text style={styles.label}>Password</Text>
              <TextInput
                ref={passwordField}
                testID="sign-in-password"
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                editable={idle}
                accessibilityLabel="Password"
                secureTextEntry
                textContentType="password"
                keyboardAppearance={keyboardAppearance}
                returnKeyType="go"
                onSubmitEditing={canSubmit ? submit : undefined}
              />
            </>
          ) : null}
          {error ? (
            <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
          {showPassword ? (
            <Pressable
              style={[
                styles.button,
                showMicrosoft && styles.buttonSecondary,
                !canSubmit && busy !== 'password' && styles.buttonDisabled
              ]}
              onPress={submit}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityState={{ disabled: !canSubmit, busy: busy === 'password' }}
            >
              {busy === 'password' ? (
                <ActivityIndicator
                  testID="sign-in-password-busy"
                  color={showMicrosoft ? theme.secondaryForeground : theme.primaryForeground}
                />
              ) : (
                <Text style={[styles.buttonText, showMicrosoft && styles.buttonSecondaryText]}>
                  Sign in
                </Text>
              )}
            </Pressable>
          ) : null}
          {onCancel ? (
            <Pressable
              style={styles.cancel}
              onPress={onCancel}
              disabled={!idle}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
        {onTryDemo ? (
          <View style={styles.demo}>
            <Text style={styles.demoText}>No hub yet? Look around first.</Text>
            <Pressable
              testID="try-demo"
              style={[styles.demoButton, !idle && styles.buttonDisabled]}
              onPress={onTryDemo}
              disabled={!idle}
              accessibilityRole="button"
              accessibilityHint="Opens the app with sample projects. Nothing is sent anywhere."
            >
              <Text style={styles.demoButtonText}>Try demo</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    // Centred while it fits; scrolls when it does not (keyboard, landscape, a small phone).
    content: { flexGrow: 1, justifyContent: 'center', padding: 16 },
    brand: { alignItems: 'center', gap: 8, marginBottom: 20 },
    icon: { width: 56, height: 56, borderRadius: 13 },
    appName: { fontSize: 22, fontWeight: '700', color: t.foreground },
    card: {
      alignSelf: 'center',
      width: '100%',
      maxWidth: 420,
      padding: 20,
      borderRadius: 12,
      backgroundColor: t.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    title: { fontSize: 20, fontWeight: '600', color: t.cardForeground },
    explainer: { fontSize: 14, lineHeight: 20, color: t.mutedForeground, marginTop: 6 },
    label: { fontSize: 13, color: t.mutedForeground, marginTop: 12, marginBottom: 4 },
    input: {
      borderWidth: 1,
      borderColor: t.input,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: t.cardForeground
    },
    note: { fontSize: 13, color: t.mutedForeground, marginTop: 8 },
    error: { color: t.destructive, marginTop: 12 },
    button: {
      marginTop: 20,
      minHeight: 44,
      justifyContent: 'center',
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: 'center',
      backgroundColor: t.primary
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: t.primaryForeground, fontSize: 16, fontWeight: '600' },
    // Beside "Sign in with Microsoft", the password button steps back.
    buttonSecondary: { backgroundColor: t.secondary },
    buttonSecondaryText: { color: t.secondaryForeground },
    or: { color: t.mutedForeground, textAlign: 'center', marginTop: 16, fontSize: 13 },
    cancel: { marginTop: 12, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
    cancelText: { color: t.mutedForeground, fontSize: 15 },
    demo: { alignSelf: 'center', width: '100%', maxWidth: 420, marginTop: 20, gap: 10 },
    demoText: { color: t.mutedForeground, fontSize: 14, textAlign: 'center' },
    demoButton: {
      minHeight: 44,
      justifyContent: 'center',
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.secondary
    },
    demoButtonText: { color: t.secondaryForeground, fontSize: 16, fontWeight: '600' }
  })
