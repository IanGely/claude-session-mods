import { atom, read, update } from 'claude-code'
import type { AgentInfo, Register } from 'claude-code'

import type { AgentRow, ChangedFile, Job, Meter, Tab } from '../types'
import { NO_TOKENS, OverheadView, addTokens, requestSize, toBreakdown } from './overhead'

const PANE = 'session-dashboard'
const TITLE = 'Session'
const ACTIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const ENDED_SHOWN_MS = 5 * 60_000
const ENDED_SHOWN_MAX = 3
const SPINNER = ['◐', '◓', '◑', '◒']

const files = atom({ plugin: 'session-dashboard', key: 'files' } as const, [])
const agents = atom({ plugin: 'session-dashboard', key: 'agents' } as const, [])
const jobs = atom({ plugin: 'session-dashboard', key: 'jobs' } as const, [])
const tab = atom({ plugin: 'session-dashboard', key: 'tab' } as const, 'activity')
const meter = atom({ plugin: 'session-dashboard', key: 'meter' } as const, null)
const breakdown = atom({ plugin: 'session-dashboard', key: 'breakdown' } as const, null)
const main = atom({ plugin: 'session-dashboard', key: 'main' } as const, NO_TOKENS)
const modelInfo = atom({ plugin: 'session-dashboard', key: 'modelInfo' } as const, {})
const agentTokens = atom({ plugin: 'session-dashboard', key: 'agentTokens' } as const, {})
const growth = atom({ plugin: 'session-dashboard', key: 'growth' } as const, { deltas: [] })
const compactions = atom({ plugin: 'session-dashboard', key: 'compactions' } as const, [])
const lastRequestAt = atom({ plugin: 'session-dashboard', key: 'lastRequestAt' } as const, 0)
const lastTurnUsd = atom({ plugin: 'session-dashboard', key: 'lastTurnUsd' } as const, null)

type UsageLike = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}
const toMeter = (u: UsageLike): Meter => ({
  tokens: u.context.tokens,
  window: u.context.window,
  percent: u.context.percent,
  limits: u.rateLimits.map(r => ({
    kind: r.kind,
    percent: r.percentUsed,
    resetsAt: r.resetsAt === undefined ? undefined : Date.parse(r.resetsAt),
  })),
  usd: u.cost?.usd,
})

// ---------- pure helpers ----------

type Hunk = { lines: string[] }

