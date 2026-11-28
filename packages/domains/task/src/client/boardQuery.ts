import { decodeBoard } from '@slayzone/task-contracts'

/**
 * The app's board query options (`task.loadBoardData` with `CARD_BOARD_INPUT`: card
 * rows as columns) with rows decoded before they are cached — so every reader, patch
 * and `setQueryData` sees plain rows. Every reader of the board query wraps its
 * options here: same input, same key, same decoding. Types are unchanged (decoding
 * only moves rows from `taskColumns` to `tasks`).
 */
export function withBoardDecoding<T extends { queryFn?: unknown }>(options: T): T {
  const fetchBoard = options.queryFn as (ctx: unknown) => Promise<Parameters<typeof decodeBoard>[0]>
  return { ...options, queryFn: async (ctx: unknown) => decodeBoard(await fetchBoard(ctx)) }
}
