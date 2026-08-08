// Ambient declarations for @slayzone/mojo-bindings. Keeping this file as a
// pure script (no imports, no exports) ensures the declarations attach to
// the global scope. Consumers that import any .ts file from this package
// pick it up via the tsconfig `include`.

type MojoHandle = unknown

declare module '//resources/mojo/mojo/public/js/bindings.js' {
  // The actual shape is re-exported from runtime/bindings-shim.ts. We can't
  // `export * from '../runtime/bindings-shim'` in an ambient declare module
  // block (TS rejects relative path re-exports there), so we borrow the shim's
  // `namespace mojo` through an `import()` type — allowed here because it does
  // not turn this file into a module — and let it do the typing work.
  export const mojo: typeof import('./runtime/bindings-shim').mojo
}
