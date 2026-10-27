import { z } from 'zod'

export type Problems = string[]

export type Card = {
  /** File name under config/prompts/tasks, without .md. */
  name: string
  output: 'json' | 'text'
  schema?: z.ZodType
  /** Deterministic checks on the parsed output; `data` is what the caller knows about the input. */
  checks?: (out: never, data: never) => Problems
  maxTokens?: number
}

/** Words that belong to the parts the program writes; a writer's paragraph must not contain them. */
const STYLE_WORDS = ['画风', '渲染', '风格']
/** 「镜头」 is left out: a portrait must say the figure faces the camera (正面朝镜头). */
const FRAME_WORDS = ['背景', '构图', '机位', '景深', '景别', '远景', '近景', '特写']
const LIGHT_WORDS = ['打光', '布光', '光线', '光照', '灯光', '逆光', '侧光', '顶光', '补光']

function boundary(words: string[]) {
  return (out: string): Problems => {
    const hit = words.filter(word => out.includes(word))
    return hit.length ? [`正文里出现了由程序负责的内容：${hit.join('、')}。这些不要写`] : []
  }
}

function lineList(required: string[]) {
  return (out: string): Problems => {
    const lines = out.split('\n').map(line => line.trim()).filter(Boolean)
    const problems: Problems = []
    const bad = lines.filter(line => !/^[^：:]{1,20}[：:].+/.test(line))
    if (bad.length) problems.push(`这些行不是「项：要点」的格式：${bad.slice(0, 3).join(' / ')}`)
    for (const key of required) if (!lines.some(line => line.startsWith(`${key}：`) || line.startsWith(`${key}:`))) problems.push(`缺少「${key}：」这一行`)
    return problems
  }
}

const Direction = z.object({ title: z.string().min(1), logline: z.string().min(1), strategy: z.string().min(1), opposition: z.string().min(1), cost: z.string().min(1), payoff: z.string().min(1), opening: z.string().min(1) })
const Line = z.object({ speaker: z.string().min(1), text: z.string().min(1) })
const Beat = z.object({ id: z.string().min(1), action: z.string(), lines: z.array(Line), seconds: z.number().int().positive(), changes: z.array(z.string()) })
export const Script = z.object({
  scenes: z.array(z.object({ id: z.string(), location: z.string().min(1), beats: z.array(Beat).min(1) })).min(1),
  roster: z.object({
    characters: z.array(z.object({ name: z.string().min(1), gender: z.string(), age_look: z.string(), rank: z.string(), tier: z.string(), needs: z.string(), temperament: z.string(), appearance_lines: z.array(z.string()) })).min(1),
    locations: z.array(z.object({ name: z.string().min(1), beats: z.array(z.string()) })).min(1),
    props: z.array(z.object({ name: z.string().min(1), holder: z.string(), beats: z.array(z.string()) })),
  }),
})
export type ScriptT = z.infer<typeof Script>
export const Plan = z.object({
  segments: z.array(z.object({ id: z.string(), beats: z.array(z.string()).min(1), seconds: z.number().int().min(4).max(15), location: z.string(), continues: z.boolean(), summary: z.string().min(1) })).min(1),
  overflow: z.array(z.string()),
})
export type PlanT = z.infer<typeof Plan>
export const Timeline = z.object({
  seconds: z.number().int(),
  cuts: z.array(z.object({ index: z.number().int(), start: z.number(), end: z.number(), camera: z.string().min(1), shot: z.string().min(1), present: z.object({ characters: z.array(z.string()), props: z.array(z.string()), view: z.string().min(1) }) })).min(1),
  timeline: z.array(z.object({ second: z.number().int(), text: z.string().min(1), changes: z.array(z.string()) })),
  lines: z.array(z.object({ speaker: z.string(), text: z.string(), start: z.number(), end: z.number() })),
  ambience: z.string(),
})
export type TimelineT = z.infer<typeof Timeline>
export const MAIN_VIEW = '主视角'
export const ViewGroups = z.object({
  views: z.array(z.object({ name: z.string().min(1).max(12), camera: z.string(), cuts: z.array(z.string()).min(1) })).min(1),
})
export type ViewGroupsT = z.infer<typeof ViewGroups>

