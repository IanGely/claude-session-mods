# claude-session-mods

Two Claude Code mods that keep an eye on your session.

## session-dashboard

A side pane with two tabs (switch with `1` / `2`, or open it with `/session-pane`):

- **Activity** — files changed this session (new vs. modified, `+added −removed`, edit count, age), subagents while they run (live timer, status; press one to open its transcript), and scheduled tasks (`CronCreate`, `/loop` wake-ups) with countdowns.
- **Overhead** — context window fill and auto-compact headroom, the window broken down as `/context` estimates it, per-turn context growth, main-conversation tokens and cache hit rate, 5h / 7d quota with a window-average projection, cost, and per-subagent token use.

## ctx-band

One line above the prompt:

```
ctx ■■■□□□□□□□ 27% 271k/1M  ▁▁▃█▁▇▁ ↑3.4k │ cache warm 38m │ 5h 42% ↻2h34m │ 7d 63% ↻2d7h │ cost ≈$1.84 (+$0.12)
```

On a narrow terminal the lower-priority segments drop first; the context bar always stays.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-dashboard --marketplace IanGely/claude-session-mods
/plugin install ctx-band --marketplace IanGely/claude-session-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install session-dashboard --marketplace IanGely/claude-session-mods
claude plugin install ctx-band --marketplace IanGely/claude-session-mods
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `IanGely/claude-session-mods`, then **Add plugin**.

## Options

Both mods have a **Prompt cache TTL** option (`1h` default, or `5m`) in `/config`. The "cache warm" countdown is estimated from the time of the last request plus this TTL.

## Notes

- Token, cache and growth figures count the requests seen after the mod loaded.
- Quota shows only on a Claude subscription; the projection assumes the window's average rate continues.
- Cost is an API-price reference, not a billing receipt.

## License

MIT
