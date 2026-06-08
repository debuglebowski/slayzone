/**
 * Type-only shim for `//resources/mojo/mojo/public/js/bindings.js`.
 *
 * At runtime inside a real WebUI the browser serves the full Mojo runtime at
 * `chrome://resources/mojo/mojo/public/js/bindings.js`. Our generated
 * *-webui.ts files import it by that URL; tsconfig `paths` re-aims the import
 * at this shim during typecheck so the package type-checks without a Chromium
 * build.
 *
 * Phase 4 demo + tests use a higher-level transport (BroadcastChannel) from
 * @slayzone/state, so these symbols never need to actually execute in jsdom.
 * Phase 5+ integration tests load the real runtime by driving a built
 * Chromium binary (Phase 4.7 real-Chromium mode).
 *
 * The shape of Chromium's Mojo TS runtime is wide and evolves with each
 * Chromium roll — mirroring it precisely would be a maintenance burden for
 * something whose types we never check against real logic. The shim therefore
 * uses `any` as the leaf type in the `mojo.internal.*` namespace and only
 * enforces the generic signatures the generated code actually relies on.
 */

/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-explicit-any */

export namespace mojo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export namespace internal {
    export type MojomType = any
    export const String: any = undefined
    export const Bool: any = undefined
    export const Int32: any = undefined
    export const Uint32: any = undefined
    export const Int64: any = undefined
    export const Uint64: any = undefined
    export const Float: any = undefined
    export const Double: any = undefined

    export function Array(..._args: any[]): any {
      return undefined
    }

    export function Struct<_T>(...args: any[]): any {
      return args
    }
    export function StructField<_T, _V>(...args: any[]): any {
      return args
    }
    export function Union<_T>(...args: any[]): any {
      return args
    }
    export function Enum(...args: any[]): any {
      return args
    }

    export interface InterfaceProxy<_T> {
      $: any
    }
    export const InterfaceProxy: any = class {}

    export namespace interfaceSupport {
      export interface Endpoint<_T> {}
      export interface PendingReceiver<_T> {}
      export function getEndpointForReceiver<T>(_handle: any): Endpoint<T> {
        return {} as any
      }
      export function bind(..._args: any[]): void {}

      export class InterfaceRemoteBase<_T> {
        constructor(..._args: any[]) {}
        bindNewPipeAndPassReceiver(): any {
          return { bindInBrowser: () => {} }
        }
        getConnectionErrorEventRouter(): ConnectionErrorEventRouter {
          return new ConnectionErrorEventRouter()
        }
        sendMessage(..._args: any[]): any {
          return Promise.resolve()
        }
      }

      export class InterfaceRemoteBaseWrapper<_T> {
        constructor(..._args: any[]) {}
        bindNewPipeAndPassReceiver(): any {
          return { bindInBrowser: () => {} }
        }
      }

      export class InterfaceReceiverHelperInternal<_R, _P> {
        constructor(..._args: any[]) {}
        registerHandler(..._args: any[]): void {}
        getConnectionErrorEventRouter(): ConnectionErrorEventRouter {
          return new ConnectionErrorEventRouter()
        }
      }

      export class InterfaceReceiverHelper<_R, _P> {
        constructor(..._args: any[]) {}
      }

      export class CallbackRouter {
        removeListener(_id: number): boolean {
          return false
        }
      }

      export class InterfaceCallbackReceiver<_F = any> {
        constructor(..._args: any[]) {}
        addListener(_handler: any): number {
          return 0
        }
        createReceiverHandler(..._args: any[]): any {}
      }

      export class ConnectionErrorEventRouter {
        addListener(_handler: () => void): number {
          return 0
        }
        removeListener(_id: number): boolean {
          return false
        }
      }
    }
  }
}

declare global {
  // Chromium exposes MojoHandle as a host object in WebUI contexts. In our
  // dev/test typecheck we only need a name — real calls route through the
  // Mojo runtime delivered by the browser.
  type MojoHandle = unknown
}
