// Native proof preload: only its first in-memory VFS counter may open on main.
const Module = require('node:module')
const { isMainThread } = require('node:worker_threads')
if (isMainThread) {
  const load = Module._load
  const proxies = new WeakMap()
  // Public-caller fixtures also bootstrap one isolated hub metadata DB.
  let countersAvailable = process.env.SLAYZONE_TEST_PUBLIC_CONTROLS === '1' ? 2 : 1
  const admit = (args) => {
    if (countersAvailable > 0 && args[0] === ':memory:') {
      countersAvailable--
      return
    }
    throw new Error('Native SQLite constructor refused on computer main')
  }
  Module._load = function (request, parent, isMain) {
    const value = Reflect.apply(load, this, [request, parent, isMain])
    if (request !== 'better-sqlite3') return value
    let proxy = proxies.get(value)
    if (!proxy) {
      proxy = new Proxy(value, {
        construct(target, args, newTarget) {
          admit(args)
          return Reflect.construct(target, args, newTarget)
        },
        apply(target, self, args) {
          admit(args)
          return Reflect.apply(target, self, args)
        }
      })
      proxies.set(value, proxy)
    }
    return proxy
  }
}
