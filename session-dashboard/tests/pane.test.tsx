import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-dashboard',
  component: 'Pane',
  requestId: 'session-dashboard',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }]

test('the pane shows diff stats, live subagents and scheduled tasks', async ($, on) => {
  on('command.register', () => ({ value: { command: 'session-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'Explore', description: 'find routes', status: 'running' }],
  }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: 1_700_000_000_000,
      context: {
        tokens: 271_000,
        window: 1_000_000,
        percent: 27,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 235_700, color: 'success', kind: 'used' },
            { name: 'MCP tools', tokens: 5_900, color: 'suggestion', kind: 'used' },
            { name: 'Free space', tokens: 100_000, color: 'subtle', kind: 'free' },
            { name: 'MCP tools (deferred)', tokens: 28_200, color: 'subtle', kind: 'deferred' },
          ],
          mcpTools: [
            { name: 'a', serverName: 'tracker', tokens: 4_100, isLoaded: true },
            { name: 'b', serverName: 'notes', tokens: 1_800, isLoaded: true },
          ],
          totalTokens: 271_000,
          rawMaxTokens: 400_000,
          autoCompactThreshold: 367_000,
        },
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(1_700_000_000_000 + 154 * 60_000).toISOString() },
      ],
      cost: { usd: 1.84 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'x' }))
  on('tool.call', { tool: 'Edit' }, () => ({
    result: { structuredPatch: patch(['+a', '+b', '-c', ' d']) },
  }))
  on('tool.call', { tool: 'CronCreate' }, () => ({
    result: { id: 'job1', humanSchedule: 'every 5 minutes', recurring: true },
  }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'b', new_string: 'c' })
  await $.agent.spawn({ prompt: 'look', description: 'find routes', subagentType: 'Explore' } as never)
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'check CI' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /app\.ts/ }))?.text).toContain('src/')
  expect((await ui.find({ type: 'Text', text: /\+4/ }))?.text).toContain('−2')
  expect((await ui.find({ type: 'Text', text: /×2/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /find routes/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /every 5 minutes/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /job1 · check CI/ }))).toBeDefined()
  await ui.unmount()
})

test('an empty session shows the guide', async ($, on) => {
  on('command.register', () => ({ value: { command: 'session-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: 1_700_000_000_000,
      context: {
        tokens: 271_000,
        window: 1_000_000,
        percent: 27,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 235_700, color: 'success', kind: 'used' },
            { name: 'MCP tools', tokens: 5_900, color: 'suggestion', kind: 'used' },
            { name: 'Free space', tokens: 100_000, color: 'subtle', kind: 'free' },
            { name: 'MCP tools (deferred)', tokens: 28_200, color: 'subtle', kind: 'deferred' },
          ],
          mcpTools: [
            { name: 'a', serverName: 'tracker', tokens: 4_100, isLoaded: true },
            { name: 'b', serverName: 'notes', tokens: 1_800, isLoaded: true },
          ],
          totalTokens: 271_000,
          rawMaxTokens: 400_000,
          autoCompactThreshold: 367_000,
        },
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(1_700_000_000_000 + 154 * 60_000).toISOString() },
      ],
      cost: { usd: 1.84 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nothing yet/ }))).toBeDefined()
  await ui.unmount()
})

test('the overhead tab shows context, breakdown, quota and cost', async ($, on) => {
  on('command.register', () => ({ value: { command: 'session-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: 1_700_000_000_000,
      context: {
        tokens: 271_000,
        window: 1_000_000,
        percent: 27,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 235_700, color: 'success', kind: 'used' },
            { name: 'MCP tools', tokens: 5_900, color: 'suggestion', kind: 'used' },
            { name: 'Free space', tokens: 100_000, color: 'subtle', kind: 'free' },
            { name: 'MCP tools (deferred)', tokens: 28_200, color: 'subtle', kind: 'deferred' },
          ],
          mcpTools: [
            { name: 'a', serverName: 'tracker', tokens: 4_100, isLoaded: true },
            { name: 'b', serverName: 'notes', tokens: 1_800, isLoaded: true },
          ],
          totalTokens: 271_000,
          rawMaxTokens: 400_000,
          autoCompactThreshold: 367_000,
        },
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(1_700_000_000_000 + 154 * 60_000).toISOString() },
      ],
      cost: { usd: 1.84 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-overhead' })
  const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text ?? ''
  expect(await text(/271k of 400k/)).toContain('68%')
  expect(await text(/at 367k/)).toContain('96k to go')
  expect(await text(/sess-1/)).toContain('sess-1')
  expect(await text(/Messages/)).toContain('235.7k')
  expect(await text(/tracker/)).toContain('4.1k')
  expect(await text(/deferred tool schemas/)).toContain('28.2k')
  expect(await text(/42%/)).toContain('↻2h34m')
  expect(await text(/by reset/)).toContain('reset comes first')
  expect(await text(/≈\$1\.84/)).toContain('1.84')
  await ui.unmount()
})
