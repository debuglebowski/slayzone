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
 * treats every mojom type spec as an opaque `MojomType` token and only
 * enforces the generic signatures the generated code actually relies on.
 */

/* eslint-disable @typescript-eslint/no-namespace */

export namespace mojo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export namespace internal {
    /**
     * Opaque token for a mojom type spec. The generated code only ever passes
     * these around (`Spec.$` into Struct/StructField/sendMessage) and never
     * reads through them, so an unknown-shaped token type-checks exactly the
     * usages that exist while keeping the real runtime free to change shape.
     */
    export type MojomType = unknown
    export const String: MojomType = undefined
    export const Bool: MojomType = undefined
    export const Int32: MojomType = undefined
    export const Uint32: MojomType = undefined
    export const Int64: MojomType = undefined
    export const Uint64: MojomType = undefined
    export const Float: MojomType = undefined
    export const Double: MojomType = undefined

    export function Array(..._args: unknown[]): MojomType {
      return undefined
    }

    export function Struct<_T>(...args: unknown[]): MojomType {
      return args
    }
    export function StructField<_T, _V>(...args: unknown[]): MojomType {
      return args
    }
    export function Union<_T>(...args: unknown[]): MojomType {
      return args
    }
    export function Enum(...args: unknown[]): MojomType {
      return args
    }

    export interface InterfaceProxy<_T> {
      $: unknown
    }
    // The generated code calls this as a plain spec factory — `InterfaceProxy(
    // FooRemote)` inside a StructField list — never with `new`.
    export const InterfaceProxy: (..._args: unknown[]) => MojomType = () => undefined

    export namespace interfaceSupport {
      export interface Endpoint<_T> {}
      export interface PendingReceiver<_T> {}

      /**
       * What `bindNewPipeAndPassReceiver()` hands back. The generated
       * `getRemote()` helpers immediately call `.bindInBrowser()` on it.
       */
      export interface BoundPendingReceiver {
        bindInBrowser(scope?: string): void
      }

      const inertPendingReceiver: BoundPendingReceiver = {
        bindInBrowser() {
          // No pipe exists in the shim — the browser process does the real bind.
        }
      }

      export function getEndpointForReceiver<T>(_handle: unknown): Endpoint<T> {
        return {}
      }
      export function bind(..._args: unknown[]): void {
        // The browser process performs the actual interface binding.
      }

      export class InterfaceRemoteBase<_T> {
        constructor(..._args: unknown[]) {
          // Inert stand-in: the real remote comes from the browser-served runtime.
        }
        bindNewPipeAndPassReceiver(): BoundPendingReceiver {
          return inertPendingReceiver
        }
        getConnectionErrorEventRouter(): ConnectionErrorEventRouter {
          return new ConnectionErrorEventRouter()
        }
        // `R` is inferred from the calling method's declared return type, which
        // is how the generated remotes type their `Promise<{...}>` replies.
        sendMessage<R = void>(..._args: unknown[]): Promise<R> {
          return Promise.resolve(undefined as unknown as R)
        }
      }

      export class InterfaceRemoteBaseWrapper<_T> {
        constructor(..._args: unknown[]) {
          // Inert stand-in: the real remote comes from the browser-served runtime.
        }
        bindNewPipeAndPassReceiver(): BoundPendingReceiver {
          return inertPendingReceiver
        }
        close(): void {
          // Nothing to release — no pipe was ever opened.
        }
      }

      export class InterfaceReceiverHelperInternal<_R, _P> {
        constructor(..._args: unknown[]) {
          // Inert stand-in: the real receiver comes from the browser-served runtime.
        }
        registerHandler(..._args: unknown[]): void {
          // Message dispatch only happens against the real runtime.
        }
        getConnectionErrorEventRouter(): ConnectionErrorEventRouter {
          return new ConnectionErrorEventRouter()
        }
      }

      export class InterfaceReceiverHelper<R, _P> {
        constructor(..._args: unknown[]) {
          // Inert stand-in: the real receiver comes from the browser-served runtime.
        }
        // Callers hand the result straight to a remote's `subscribe(observer)`,
        // so it must type as the helper's own remote half (`R`).
        bindNewPipeAndPassRemote(): R {
          return {} as unknown as R
        }
        close(): void {
          // Nothing to release — no pipe was ever opened.
        }
      }

      export class CallbackRouter {
        removeListener(_id: number): boolean {
          return false
        }
      }

      export class InterfaceCallbackReceiver<_F = unknown> {
        constructor(..._args: unknown[]) {
          // Inert stand-in: listeners only ever fire against the real runtime.
        }
        addListener(_handler: unknown): number {
          return 0
        }
        createReceiverHandler(..._args: unknown[]): unknown {
          return undefined
        }
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

// MojoHandle's global declaration lives in ../ambient.d.ts (single source —
// declaring it here too is a TS2300 duplicate when both files are in one
// program). Consumers that include this shim must include ambient.d.ts too.
