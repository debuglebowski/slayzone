import { z } from 'zod'
import { assertHubPushEnabled, hubPushEnabled } from '@slayzone/platform/hub-switch-refusal'
import { router, publicProcedure, type TrpcContext } from '@slayzone/trpc-server'
import { EXPO_PUSH_TOKEN, type PushPrefs } from '../index'
import { getDevicePrefs, registerDevice, setDevicePrefs, unregisterDevice } from './device-store'

/**
 * `push`: the caller's phones on this hub (`device-store.ts`). A phone registers its
 * Expo token after the user allows notifications, reads and changes which kinds it
 * wants, and unregisters when it signs out of the hub. Every call touches only the
 * caller's own rows. `SLAYZONE_HUB_ENABLE_PUSH=0` refuses registration; `status`
 * reports it so the phone can say why.
 */

/** The user from the verified connection; '' on a hub without login. */
const userOf = (ctx: TrpcContext): string => ctx.principal?.userId ?? ''

const deviceId = z.string().min(1).max(200)

export const pushRouter = router({
  status: publicProcedure.input(z.object({ deviceId })).query(
    async ({ ctx, input }): Promise<{ enabled: boolean; device: PushPrefs | null }> => ({
      enabled: hubPushEnabled(),
      device: await getDevicePrefs(ctx.db, userOf(ctx), input.deviceId)
    })
  ),

  register: publicProcedure
    .input(
      z.object({
        deviceId,
        token: z.string().max(400).regex(EXPO_PUSH_TOKEN),
        hubRef: z.string().max(400)
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertHubPushEnabled({ op: 'register' })
      await registerDevice(ctx.db, userOf(ctx), input)
    }),

  unregister: publicProcedure.input(z.object({ deviceId })).mutation(async ({ ctx, input }) => {
    await unregisterDevice(ctx.db, userOf(ctx), input.deviceId)
  }),

  setPrefs: publicProcedure
    .input(z.object({ deviceId, ready: z.boolean().optional(), errors: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      await setDevicePrefs(ctx.db, userOf(ctx), input.deviceId, input)
    })
})

export type PushRouter = typeof pushRouter

/**
 * Where this domain's router sits in the app router. `@slayzone/api` mounts
 * `pushRouter` at `push` (and asserts the slice in its `router.ts`).
 */
export type PushMounts = { push: PushRouter }