export const Trim = z.object({ in: z.number().min(0), out: z.number().positive(), reason: z.string().min(1) })
export type TrimT = z.infer<typeof Trim>
export const AssistantAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revise'), target: z.string().min(1), instruction: z.string().min(1), confirm: z.string().min(1) }),
  z.object({ kind: z.literal('redo'), target: z.string().min(1), confirm: z.string().min(1) }),
  z.object({ kind: z.literal('approve'), target: z.string().min(1) }),
  z.object({ kind: z.literal('ask'), question: z.string().min(1) }),
  z.object({ kind: z.literal('explain'), text: z.string().min(1) }),
])
export type AssistantActionT = z.infer<typeof AssistantAction>

export type ScriptData = { min: number; max: number }
export type PlanData = { beats: string[]; lines: string[]; min: number; max: number; locations: string[] }
export type ViewGroupsData = { cuts: string[] }
export type TimelineData = { seconds: number; lines: { speaker: string; text: string }[] }
/** The trim is clamped to the allowed range by the editor (design 08); only an impossible answer is sent back. */
export type TrimData = { seconds: number }
/** Artifacts on the page and their upstream: the only things the assistant may act on. */
export type AssistantData = { targets: string[] }

const card = <Out, Data>(c: Omit<Card, 'checks'> & { checks?: (out: Out, data: Data) => Problems }): Card => c as Card

