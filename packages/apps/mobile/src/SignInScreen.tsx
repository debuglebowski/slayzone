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
import { type HubSession, signIn } from './hub-session'
import { type Theme, useTheme } from './theme'

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

export function SignInScreen({ onSignedIn }: { onSignedIn: (session: HubSession) => void }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [hub, setHub] = useState(DEV_PREFILL.hub)
  const [email, setEmail] = useState(DEV_PREFILL.email)
  const [password, setPassword] = useState(DEV_PREFILL.password)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    setBusy(true)
    setError(null)
    void signIn(hub, email, password)
      .then((result) => {
        if (result.ok) onSignedIn(result.session)
        else setError(result.error)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .then(() => setBusy(false))
  }

  useEffect(() => {
    if (!DEV_AUTO_SUBMIT) return
    void signIn(DEV_PREFILL.hub, DEV_PREFILL.email, DEV_PREFILL.password).then((result) => {
      if (result.ok) onSignedIn(result.session)
      else setError(result.error)
    })
  }, [onSignedIn])

  const canSubmit = !busy && hub.trim() !== '' && email.trim() !== '' && password !== ''

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Sign in to a hub</Text>
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
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={submit}
          disabled={!canSubmit}
        >
          {busy ? (
            <ActivityIndicator color={theme.primaryForeground} />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (t: Theme) =>
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
    title: { fontSize: 20, fontWeight: '600', color: t.foreground, marginBottom: 12 },
    label: { fontSize: 13, color: t.mutedForeground, marginTop: 12, marginBottom: 4 },
    input: {
      borderWidth: 1,
      borderColor: t.input,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: t.foreground
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
    buttonText: { color: t.primaryForeground, fontSize: 16, fontWeight: '600' }
  })
