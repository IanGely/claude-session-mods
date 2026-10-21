import type { ElementTable } from 'claude-code'

import type {
  AgentRow,
  AgentTokens,
  Breakdown,
  Compaction,
  Growth,
  Meter,
  ModelInfo,
  Tokens,
} from '../types'

// ---------- data helpers ----------

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const requestSize = (u: Usage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export const addTokens = (t: Tokens, u: Usage): Tokens => ({
  input: t.input + requestSize(u),
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  uncached: t.uncached + u.input_tokens,
})

type RawBreakdown = {
  categories: readonly { name: string; tokens: number; color: string; kind: string }[]
  mcpTools: readonly { serverName: string; tokens: number; isLoaded: boolean }[]
  totalTokens: number
  rawMaxTokens: number
  autoCompactThreshold?: number
}

export const toBreakdown = (b: RawBreakdown): Breakdown => {
  const servers = new Map<string, number>()
  for (const tool of b.mcpTools) {
    if (!tool.isLoaded) continue
    servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  }
  return {
    rows: b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens, color: c.color }))
      .sort((x, y) => y.tokens - x.tokens),
    mcpServers: [...servers]
      .map(([name, tokens]) => ({ name, tokens, color: 'subtle' }))
      .sort((x, y) => y.tokens - x.tokens),
    deferred: b.categories.filter(c => c.kind === 'deferred').reduce((n, c) => n + c.tokens, 0),
    total: b.totalTokens,
    maxTokens: b.rawMaxTokens,
    compactAt: b.autoCompactThreshold,
  }
}

// ---------- formatting ----------

export const compact = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
export const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const level = (percent: number) => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')

const SPARKS = '▁▂▃▄▅▆▇█'
export const sparkline = (values: number[]) => {
  const top = Math.max(1, ...values)
  return values.map(v => SPARKS[v <= 0 ? 0 : Math.min(7, Math.round((v / top) * 7))]).join('')
}

const LIMIT_WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
const LIMIT_NAME: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// ---------- the view ----------

export type OverheadData = {
  sessionId: string
  meter: Meter | null
  breakdown: Breakdown | null
  main: Tokens
  modelInfo: ModelInfo
  agentTokens: Record<string, AgentTokens>
  agents: AgentRow[]
  growth: Growth
  compactions: Compaction[]
  lastRequestAt: number
  lastTurnUsd: number | null
  ttlMs: number
}

