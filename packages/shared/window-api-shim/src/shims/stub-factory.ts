// cap-shell-2 — recursive Proxy factory for the 30+ namespaces cap-shell-2
// intentionally leaves unwired. Each leaf is BOTH a function and an object,
// so `window.api.git.something.deeplyNested()` never throws — every Proxy on
// `get` returns another callable Proxy, and every `apply` returns the stub
// return value. Method-name heuristics choose the return shape:
//
//   on<Event>   → () => void  (subscription unsub)
//   get<Plural> → []          (empty collection)
//   list / getAll / ... → []
//   * → Promise.resolve([])   (empty array satisfies spread/iterate/forEach/length/AnyType[])
//
// The renderer sees stable shapes; deeper shims (cap-shell-3..7) replace
// each namespace wholesale via the assemble step in shims/index.ts.

const noopUnsub = (): void => undefined

function isSubscriptionName(name: string): boolean {
  return name.startsWith('on') && name.length > 2 && name[2] === name[2]!.toUpperCase()
}

function buildStubFn(_namespace: string, path: string[]): (...args: unknown[]) => unknown {
  return function stubFn(..._args: unknown[]): unknown {
    const leaf = path[path.length - 1] ?? ''
    if (isSubscriptionName(leaf)) {
      return noopUnsub
    }
    return Promise.resolve([])
  }
}

export function makeStubNamespace(namespace: string, path: string[] = []): unknown {
  const target = buildStubFn(namespace, path) as unknown as object
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => `[cap-shell-2 stub ${namespace}]`
      if (prop === 'then') return undefined
      if (typeof prop !== 'string') return undefined
      return makeStubNamespace(namespace, [...path, prop])
    },
    apply(_t, _thisArg, args) {
      return buildStubFn(namespace, path)(...args)
    },
  })
}
