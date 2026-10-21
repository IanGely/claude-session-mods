import { expect, test } from 'claude-code/testing'

const NOW = 1_700_000_000_000
const usage = (tokens: number, usd: number) => ({
  value: {
    startedAt: NOW,
    context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 154 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 63, resetsAt: new Date(NOW + 55 * 3_600_000).toISOString() },
    ],
    cost: { usd },
  },
})

const band = (bodyColumns: number) =>
  ({
    plugin: 'ctx-band',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns, scroll: { offset: 0, bodyRows: 3 } },
  }) as never

test('the band shows context, growth, cache, limits and cost', async ($, on) => {
  let tokens = 267_600
  let usd = 1.72
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usage(tokens, usd))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ ...usage(tokens, usd).value, changed: ['context'] } as never)
  await $.prompt.submit({ text: 'hi' } as never)
  tokens = 271_000
  usd = 1.84
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)

  const wide = await $.ui.mount(band(160))
  const line = (await wide.find({ type: 'Text', text: /ctx/ }))?.text ?? ''
  expect(line).toContain('27% 271k/1M')
  expect(line).toContain('271k/1M  █ ↑3.4k')
  expect(line).toContain('cache warm 1h00m')
  expect(line).toContain('5h 42% ↻2h34m')
  expect(line).toContain('7d 63% ↻2d7h')
  expect(line).toContain('cost ≈$1.84 (+$0.12)')
  await wide.unmount()

  const narrow = await $.ui.mount(band(50))
  const short = (await narrow.find({ type: 'Text', text: /ctx/ }))?.text ?? ''
  expect(short).toContain('27%')
  expect(short).not.toContain('cost')
  await narrow.unmount()
})
