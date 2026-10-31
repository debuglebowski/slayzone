import { z } from 'zod'

/** Additive, versioned HTTP byte stream over the authenticated computer channel. */
export const HTTP_TUNNEL_PREFIX = 'cli.v1.'
export const HTTP_TUNNEL_CHUNK = 32 * 1024
export const httpTunnelParamsSchema = z
  .object({
    id: z.string().min(1).max(100),
    data: z
      .string()
      .max(Math.ceil(HTTP_TUNNEL_CHUNK / 3) * 4)
      .optional(),
    end: z.boolean().optional()
  })
  .strict()
export interface HttpTunnelReader {
  data: string
  end: boolean
}
export const httpTunnelOpenResultSchema = z.object({ id: z.string().min(1).max(100) })
export const httpTunnelReadResultSchema = z.object({
  data: z.string().max(Math.ceil(HTTP_TUNNEL_CHUNK / 3) * 4),
  end: z.boolean()
})
export interface HttpTunnelRequester {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
}
