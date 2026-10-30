/**
 * An immutable string-keyed map whose versions share structure: `with` returns
 * a new version and leaves the old one as it was, copying only the path to the
 * changed key (two 32-slot arrays and one small bucket), not every entry.
 *
 * For reducer state that grows with the conversation. Copying a `Map` per
 * added key is quadratic: a 10,000-event session spent ~300 ms of its ~300 ms
 * replay copying `toolIndex` (plan 4.1 perf budget). Small indexes stay a plain
 * `Map` copied per change — cheaper than the trie's arrays for the few keys
 * most conversations have — and become the trie past {@link SMALL_MAX} keys.
 */
/** Up to this many keys: a plain Map, copied per change. */
const SMALL_MAX = 64
/** 5 bits of the hash per level: 32 slots. */
const BITS = 5
const WIDTH = 32
const MASK = 31

type Bucket<V> = ReadonlyMap<string, V>
type Branch<V> = ReadonlyArray<Bucket<V> | undefined>
type Root<V> = ReadonlyArray<Branch<V> | undefined>

/** FNV-1a: cheap, well spread over ids like `toolu_01AbC…`. */
function hash(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const EMPTY_ROOT: Root<never> = Object.freeze(new Array<undefined>(WIDTH).fill(undefined))

export class PersistentIndex<V> {
  private constructor(
    /** The keys while few (`root` is null then). */
    private readonly small: ReadonlyMap<string, V> | null,
    private readonly root: Root<V> | null,
    readonly size: number
  ) {}

  static empty<V>(): PersistentIndex<V> {
    return new PersistentIndex<V>(new Map(), null, 0)
  }

  get(key: string): V | undefined {
    if (this.small) return this.small.get(key)
    const h = hash(key)
    return this.root?.[h & MASK]?.[(h >>> BITS) & MASK]?.get(key)
  }

  has(key: string): boolean {
    if (this.small) return this.small.has(key)
    const h = hash(key)
    return this.root?.[h & MASK]?.[(h >>> BITS) & MASK]?.has(key) ?? false
  }

  /** A new version with `key` set to `value`; this one is unchanged. */
  with(key: string, value: V): PersistentIndex<V> {
    if (this.small) {
      if (this.small.get(key) === value && this.small.has(key)) return this
      const had = this.small.has(key)
      if (had || this.small.size < SMALL_MAX) {
        const next = new Map(this.small)
        next.set(key, value)
        return new PersistentIndex(next, null, next.size)
      }
      // Grows past small: every key into the trie, once.
      let root = EMPTY_ROOT as Root<V>
      for (const [k, v] of this.small) root = setIn(root, k, v)
      return new PersistentIndex<V>(null, setIn(root, key, value), this.size + 1)
    }
    const root = this.root ?? (EMPTY_ROOT as Root<V>)
    const h = hash(key)
    const bucket = root[h & MASK]?.[(h >>> BITS) & MASK]
    if (bucket?.get(key) === value && bucket.has(key)) return this
    return new PersistentIndex<V>(
      null,
      setIn(root, key, value),
      bucket?.has(key) ? this.size : this.size + 1
    )
  }
}

/** The trie with `key` set: copies only the path to its bucket. */
function setIn<V>(root: Root<V>, key: string, value: V): Root<V> {
  const h = hash(key)
  const r = h & MASK
  const b = (h >>> BITS) & MASK
  const branch = root[r]
  const nextBucket = new Map(branch?.[b])
  nextBucket.set(key, value)
  const nextBranch = branch
    ? branch.slice()
    : new Array<Bucket<V> | undefined>(WIDTH).fill(undefined)
  nextBranch[b] = nextBucket
  const nextRoot = root.slice()
  nextRoot[r] = nextBranch
  return nextRoot
}
