import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import type { Limit, Meter } from '../types'

const meter = atom({ plugin: 'ctx-band', key: 'meter' } as const, null)
const growth = atom({ plugin: 'ctx-band', key: 'growth' } as const, [])
const lastRequestAt = atom({ plugin: 'ctx-band', key: 'lastRequestAt' } as const, 0)
const lastTurnUsd = atom({ plugin: 'ctx-band', key: 'lastTurnUsd' } as const, null)

const GROWTH_KEPT = 10
const BAR_CELLS = 10
const SPARKS = '▁▂▃▄▅▆▇█'

// ---------- pure helpers ----------

type UsageLike = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const toMeter = (u: UsageLike): Meter => ({
  tokens: u.context.tokens,
  window: u.context.window,
  percent: u.context.percent,
  limits: u.rateLimits.map(
    (r): Limit => ({
      kind: r.kind,
      percent: r.percentUsed,
      resetsAt: r.resetsAt === undefined ? undefined : Date.parse(r.resetsAt),
    }),
  ),
  usd: u.cost?.usd,
})

const compact = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${+(n / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}
const money = (usd: number) => `$${usd.toFixed(2)}`
const level = (percent: number) =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'
const LIMIT_NAME: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }

const sparkline = (deltas: number[]) => {
  const top = Math.max(1, ...deltas)
  return deltas
    .map(d => SPARKS[d <= 0 ? 0 : Math.min(7, Math.round((d / top) * 7))])
    .join('')
}

// ---------- the mod ----------

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000
  // Context and cost when the current main-loop turn began.
  let turnStart: { tokens?: number; usd?: number } = {}

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const usage = await $.session.usage()
    await update($, meter, () => toMeter(usage))
    // Cache and reset countdowns move by the minute.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))

    return started
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await update($, meter, () => toMeter(e))
    if (e.changed.includes('context')) {
      const now = await $.clock.now()
      await update($, lastRequestAt, () => now)
    }
    return measured
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const m = await read($, meter)
    turnStart = { tokens: m?.tokens, usd: m?.usd }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const usage = await $.session.usage()
    const after = toMeter(usage)
    await update($, meter, () => after)
    if (turnStart.tokens !== undefined && after.tokens !== undefined) {
      const delta = after.tokens - turnStart.tokens
      await update($, growth, list => [...list, delta].slice(-GROWTH_KEPT))
    }
    if (turnStart.usd !== undefined && after.usd !== undefined) {
      const spent = after.usd - turnStart.usd
      await update($, lastTurnUsd, () => spent)
    }
    turnStart = { tokens: after.tokens, usd: after.usd }
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, meter)
    if (e.props.hasSurvey || m === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const deltas = await read($, growth)
    const requestAt = await read($, lastRequestAt)
    const turnUsd = await read($, lastTurnUsd)

    // Each segment: its plain width (to fit the line), its drawing, and a
    // priority; the lowest priorities drop first on a narrow terminal.
    type Segment = { width: number; node: unknown; priority: number; isGlued?: boolean }
    const segments: Segment[] = []

    // ctx ■■■□□□□□□□ 27% 271k/1M
    const percent = m.percent ?? (m.tokens !== undefined ? Math.round((m.tokens / m.window) * 100) : 0)
    const filled = Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS))
    const used = m.tokens !== undefined ? `${compact(m.tokens)}/` : ''
    const ctxText = `ctx ${'■'.repeat(BAR_CELLS)} ${percent}% ${used}${compact(m.window)}`
    segments.push({
      width: ctxText.length,
      priority: 100,
      node: (
        <Text>
          <Text dimColor>ctx </Text>
          <Text color={level(percent)}>{'■'.repeat(filled)}</Text>
          <Text color="subtle">{'□'.repeat(BAR_CELLS - filled)}</Text>
          <Text bold color={level(percent)}>
            {' '}
            {percent}%
          </Text>
          <Text dimColor>
            {' '}
            {used}
            {compact(m.window)}
          </Text>
        </Text>
      ),
    })

    // ▁▁▃█▁▇▁ ↑3.4k
    if (deltas.length > 0) {
      const last = deltas[deltas.length - 1]!
      const arrow = last >= 0 ? `↑${compact(last)}` : `↓${compact(-last)}`
      const spark = sparkline(deltas)
      segments.push({
        width: spark.length + 1 + arrow.length,
        priority: 40,
        isGlued: true,
        node: (
          <Text>
            <Text color="claude">{spark}</Text>
            <Text dimColor> {arrow}</Text>
          </Text>
        ),
      })
    }

    // cache warm 38m
    if (requestAt > 0) {
      const left = requestAt + ttlMs - now
      const isWarm = left > 0
      const text = isWarm ? `cache warm ${span(left)}` : 'cache cold'
      segments.push({
        width: text.length,
        priority: 60,
        node: (
          <Text>
            <Text dimColor>cache </Text>
            <Text color={isWarm ? (left < 5 * 60_000 ? 'warning' : 'suggestion') : 'inactive'}>
              {isWarm ? `warm ${span(left)}` : 'cold'}
            </Text>
          </Text>
        ),
      })
    }

    // 5h 42% ↻2h34m · 7d 63% ↻2d7h
    for (const limit of m.limits) {
      const name = LIMIT_NAME[limit.kind] ?? limit.kind
      const reset = limit.resetsAt !== undefined ? ` ↻${span(limit.resetsAt - now)}` : ''
      const pct = `${Math.round(limit.percent)}%`
      segments.push({
        width: name.length + 1 + pct.length + reset.length,
        priority: limit.kind === 'five_hour' ? 80 : 70,
        node: (
          <Text>
            <Text dimColor>{name} </Text>
            <Text bold color={level(limit.percent)}>
              {pct}
            </Text>
            <Text dimColor>{reset}</Text>
          </Text>
        ),
      })
    }

    // cost ≈$1.84 (+$0.12)
    if (m.usd !== undefined) {
      const turn = turnUsd !== null && turnUsd > 0 ? ` (+${money(turnUsd)})` : ''
      segments.push({
        width: 6 + money(m.usd).length + turn.length,
        priority: 50,
        node: (
          <Text>
            <Text dimColor>cost </Text>
            <Text color="warning">≈{money(m.usd)}</Text>
            <Text dimColor>{turn}</Text>
          </Text>
        ),
      })
    }

    // Drop the lowest priorities until the line fits.
    // Separators: ' │ ' between segments, two spaces before a glued one.
    const room = e.props.bodyColumns
    const kept = [...segments]
    const widthOf = (list: Segment[]) =>
      list.reduce((n, s, i) => n + s.width + (i === 0 ? 0 : s.isGlued ? 2 : 3), 0)
    while (kept.length > 1 && widthOf(kept) > room) {
      const lowest = kept.reduce((a, b) => (b.priority < a.priority ? b : a))
      kept.splice(kept.indexOf(lowest), 1)
    }

    return (
      <Box flexDirection="row">
        <Text wrap="truncate-end">
          {kept.map((s, i) => (
            <Text>
              {i > 0 && (s.isGlued ? <Text>  </Text> : <Text color="subtle"> │ </Text>)}
              {s.node as never}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
