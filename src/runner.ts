import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { complete, resolve, type ModelsConfig } from './llm.js'
import type { Plugin } from './plugins.js'
import { assemble, userMessage } from './prompt.js'
import type { Card, Problems } from './tasks.js'

export type Section = { title: string; body: string }

export type RunOptions = {
  root: string
  card: Card
  sections: Section[]
  data?: unknown
  plugins: { style: Plugin; genre: Plugin }
  models: ModelsConfig
  logDir: string
  tag: string
  /** Pictures (file paths) shown to the model before the text, for a vision task. */
  images?: string[]
  /** Called with one human-readable line at each step of the call. */
  onEvent?: (line: string) => void
}

export type Attempt = { response: string; problems: Problems; tokensIn: number; tokensOut: number; ms: number }

export type RunResult<T = unknown> = { output: T; raw: string; attempts: Attempt[]; system: string; user: string; promptVersion: string; model: string }

export class TaskFailed extends Error {
  constructor(message: string, readonly attempts: Attempt[], readonly call: { system: string; user: string; promptVersion: string; model: string }) {
    super(message)
  }
}

/** Rewrites after a failed check; a guess, to be revisited once M0 shows how often checks fail. */
const REWRITES = 2

function parse(card: Card, text: string): { value: unknown; problems: Problems } {
  if (card.output === 'text') return { value: text.trim(), problems: text.trim() ? [] : ['输出是空的'] }
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { value: null, problems: ['输出不是合法的 JSON'] }
  }
  const parsed = card.schema!.safeParse(json)
  if (!parsed.success) return { value: null, problems: parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || '根'}：${issue.message}`) }
  return { value: parsed.data, problems: [] }
}

export async function runTask<T = unknown>(options: RunOptions): Promise<RunResult<T>> {
  const { card, root } = options
  const template = readFileSync(join(root, 'config/prompts/tasks', `${card.name}.md`), 'utf8')
  const { text: system, version } = assemble(template, options.plugins)
  const user = userMessage(options.sections)
  const target = resolve(options.models, card.name)
  const attempts: Attempt[] = []
  const say = options.onEvent ?? (() => {})
  const parts = options.sections.filter(s => s.body.trim()).map(s => `${s.title} ${s.body.trim().length} 字`).join('，')
  say(`▶ ${options.tag} 开始｜任务 ${card.name}｜模型 ${target.model}｜提示词 ${version}｜系统提示词 ${system.length} 字｜用户消息 ${user.length} 字（${parts}）`)
  const images = (options.images ?? []).map(path => ({ mime: path.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: readFileSync(path).toString('base64') }))
  let message = user
  for (let attempt = 0; attempt <= REWRITES; attempt++) {
    const reply = await complete(target, system, message, { maxTokens: card.maxTokens ?? 8000, images })
    const { value, problems: parseProblems } = parse(card, reply.text)
    const problems = parseProblems.length ? parseProblems : (card.checks?.(value as never, options.data as never) ?? [])
    attempts.push({ response: reply.text, problems, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut, ms: reply.ms })
    say(`  ${options.tag} 第 ${attempt + 1} 次｜输入 ${reply.tokensIn} token｜输出 ${reply.tokensOut} token｜${(reply.ms / 1000).toFixed(1)} 秒｜${problems.length ? `打回：${problems.join('；')}` : '通过检查'}`)
    if (!problems.length) {
      const result = { output: value as T, raw: reply.text, attempts, system, user, promptVersion: version, model: target.model }
      log(options, result)
      return result
    }
    message = `${user}\n\n【上次输出的问题】\n${problems.map(p => `- ${p}`).join('\n')}\n请按要求重写，只输出要求的内容。`
  }
  log(options, { output: null, raw: '', attempts, system, user, promptVersion: version, model: target.model })
  throw new TaskFailed(`${card.name}（${options.tag}）重写 ${REWRITES} 次仍未通过：${attempts.at(-1)!.problems.join('；')}`, attempts, { system, user, promptVersion: version, model: target.model })
}

function log(options: RunOptions, result: RunResult): void {
  mkdirSync(options.logDir, { recursive: true })
  writeFileSync(join(options.logDir, `${options.tag}.json`), JSON.stringify({ task: options.card.name, tag: options.tag, ...result }, null, 2))
}
