declare module 'picomatch' {
  namespace picomatch {
    type Matcher = (test: string) => boolean
  }
  function picomatch(glob: string | string[], options?: Record<string, unknown>): picomatch.Matcher
  export = picomatch
}