const diffStat = (patch: readonly Hunk[] | undefined) => {
  let added = 0
  let removed = 0
  for (const hunk of patch ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

const addFile =
  (path: string, isNew: boolean, stat: { added: number; removed: number }, at: number) =>
  (list: ChangedFile[]): ChangedFile[] => {
    const old = list.find(f => f.path === path)
    const rest = list.filter(f => f.path !== path)
    const row: ChangedFile = {
      path,
      isNew: old?.isNew ?? isNew,
      added: (old?.added ?? 0) + stat.added,
      removed: (old?.removed ?? 0) + stat.removed,
      edits: (old?.edits ?? 0) + 1,
      at,
    }
    return [...rest, row].slice(-300)
  }

/** Merge the engine's agent list into ours, keeping start/end times. */
const mergeAgents = (prev: AgentRow[], live: AgentInfo[], now: number): AgentRow[] => {
  const seen = new Map(prev.map(a => [a.id, a]))
  const liveIds = new Set(live.map(a => a.id))
  const next: AgentRow[] = []
  for (const a of live) {
    const old = seen.get(a.id)
    const isActive = ACTIVE.has(a.status)
    // Only track agents we saw running, or that are running now.
    if (old === undefined && !isActive) continue
    next.push({
      id: a.id,
      type: a.type,
      description: a.description,
      status: a.status,
      startedAt: old?.startedAt ?? now,
      endedAt: isActive ? undefined : (old?.endedAt ?? now),
    })
  }
  for (const old of prev) {
    if (liveIds.has(old.id)) continue
    // Gone from the engine's list: it ended.
    next.push(
      old.endedAt === undefined ? { ...old, status: 'completed', endedAt: now } : old,
    )
  }
  return next.filter(a => a.endedAt === undefined || now - a.endedAt < ENDED_SHOWN_MS)
}

const pending = (list: Job[], now: number) =>
  list.filter(j => j.recurring || j.nextFireAt === undefined || j.nextFireAt > now - 5000)

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`
}
const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const splitPath = (path: string, cwd: string) => {
  const rel = cwd !== '' && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, cut + 1), name: rel.slice(cut + 1) }
}

const AGENT_LOOK: Record<string, { mark: string; color: string; label: string }> = {
  pending: { mark: '○', color: 'inactive', label: 'starting' },
  running: { mark: '', color: 'claude', label: 'running' },
  waiting: { mark: '◌', color: 'warning', label: 'waiting' },
  idle: { mark: '◌', color: 'subtle', label: 'idle' },
  completed: { mark: '✓', color: 'success', label: 'done' },
  failed: { mark: '✗', color: 'error', label: 'failed' },
  killed: { mark: '■', color: 'inactive', label: 'stopped' },
}

// ---------- the mod ----------

export const register: Register = (on, options) => {
  let cwd = ''
  let sessionId = ''
  const ttlMs = options.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000
  // Cost and context size when the current main-loop turn began.
  let turnStartUsd: number | undefined
  let mainContext: number | undefined

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    sessionId = await $.session.id()
    const usage = await $.session.usage({ breakdown: 'summary' })
    await update($, meter, () => toMeter(usage))
    if (usage.context.breakdown !== undefined) {
      const b = toBreakdown(usage.context.breakdown)
      await update($, breakdown, () => b)
    }
    await $.command.register({
      name: 'session-pane',
      description: 'Open the pane of changed files, subagents and scheduled tasks',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    $.clock.every(1000, async () => {
      const now = await $.clock.now()
      const before = await read($, agents)
      const merged = mergeAgents(before, await $.agent.list(), now)
      if (JSON.stringify(before) !== JSON.stringify(merged)) {
        await update($, agents, () => merged)
      }
      const list = await read($, jobs)
      if (pending(list, now).length !== list.length) {
        await update($, jobs, l => pending(l, now))
      }
      // Keep the clocks (elapsed time, countdowns) moving while anything is live.
      const isLive = merged.some(a => a.endedAt === undefined) || list.length > 0
      const isMinute = Math.floor(now / 1000) % 30 === 0
      if (isLive || isMinute) $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('command.run', { command: 'session-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Session pane opened.' }
  }).catch(() => ({ text: 'Could not open the session pane.' }))

  // ----- overhead: requests, turns, measurements, compactions -----

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const u = step.usage
    if (u === null) return step

    const now = await $.clock.now()
    const effort = e.effort === undefined ? undefined : String(e.effort)
    if (e.agentId === undefined) {
      mainContext = requestSize(u)
      await update($, main, t => addTokens(t, u))
      await update($, modelInfo, () => ({ model: u.model || e.model, effort }))
      await update($, lastRequestAt, () => now)
    } else {
      const id = e.agentId
      await update($, agentTokens, all => {
        const old = all[id]
        return {
          ...all,
          [id]: {
            model: u.model || e.model,
            effort,
            tokens: addTokens(old?.tokens ?? NO_TOKENS, u),
            inputs: [...(old?.inputs ?? []), requestSize(u)].slice(-12),
          },
        }
      })
    }
    return step
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await update($, meter, () => toMeter(e))
    return measured
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    turnStartUsd = (await read($, meter))?.usd
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const usage = await $.session.usage({ breakdown: 'summary' })
    const after = toMeter(usage)
    await update($, meter, () => after)
    if (usage.context.breakdown !== undefined) {
      const b = toBreakdown(usage.context.breakdown)
      await update($, breakdown, () => b)
    }
    if (turnStartUsd !== undefined && after.usd !== undefined) {
      const spent = after.usd - turnStartUsd
      await update($, lastTurnUsd, () => spent)
    }
    turnStartUsd = after.usd
    const size = mainContext ?? after.tokens
    if (size !== undefined) {
      await update($, growth, g => ({
        last: size,
        deltas: g.last === undefined ? g.deltas : [...g.deltas, size - g.last].slice(-200),
      }))
    }
    return done
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.skip === undefined) {
      const { tokensBefore, tokensAfter } = result
      if (tokensBefore !== undefined && tokensAfter !== undefined) {
        await update($, compactions, list => [...list, { before: tokensBefore, after: tokensAfter }])
        // The next turn's growth counts from the compacted size.
        await update($, growth, g => ({ ...g, last: tokensAfter }))
        mainContext = tokensAfter
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // ----- files -----

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result !== undefined) {
      const stat = diffStat(ran.result.structuredPatch)
      await update($, files, addFile(e.file_path, false, stat, await $.clock.now()))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result !== undefined) {
      const r = ran.result
      const stat =
        r.type === 'create'
          ? { added: e.content.split('\n').length, removed: 0 }
          : diffStat(r.structuredPatch)
      await update($, files, addFile(e.file_path, r.type === 'create', stat, await $.clock.now()))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const stat = { added: 0, removed: 0 }
      await update($, files, addFile(e.notebook_path, false, stat, await $.clock.now()))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ----- subagents: show a new one at once, not at the next poll -----

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const now = await $.clock.now()
    const live = await $.agent.list()
    await update($, agents, prev => mergeAgents(prev, live, now))
    return spawned
  }).catch(($, e, next) => next(e))

  // ----- scheduled tasks -----

  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result !== undefined) {
      const r = ran.result
      const job: Job = {
        id: r.id,
        kind: 'cron',
        schedule: r.humanSchedule || e.cron,
        prompt: e.prompt,
        recurring: r.recurring,
        nextFireAt: r.nextFireAt,
      }
      await update($, jobs, list => [...list.filter(j => j.id !== job.id), job])
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, jobs, list => list.filter(j => j.id !== e.id))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'CronList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result !== undefined) {
      const crons: Job[] = ran.result.jobs.map(j => ({
        id: j.id,
        kind: 'cron',
        schedule: j.humanSchedule || j.cron,
        prompt: j.prompt,
        recurring: j.recurring ?? true,
        nextFireAt: j.nextFireAt,
      }))
      await update($, jobs, list => [...crons, ...list.filter(j => j.kind === 'wakeup')])
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result !== undefined) {
      const r = ran.result
      const crons = (list: Job[]) => list.filter(j => j.kind !== 'wakeup')
      if (r.stopped === true) {
        await update($, jobs, crons)
      } else {
        const wakeup: Job = {
          id: `wakeup-${r.scheduledFor}`,
          kind: 'wakeup',
          schedule: '/loop wake-up',
          prompt: e.prompt ?? '',
          recurring: false,
          nextFireAt: r.scheduledFor,
        }
        await update($, jobs, list => [...crons(list), wakeup])
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ----- drawing -----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const height = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const now = await $.clock.now()
    const fileList = await read($, files)
    const agentList = await read($, agents)
    const jobList = await read($, jobs)
    const viewedAgent = e.props.view?.agentId
    const currentTab: Tab = await read($, tab)

    const tabs = (
      <Box flexDirection="row" gap={2}>
        {(['activity', 'overhead'] as const).map((id, i) => (
          <Button
            key={`tab-${id}`}
            plain
            hotkey={String(i + 1)}
            dimColor={currentTab !== id}
            onPress={() => void update($, tab, () => id)}
          >
            <Text bold={currentTab === id} underline={currentTab === id}>
              {id === 'activity' ? 'Activity' : 'Overhead'}
            </Text>
          </Button>
        ))}
      </Box>
    )

    if (currentTab === 'overhead') {
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <OverheadView
            el={$.ui.resolve(e)}
            now={now}
            width={width}
            data={{
              sessionId,
              meter: await read($, meter),
              breakdown: await read($, breakdown),
              main: await read($, main),
              modelInfo: await read($, modelInfo),
              agentTokens: await read($, agentTokens),
              agents: agentList,
              growth: await read($, growth),
              compactions: await read($, compactions),
              lastRequestAt: await read($, lastRequestAt),
              lastTurnUsd: await read($, lastTurnUsd),
              ttlMs,
            }}
          />
        </Box>
      )
    }

    const active = agentList.filter(a => a.endedAt === undefined)
    const ended = agentList
      .filter(a => a.endedAt !== undefined)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, ENDED_SHOWN_MAX)
    const totalAdded = fileList.reduce((n, f) => n + f.added, 0)
    const totalRemoved = fileList.reduce((n, f) => n + f.removed, 0)

    // Rows left for files once the other sections have theirs.
    const fixedRows = 6 + (active.length + ended.length) * 2 + jobList.length * 2 + 8
    const fileRoom = Math.max(4, height - fixedRows)
    const shownFiles = [...fileList].sort((a, b) => b.at - a.at).slice(0, fileRoom)

    const Header = (props: { label: string; count: string; color: string }) => {
      const rule = Math.max(2, width - props.label.length - props.count.length - 3)
      return (
        <Box marginTop={1}>
          <Text>
            <Text bold color={props.color}>
              {props.label}
            </Text>
            <Text color="subtle"> {'─'.repeat(rule)} </Text>
            <Text dimColor>{props.count}</Text>
          </Text>
        </Box>
      )
    }

    const Empty = (props: { text: string }) => (
      <Box paddingLeft={2}>
        <Text dimColor italic>
          {props.text}
        </Text>
      </Box>
    )

    // ----- summary -----
    const summary = (
      <Box flexDirection="column">
        <Text>
          <Text bold>{fileList.length}</Text>
          <Text dimColor> files </Text>
          <Text color="diffAdded">+{totalAdded}</Text>
          <Text> </Text>
          <Text color="diffRemoved">−{totalRemoved}</Text>
          <Text dimColor>  ·  </Text>
          <Text bold color={active.length > 0 ? 'claude' : undefined}>
            {active.length}
          </Text>
          <Text dimColor> agents  ·  </Text>
          <Text bold color={jobList.length > 0 ? 'suggestion' : undefined}>
            {jobList.length}
          </Text>
          <Text dimColor> scheduled</Text>
        </Text>
        {viewedAgent !== undefined && (
          <Box marginTop={1}>
            <Button key="back-to-main" onPress={() => void $.ui.view({})}>
              ← Back to main conversation
            </Button>
          </Box>
        )}
      </Box>
    )

    // ----- files -----
    const fileRows = shownFiles.map(f => {
      const { dir, name } = splitPath(f.path, cwd)
      return (
        <Box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="truncate-end">
              <Text bold color={f.isNew ? 'success' : 'warning'}>
                {f.isNew ? 'A ' : 'M '}
              </Text>
              <Text>{name}</Text>
              <Text dimColor> {dir}</Text>
            </Text>
          </Box>
          <Box flexShrink={0} paddingLeft={1}>
            <Text>
              {f.added > 0 && <Text color="diffAdded">+{f.added}</Text>}
              {f.added > 0 && f.removed > 0 && <Text> </Text>}
              {f.removed > 0 && <Text color="diffRemoved">−{f.removed}</Text>}
              {f.edits > 1 && <Text dimColor> ×{f.edits}</Text>}
              <Text dimColor> {ago(now - f.at).padStart(3)}</Text>
            </Text>
          </Box>
        </Box>
      )
    })

    // ----- agents -----
    const agentRow = (a: AgentRow) => {
      const look = AGENT_LOOK[a.status] ?? AGENT_LOOK.running!
      const isEnded = a.endedAt !== undefined
      const mark = a.status === 'running' ? SPINNER[Math.floor(now / 500) % 4]! : look.mark
      const time = isEnded
        ? `${duration((a.endedAt ?? now) - a.startedAt)} · ${ago(now - (a.endedAt ?? now))} ago`
        : duration(now - a.startedAt)
      const isViewed = viewedAgent === a.id
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1}>
              <Button
                key={`agent-${a.id}`}
                plain
                dimColor={isEnded}
                onPress={() => void $.ui.view({ agentId: a.id })}
              >
                <Text color={look.color}>{mark} </Text>
                <Text bold={!isEnded} inverse={isViewed}>
                  {a.type}
                </Text>
              </Button>
            </Box>
            <Box flexShrink={0} paddingLeft={1}>
              <Text>
                <Text color={look.color} dimColor={isEnded}>
                  {look.label}
                </Text>
                <Text dimColor> {time}</Text>
              </Text>
            </Box>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {oneLine(a.description) || '—'}
            </Text>
          </Box>
        </Box>
      )
    }

    // ----- scheduled -----
    const jobRow = (j: Job) => {
      const until = j.nextFireAt !== undefined ? j.nextFireAt - now : undefined
      const when =
        !j.recurring && until !== undefined
          ? until > 0
            ? `in ${duration(until)} · ${clockTime(j.nextFireAt!)}`
            : 'firing…'
          : 'recurring'
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color="suggestion">{j.kind === 'wakeup' ? '⏱ ' : '↻ '}</Text>
                <Text bold>{j.schedule}</Text>
              </Text>
            </Box>
            <Box flexShrink={0} paddingLeft={1}>
              <Text dimColor>{when}</Text>
            </Box>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {j.kind === 'cron' ? `${j.id} · ` : ''}
              {oneLine(j.prompt) || '—'}
            </Text>
          </Box>
        </Box>
      )
    }

    const isEmpty = fileList.length === 0 && agentList.length === 0 && jobList.length === 0
    if (isEmpty) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>Nothing yet</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>This pane follows the session as it works:</Text>
            <Text>
              <Text color="warning">  M </Text>
              <Text dimColor>files Claude edits or creates</Text>
            </Text>
            <Text>
              <Text color="claude">  ◐ </Text>
              <Text dimColor>subagents while they run</Text>
            </Text>
            <Text>
              <Text color="suggestion">  ↻ </Text>
              <Text dimColor>scheduled tasks and /loop wake-ups</Text>
            </Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs}
        <Box marginTop={1}>{summary}</Box>

        <Header label="FILES" count={String(fileList.length)} color="text" />
        {fileList.length === 0 ? <Empty text="no changes yet" /> : fileRows}
        {fileList.length > shownFiles.length && (
          <Empty text={`… ${fileList.length - shownFiles.length} older`} />
        )}

        <Header
          label="AGENTS"
          count={ended.length > 0 ? `${active.length} live · ${ended.length} done` : String(active.length)}
          color="claude"
        />
        {agentList.length === 0 ? (
          <Empty text="none running" />
        ) : (
          [...active, ...ended].map(agentRow)
        )}
        {active.length > 0 && <Empty text="press a name to open its transcript" />}

        <Header label="SCHEDULED" count={String(jobList.length)} color="suggestion" />
        {jobList.length === 0 ? <Empty text="nothing scheduled" /> : jobList.map(jobRow)}
      </Box>
    )
  })
}
