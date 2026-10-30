import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
  probeSignInOffer,
  type SignInResult,
  signIn
} from './hub-session'
import { type ChromeColors, useTheme } from './theme'

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
 */
export function SignInScreen({
  title,
  onSignedIn,
  onCancel,
  devAutoSubmit = false
}: {
  title: string
  onSignedIn: (session: HubSession) => void
  onCancel?: () => void
  /** Dev bundles only: submit the `EXPO_PUBLIC_SPIKE_*` prefill once (first sign-in). */
  devAutoSubmit?: boolean
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [hub, setHub] = useState(DEV_PREFILL.hub)
  const [email, setEmail] = useState(DEV_PREFILL.email)
  const [password, setPassword] = useState(DEV_PREFILL.password)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What the hub at `address` offers; kept per address, so a stale answer shows nothing. */
  const [probed, setProbed] = useState<{ address: string; offer: HubSignInOffer } | null>(null)

  const address = hub.trim()
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

  const run = (attempt: () => Promise<SignInResult>): void => {
    setBusy(true)
    setError(null)
    void attempt()
      .then((result) => {
        if (result.ok) onSignedIn(result.session)
        else setError(result.error)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .then(() => setBusy(false))
  }
  const submit = (): void => run(() => signIn(hub, email, password))
  const submitMicrosoft = (): void => run(() => signInWithMicrosoft(hub))

  useEffect(() => {
    if (!DEV_AUTO_SUBMIT || !devAutoSubmit) return
    void signIn(DEV_PREFILL.hub, DEV_PREFILL.email, DEV_PREFILL.password).then((result) => {
      if (result.ok) onSignedIn(result.session)
      else setError(result.error)
    })
  }, [onSignedIn, devAutoSubmit])

  const canSubmit = !busy && hub.trim() !== '' && email.trim() !== '' && password !== ''

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.label}>Hub address</Text>
        <TextInput
          style={styles.input}
          value={hub}
          onChangeText={setHub}
          placeholder="hub.example.com or 127.0.0.1:8788"
          placeholderTextColor={theme.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {showMicrosoft ? (
          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={submitMicrosoft}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Sign in with Microsoft</Text>
          </Pressable>
        ) : null}
        {showMicrosoft && showPassword ? <Text style={styles.or}>or</Text> : null}
        {showPassword ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={theme.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              onSubmitEditing={canSubmit ? submit : undefined}
            />
          </>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {busy && !showPassword ? (
          <ActivityIndicator style={styles.busy} color={theme.mutedForeground} />
        ) : null}
        {showPassword ? (
          <Pressable
            style={[
              styles.button,
              showMicrosoft && styles.buttonSecondary,
              !canSubmit && styles.buttonDisabled
            ]}
            onPress={submit}
            disabled={!canSubmit}
          >
            {busy ? (
              <ActivityIndicator
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
          <Pressable style={styles.cancel} onPress={onCancel} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, justifyContent: 'center', padding: 16, backgroundColor: t.background },
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
    title: { fontSize: 20, fontWeight: '600', color: t.cardForeground, marginBottom: 12 },
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
    error: { color: t.destructive, marginTop: 12 },
    button: {
      marginTop: 20,
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
    busy: { marginTop: 16 },
    cancel: { marginTop: 12, paddingVertical: 8, alignItems: 'center' },
    cancelText: { color: t.mutedForeground, fontSize: 15 }
  })