export const CARDS: Record<string, Card> = {
  'story-directions': card<{ directions: unknown[] }, unknown>({
    name: 'story-directions', output: 'json', schema: z.object({ directions: z.array(Direction) }),
    checks: out => (out.directions.length === 3 ? [] : [`方向要恰好 3 个，现在是 ${out.directions.length} 个`]),
  }),
  script: card<ScriptT, ScriptData>({
    name: 'script', output: 'json', schema: Script, maxTokens: 16000,
    checks: (out, data) => {
      const problems: Problems = []
      const beats = out.scenes.flatMap(scene => scene.beats)
      const total = beats.reduce((sum, beat) => sum + beat.seconds, 0)
      if (total < data.min || total > data.max) problems.push(`总时长 ${total} 秒，要在 ${data.min}–${data.max} 秒之间`)
      const ids = beats.map(beat => beat.id)
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
      if (dup.length) problems.push(`拍的 id 重复：${[...new Set(dup)].join('、')}`)
      const names = new Set(out.roster.characters.map(c => c.name))
      const strangers = [...new Set(beats.flatMap(beat => beat.lines.map(line => line.speaker)).filter(name => !names.has(name)))]
      if (strangers.length) problems.push(`这些说话人不在人物清单里：${strangers.join('、')}`)
      return problems
    },
  }),
  'character-design': card<string, unknown>({ name: 'character-design', output: 'text', checks: lineList(['主色', '区分']) }),
  'location-design': card<string, unknown>({ name: 'location-design', output: 'text', checks: lineList(['陈设']) }),
  'prop-design': card<string, unknown>({ name: 'prop-design', output: 'text', checks: lineList([]) }),
  'portrait-desc': card<string, unknown>({ name: 'portrait-desc', output: 'text', checks: boundary([...STYLE_WORDS, ...FRAME_WORDS, ...LIGHT_WORDS]) }),
  'location-desc': card<string, unknown>({ name: 'location-desc', output: 'text', checks: boundary([...STYLE_WORDS, '构图', '机位', '镜头']) }),
  'prop-desc': card<string, unknown>({ name: 'prop-desc', output: 'text', checks: boundary([...STYLE_WORDS, ...FRAME_WORDS, ...LIGHT_WORDS]) }),
  'location-view-desc': card<string, unknown>({ name: 'location-view-desc', output: 'text', checks: boundary(STYLE_WORDS) }),
  'segment-plan': card<PlanT, PlanData>({
    name: 'segment-plan', output: 'json', schema: Plan,
    checks: (out, data) => {
      const problems: Problems = []
      const placed = out.segments.flatMap(segment => segment.beats)
      const missing = data.beats.filter(id => !placed.includes(id) && !out.overflow.includes(id))
      if (missing.length) problems.push(`这些拍没有落进任何一段：${missing.join('、')}`)
      const twice = placed.filter((id, i) => placed.indexOf(id) !== i)
      if (twice.length) problems.push(`这些拍落进了不止一段：${[...new Set(twice)].join('、')}`)
      const unknown = placed.filter(id => !data.beats.includes(id))
      if (unknown.length) problems.push(`剧本里没有这些拍：${unknown.join('、')}`)
      const total = out.segments.reduce((sum, segment) => sum + segment.seconds, 0)
      if (total > data.max * 1.2) problems.push(`总时长 ${total} 秒，超出上限两成以上，要把末尾的拍放进 overflow`)
      const strange = [...new Set(out.segments.map(segment => segment.location).filter(location => !data.locations.includes(location)))]
      if (strange.length) problems.push(`这些地点不在出场清单里：${strange.join('、')}；location 只能写清单里的地点名：${data.locations.join('、')}`)
      return problems
    },
  }),
  'view-groups': card<ViewGroupsT, ViewGroupsData>({
    name: 'view-groups', output: 'json', schema: ViewGroups,
    checks: (out, data) => {
      const problems: Problems = []
      const placed = out.views.flatMap(view => view.cuts)
      const missing = data.cuts.filter(cut => !placed.includes(cut))
      if (missing.length) problems.push(`这些镜头没有归到任何机位：${missing.join('、')}`)
      const twice = placed.filter((cut, i) => placed.indexOf(cut) !== i)
      if (twice.length) problems.push(`这些镜头归到了不止一个机位：${[...new Set(twice)].join('、')}`)
      const unknown = placed.filter(cut => !data.cuts.includes(cut))
      if (unknown.length) problems.push(`没有这些镜头：${unknown.join('、')}`)
      const names = out.views.map(view => view.name)
      const dup = names.filter((name, i) => names.indexOf(name) !== i)
      if (dup.length) problems.push(`机位名字重复：${[...new Set(dup)].join('、')}`)
      const bad = names.filter(name => /[/／]/.test(name))
      if (bad.length) problems.push(`机位名字里不能有斜杠：${bad.join('、')}`)
      const blank = out.views.filter(view => view.name !== MAIN_VIEW && !view.camera.trim()).map(view => view.name)
      if (blank.length) problems.push(`这些机位没写相机站位和朝向：${blank.join('、')}`)
      return problems
    },
  }),
  timeline: card<TimelineT, TimelineData>({
    name: 'timeline', output: 'json', schema: Timeline, maxTokens: 16000,
    checks: (out, data) => {
      const problems: Problems = []
      if (out.seconds !== data.seconds) problems.push(`seconds 是 ${out.seconds}，这一段是 ${data.seconds} 秒`)
      const seconds = out.timeline.map(entry => entry.second)
      const expected = Array.from({ length: data.seconds }, (_, i) => i)
      if (seconds.join(',') !== expected.join(',')) problems.push(`timeline 要从第 0 秒到第 ${data.seconds - 1} 秒每秒一项`)
      const cuts = [...out.cuts].sort((a, b) => a.start - b.start)
      if (cuts[0]?.start !== 0 || cuts.at(-1)?.end !== data.seconds || cuts.some((cut, i) => i > 0 && cut.start !== cuts[i - 1]!.end)) problems.push('cuts 要从第 0 秒开始、首尾相接覆盖整段')
      const said = out.lines.map(line => `${line.speaker}：${line.text}`)
      const given = data.lines.map(line => `${line.speaker}：${line.text}`)
      const lost = given.filter(line => !said.includes(line))
      const extra = said.filter(line => !given.includes(line))
      if (lost.length) problems.push(`这些台词没有逐字出现：${lost.join(' / ')}`)
      if (extra.length) problems.push(`这些台词不在剧本里或改了字：${extra.join(' / ')}`)
      if (out.lines.some(line => line.start < 0 || line.end > data.seconds || line.end < line.start)) problems.push('台词的起止秒数超出这一段')
      return problems
    },
  }),
  'keyframe-desc': card<string, unknown>({ name: 'keyframe-desc', output: 'text', checks: boundary(STYLE_WORDS) }),
  trim: card<TrimT, TrimData>({
    name: 'trim', output: 'json', schema: Trim,
    checks: (out, data) => {
      const problems: Problems = []
      if (out.out <= out.in) problems.push(`出点 ${out.out} 不在入点 ${out.in} 之后`)
      if (out.out > data.seconds) problems.push(`出点 ${out.out} 超出段长 ${data.seconds} 秒`)
      return problems
    },
  }),
  assistant: card<AssistantActionT, AssistantData>({
    name: 'assistant', output: 'json', schema: AssistantAction,
    checks: (out, data) => ('target' in out && !data.targets.includes(out.target) ? [`产物 ${out.target} 不在上下文列出的产物里；换一个列出的编号，或者用 ask 反问`] : []),
  }),
}