export const OverheadView = (props: {
  el: ElementTable
  data: OverheadData
  now: number
  width: number
}) => {
  const { Box, Text } = props.el
  const { data: d, now } = props
  const LABEL = 14
  const BAR = Math.max(8, Math.min(16, props.width - LABEL - 22))

  const Section = (p: { title: string; children?: unknown }) => (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{p.title}</Text>
      {p.children as never}
    </Box>
  )
  const Row = (p: { label: string; children?: unknown }) => (
    <Box flexDirection="row">
      <Box width={LABEL} flexShrink={0}>
        <Text>{p.label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{p.children as never}</Text>
      </Box>
    </Box>
  )
  const Note = (p: { text: string }) => (
    <Row label="">
      <Text dimColor>{p.text}</Text>
    </Row>
  )
  const Bar = (p: { percent: number; projected?: number; color: string }) => {
    const filled = Math.min(BAR, Math.round((p.percent / 100) * BAR))
    const shaded =
      p.projected === undefined
        ? 0
        : Math.max(0, Math.min(BAR, Math.round((p.projected / 100) * BAR)) - filled)
    return (
      <Text>
        <Text color={p.color}>{'█'.repeat(filled)}</Text>
        <Text color="subtle">{'▒'.repeat(shaded)}</Text>
        <Text color="subtle">{'░'.repeat(BAR - filled - shaded)}</Text>
      </Text>
    )
  }

  // ----- context -----
  const m = d.meter
  const b = d.breakdown
  const tokens = m?.tokens ?? b?.total
  const windowSize = b?.maxTokens ?? m?.window
  const fill = tokens !== undefined && windowSize ? pct(tokens, windowSize) : (m?.percent ?? 0)
  const context = (
    <Section title="Context">
      <Row label="window">
        <Bar percent={fill} color={level(fill)} />
        <Text bold color={level(fill)}>
          {' '}
          {fill}%
        </Text>
        <Text dimColor>
          {' '}
          {tokens !== undefined ? compact(tokens) : '—'} of {windowSize ? compact(windowSize) : '—'}
        </Text>
      </Row>
      {m !== null && windowSize !== m.window && (
        <Row label="model limit">
          <Text dimColor>{compact(m.window)} tokens</Text>
        </Row>
      )}
      {b?.compactAt !== undefined && (
        <Row label="compacts">
          <Text dimColor>at {compact(b.compactAt)}</Text>
          {tokens !== undefined && (
            <Text color={b.compactAt - tokens < 50_000 ? 'error' : 'warning'}>
              {' '}
              · {compact(Math.max(0, b.compactAt - tokens))} to go
            </Text>
          )}
        </Row>
      )}
      <Row label="model">
        <Text dimColor>
          {d.modelInfo.model ?? '—'}
          {d.modelInfo.effort !== undefined ? ` · effort ${d.modelInfo.effort}` : ''}
        </Text>
      </Row>
      <Row label="session ID">
        <Text dimColor>{d.sessionId || '—'}</Text>
      </Row>
    </Section>
  )

  // ----- breakdown -----
  const breakdown =
    b === null ? null : (
      <Section title="In the window, as /context estimates it">
        {b.rows.map(row => (
          <Box flexDirection="column">
            <Text>
              <Text color={row.color}>{compact(row.tokens).padStart(8)}</Text>
              <Text dimColor>{`${pct(row.tokens, b.total)}%`.padStart(6)}</Text>
              <Text>{'  '}{row.name}</Text>
            </Text>
            {row.name === 'MCP tools' &&
              b.mcpServers.map(server => (
                <Text dimColor>
                  {compact(server.tokens).padStart(8)}
                  {'      '}
                  {'    '}
                  {server.name}
                </Text>
              ))}
          </Box>
        ))}
        {b.deferred > 0 && (
          <Text dimColor>
            {compact(b.deferred).padStart(8)}
            {'      '}
            {'  '}deferred tool schemas, not in the window
          </Text>
        )}
      </Section>
    )

  // ----- growth -----
  const deltas = d.growth.deltas
  const last10 = deltas.slice(-10)
  const latest = last10[last10.length - 1]
  const positive = deltas.filter(x => x > 0)
  const largest = positive.length > 0 ? Math.max(...positive) : undefined
  const average =
    positive.length > 0 ? positive.reduce((n, x) => n + x, 0) / positive.length : undefined
  const growth = (
    <Section title="Growth">
      <Row label="last 10">
        {last10.length === 0 ? (
          <Text dimColor>no turns yet</Text>
        ) : (
          <Text>
            <Text color="claude">{sparkline(last10)}</Text>
            {latest !== undefined && (
              <Text dimColor> {latest >= 0 ? `↑${compact(latest)}` : `↓${compact(-latest)}`}</Text>
            )}
          </Text>
        )}
      </Row>
      {largest !== undefined && average !== undefined && (
        <Row label="largest">
          <Text color="warning">↑{compact(largest)}</Text>
          <Text dimColor> · average ↑{compact(average)}</Text>
        </Row>
      )}
      {d.compactions.length > 0 && (
        <Row label="compacted">
          <Text dimColor>
            {d.compactions
              .slice(-3)
              .map(c => `${compact(c.before)} → ${compact(c.after)}`)
              .join(' · ')}
          </Text>
        </Row>
      )}
    </Section>
  )

  // ----- tokens & cache -----
  const t = d.main
  const cacheLeft = d.lastRequestAt > 0 ? d.lastRequestAt + d.ttlMs - now : -1
  const hitRate = pct(t.cacheRead, t.input)
  const cache = (
    <Section title="Tokens & cache, main conversation">
      <Row label="state">
        {d.lastRequestAt === 0 ? (
          <Text dimColor>no request yet</Text>
        ) : cacheLeft > 0 ? (
          <Text>
            <Text color={cacheLeft < 5 * 60_000 ? 'warning' : 'suggestion'}>
              warm {span(cacheLeft)}
            </Text>
            <Text dimColor> left of {span(d.ttlMs)}</Text>
          </Text>
        ) : (
          <Text color="inactive">cold · next request rewrites the cache</Text>
        )}
      </Row>
      <Row label="tokens">
        <Text>
          {compact(t.input)} in · {compact(t.output)} out
        </Text>
      </Row>
      <Note text="Observed requests only; input includes cache" />
      <Row label="hit rate">
        <Text color="suggestion">{hitRate}%</Text>
        <Text dimColor>
          {' '}
          · read {compact(t.cacheRead)} · written {compact(t.cacheWrite)} · uncached{' '}
          {compact(t.uncached)}
        </Text>
      </Row>
    </Section>
  )

  // ----- quota, with a window-average projection -----
  const limits = m?.limits ?? []
  const quota =
    limits.length === 0 ? null : (
      <Section title="Quota, shaded = window-average projection">
        {limits.map(limit => {
          const name = LIMIT_NAME[limit.kind] ?? limit.kind
          const windowMs = LIMIT_WINDOW_MS[limit.kind]
          const left = limit.resetsAt !== undefined ? limit.resetsAt - now : undefined
          let projected: number | undefined
          let note = ''
          if (windowMs !== undefined && left !== undefined && left > 0) {
            const elapsed = windowMs - left
            const rate = elapsed > 0 ? limit.percent / elapsed : 0
            projected = Math.round(limit.percent + rate * left)
            if (projected < 100) {
              note = `≈${projected}% by reset · reset comes first`
            } else {
              const untilFull = rate > 0 ? (100 - limit.percent) / rate : Infinity
              note = `hits 100% in ≈${span(untilFull)} · before reset`
            }
          }
          return (
            <Box flexDirection="column">
              <Row label={name}>
                <Bar percent={limit.percent} projected={projected} color={level(limit.percent)} />
                <Text bold color={level(limit.percent)}>
                  {' '}
                  {Math.round(limit.percent)}%
                </Text>
                <Text dimColor>{left !== undefined ? ` ↻${span(left)}` : ''}</Text>
              </Row>
              {note !== '' && <Note text={note} />}
            </Box>
          )
        })}
      </Section>
    )

  // ----- cost -----
  const cost =
    m?.usd === undefined ? null : (
      <Section title="Cost, API-price reference">
        <Row label="session">
          <Text color="warning">≈${m.usd.toFixed(2)}</Text>
        </Row>
        {d.lastTurnUsd !== null && (
          <Row label="last turn">
            <Text dimColor>+${d.lastTurnUsd.toFixed(2)}</Text>
          </Row>
        )}
        <Note text="API-price reference, not a billing receipt" />
      </Section>
    )

  // ----- subagents -----
  const ids = Object.keys(d.agentTokens)
  const subagents =
    ids.length === 0 ? null : (
      <Section title="Subagents">
        {ids.slice(-4).map((id, i) => {
          const a = d.agentTokens[id]!
          const row = d.agents.find(x => x.id === id)
          const lastInput = a.inputs[a.inputs.length - 1]
          return (
            <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Row label={row?.type ?? 'agent'}>
                <Text>{row?.description ?? ''}</Text>
              </Row>
              <Row label="agent ID">
                <Text dimColor>{id}</Text>
              </Row>
              <Row label="model">
                <Text>{a.model ?? '—'}</Text>
                <Text dimColor>{a.effort !== undefined ? ` · effort ${a.effort}` : ''}</Text>
              </Row>
              {lastInput !== undefined && (
                <Row label="last input">
                  <Text>{compact(lastInput)} </Text>
                  <Text color="suggestion">{sparkline(a.inputs.slice(-8))}</Text>
                </Row>
              )}
              <Row label="tokens">
                <Text>
                  {compact(a.tokens.input)} in · {compact(a.tokens.output)} out
                </Text>
                <Text dimColor> · {compact(a.tokens.cacheRead)} cache read</Text>
              </Row>
            </Box>
          )
        })}
        <Note text="Observed requests only; input includes cache" />
      </Section>
    )

  return (
    <Box flexDirection="column">
      {context}
      {breakdown}
      {growth}
      {cache}
      {quota}
      {cost}
      {subagents}
    </Box>
  )
}
