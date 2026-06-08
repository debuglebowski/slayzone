// Ambient declarations for @slayzone/mojo-bindings. Keeping this file as a
// pure script (no imports, no exports) ensures the declarations attach to
// the global scope. Consumers that import any .ts file from this package
// pick it up via the tsconfig `include`.

type MojoHandle = unknown

declare module '//resources/mojo/mojo/public/js/bindings.js' {
  // The actual shape is re-exported from runtime/bindings-shim.ts. We can't
  // `export * from '../runtime/bindings-shim'` in an ambient declare module
  // block (TS rejects relative path re-exports there), so we declare the one
  // symbol the generated code imports and let its own `namespace mojo` do
  // the typing work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const mojo: any
}
