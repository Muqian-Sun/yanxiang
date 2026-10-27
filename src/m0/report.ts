/**
 * Render a run's per-call logs into one readable 日志.md.
 * Usage: bun src/m0/report.ts runs/<dir> [--watch]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type Attempt = { response: string; problems: string[]; tokensIn: number; tokensOut: number; ms: number }
type Log = { task: string; tag: string; model: string; promptVersion: string; system: string; user: string; attempts: Attempt[]; output: unknown }

const dir = resolve(process.argv[2] ?? '')
const logs = join(dir, 'logs')
if (!existsSync(logs)) throw new Error(`没有日志目录：${logs}`)

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`
const sections = (user: string) =>
  user.split(/\n(?=【)/).map(part => {
    const title = part.match(/^【(.+?)】/)?.[1] ?? '（无标题）'
    return `${title} ${part.replace(/^【.+?】\n?/, '').length} 字`
  })

function render(): string {
  const files = readdirSync(logs)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ name, at: statSync(join(logs, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at)
  const entries = files.map(f => ({ ...(JSON.parse(readFileSync(join(logs, f.name), 'utf8')) as Log), at: new Date(f.at) }))
  const progress = existsSync(`${dir}.log`) ? readFileSync(`${dir}.log`, 'utf8').trim() : ''

  const out: string[] = [`# 运行日志：${dir.split('/').pop()}`, '', `更新时间：${new Date().toLocaleString('zh-CN')}；已完成 ${entries.length} 次调用。`, '']
  const tin = entries.reduce((s, e) => s + e.attempts.reduce((t, a) => t + a.tokensIn, 0), 0)
  const tout = entries.reduce((s, e) => s + e.attempts.reduce((t, a) => t + a.tokensOut, 0), 0)
  const ms = entries.reduce((s, e) => s + e.attempts.reduce((t, a) => t + a.ms, 0), 0)
  out.push(`合计：输入 ${tin} token，输出 ${tout} token，模型耗时 ${sec(ms)}。`, '')

  out.push('## 总览', '', '| # | 完成时间 | 调用 | 尝试 | 输入 token | 输出 token | 耗时 | 结果 |', '|---|---|---|---|---|---|---|---|')
  entries.forEach((e, i) => {
    const last = e.attempts.at(-1)!
    const result = e.output === null ? `失败：${last.problems.join('；')}` : e.attempts.length > 1 ? `重写后通过（打回原因：${e.attempts.slice(0, -1).map(a => a.problems.join('；')).join(' → ')}）` : '一次通过'
    out.push(`| ${i + 1} | ${e.at.toLocaleTimeString('zh-CN')} | [${e.tag}](#${e.tag}) | ${e.attempts.length} | ${e.attempts.reduce((t, a) => t + a.tokensIn, 0)} | ${e.attempts.reduce((t, a) => t + a.tokensOut, 0)} | ${sec(e.attempts.reduce((t, a) => t + a.ms, 0))} | ${result} |`)
  })
  out.push('', '## 进度输出', '', '```text', progress || '（无）', '```', '')

  for (const e of entries) {
    out.push(`## ${e.tag}`, '')
    out.push(`- 任务：\`${e.task}\`；模型：${e.model}；提示词版本：${e.promptVersion}`)
    out.push(`- 系统提示词 ${e.system.length} 字；用户消息 ${e.user.length} 字（${sections(e.user).join('，')}）`, '')
    out.push('<details><summary>系统提示词</summary>', '', '```text', e.system, '```', '', '</details>', '')
    out.push('**用户消息**', '', '```text', e.user, '```', '')
    e.attempts.forEach((a, k) => {
      out.push(`**第 ${k + 1} 次尝试**：输入 ${a.tokensIn} token，输出 ${a.tokensOut} token，${sec(a.ms)}，${a.problems.length ? `被打回：${a.problems.join('；')}` : '通过检查'}`, '')
      out.push('```text', a.response, '```', '')
    })
  }
  return out.join('\n')
}

const write = () => writeFileSync(join(dir, '日志.md'), render())
write()
console.log(`已写入 ${join(dir, '日志.md')}`)
if (process.argv.includes('--watch')) setInterval(write, 10_000)
