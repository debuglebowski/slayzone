/**
 * `slay hub owner-password [name]` — the bootstrap owner's password of a hub other
 * machines can reach (T-11).
 *
 * Such a hub writes no `hub.owner.json`: its first admin's password derives from
 * `SLAYZONE_HUB_AUTH_SECRET` (`@slayzone/platform/hub-auth-secret`), so whoever holds
 * the secret can sign in as it and nothing secret sits on the hub's disk. This prints
 * that password — and only it — on stdout, so it pipes straight into `slay hub login`,
 * which reads a password from stdin:
 *
 *   slay hub owner-password <name> | slay hub login <url> --email owner@hub.slayzone.local
 *
 * The secret comes from this shell's environment, else from the named hub's service
 * unit (written owner-only by `slay hub create`). The password is the one the hub set
 * when it created the owner; once the owner changes it, this no longer signs in.
 *
 * @module cli/commands/hub-owner-password
 */
import { Command } from 'commander'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { HUB_ADDRESS_ENV } from '@slayzone/platform/hub-switches'
import { readUnitSecrets } from '@slayzone/platform/service-unit'
import { fail, resolveBackend } from '../service'

function resolveAuthSecret(name: string | undefined): string {
  const fromEnv = process.env[HUB_ADDRESS_ENV.authSecret]
  if (fromEnv?.trim()) return fromEnv
  const backend = resolveBackend()
  const fromUnit =
    name !== undefined && backend !== 'none'
      ? readUnitSecrets('hub', name, backend)[HUB_ADDRESS_ENV.authSecret]
      : undefined
  if (fromUnit?.trim()) return fromUnit
  fail(
    `No ${HUB_ADDRESS_ENV.authSecret}: set it in this shell to the hub's value` +
      (name === undefined
        ? ', or name a hub registered on this machine (`slay hub owner-password <name>`).'
        : `, or check that hub "${name}" is registered here (\`slay hub registered\`).`)
  )
}

export function hubOwnerPasswordCommand(): Command {
  return new Command('owner-password')
    .description(
      `Print the first admin's password of a hub other machines can reach (${BOOTSTRAP_OWNER_EMAIL}; ` +
        `derived from ${HUB_ADDRESS_ENV.authSecret})`
    )
    .argument('[name]', 'A hub registered on this machine, to read the secret from its unit')
    .action((name: string | undefined) => {
      process.stdout.write(`${deriveBootstrapOwnerPassword(resolveAuthSecret(name))}\n`)
      if (process.stdout.isTTY) {
        console.error(
          `Account: ${BOOTSTRAP_OWNER_EMAIL}. Sign in without showing it:\n` +
            `  slay hub owner-password${name ? ` ${name}` : ''} | slay hub login <hub url> ` +
            `--email ${BOOTSTRAP_OWNER_EMAIL}`
        )
      }
    })
}
