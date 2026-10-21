export type Limit = { kind: string; percent: number; resetsAt?: number }
export type Meter = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ctx-band': {
      meter: Meter | null
      /** Context growth of the last main-loop turns, in tokens. */
      growth: number[]
      lastRequestAt: number
      lastTurnUsd: number | null
    }
  }
}
