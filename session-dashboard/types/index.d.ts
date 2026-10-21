export type ChangedFile = {
  path: string
  /** Created by this session (a Write that made the file), not just modified. */
  isNew: boolean
  added: number
  removed: number
  edits: number
  at: number
}
export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  startedAt: number
  endedAt?: number
}
export type Job = {
  id: string
  kind: 'cron' | 'wakeup'
  schedule: string
  prompt: string
  recurring: boolean
  nextFireAt?: number
}

export type Tab = 'activity' | 'overhead'

/** Observed request tokens; `input` includes cache reads and writes. */
export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  uncached: number
}
export type ModelInfo = { model?: string; effort?: string }
export type AgentTokens = ModelInfo & {
  tokens: Tokens
  /** Input size of each request, the latest last (kept short). */
  inputs: number[]
}
export type Limit = { kind: string; percent: number; resetsAt?: number }
export type Meter = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  usd?: number
}
export type BreakdownRow = { name: string; tokens: number; color: string }
export type Breakdown = {
  rows: BreakdownRow[]
  /** MCP tool tokens by server. */
  mcpServers: BreakdownRow[]
  deferred: number
  total: number
  /** The window compaction measures against. */
  maxTokens: number
  compactAt?: number
}
export type Growth = {
  /** Context size at the end of the last main turn. */
  last?: number
  deltas: number[]
}
export type Compaction = { before: number; after: number }

declare module 'claude-code' {
  interface PluginState {
    'session-dashboard': {
      files: ChangedFile[]
      agents: AgentRow[]
      jobs: Job[]
      tab: Tab
      meter: Meter | null
      breakdown: Breakdown | null
      main: Tokens
      modelInfo: ModelInfo
      agentTokens: Record<string, AgentTokens>
      growth: Growth
      compactions: Compaction[]
      lastRequestAt: number
      lastTurnUsd: number | null
    }
  }
}
