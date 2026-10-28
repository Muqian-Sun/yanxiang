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

const startsWithKey = (line: string, key: string) => line.startsWith(`${key}：`) || line.startsWith(`${key}:`)

/** Every key must open a line of its own; the body under a key may run over several lines. */
function headed(keys: readonly string[]) {
  return (out: string): Problems => {
    const lines = out.split('\n').map(line => line.trim())
    const missing = keys.filter(key => !lines.some(line => startsWithKey(line, key)))
    return missing.length ? [`缺少这几项：${missing.join('、')}。每一项另起一行，以「项名：」开头`] : []
  }
}

/** Names the prompts borrow from 《凡人修仙传》 for their examples (script.md, keyframe-desc.md, the genre's sample); a story must not take them. */
const EXAMPLE_NAMES = ['韩立', '墨大夫', '墨居仁', '张铁', '厉飞雨', '南宫婉']

function noExampleNames(out: string): Problems {
  const hit = EXAMPLE_NAMES.filter(name => out.includes(name))
  return hit.length ? [`这些是提示词示例里《凡人修仙传》的人名：${hit.join('、')}。换成本故事自己的名字`] : []
}

/** A review is 「无」 or lines of 「场N｜原句｜问题｜改法」. */
function reviewList(out: string): Problems {
  const lines = out.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length === 1 && lines[0] === '无') return []
  // The quote may span scenes (「场2｜……／场3｜……」); the line starts at a scene and ends with the problem and the fix.
  const bad = lines.filter(line => !/^场\d+[^｜]*｜.+｜[^｜]+｜[^｜]+$/.test(line))
  const problems: Problems = bad.length ? [`这些行不是「场N｜原句｜问题｜改法」的格式：${bad.slice(0, 3).join(' / ')}`] : []
  if (lines.length > REVIEW_MAX) problems.push(`写了 ${lines.length} 条，最多 ${REVIEW_MAX} 条：只留最伤的`)
  return problems
}
/** The review prompt's own cap (tested in runs/ab-review); the rewrite takes only the worst problems. */
const REVIEW_MAX = 10

export const SETUP_KEYS = ['世界一角', '规则', '人物', '真相', '地点', '独有时刻'] as const

/** One item of the episode setup, from its key line up to the next key line. */
export function setupSection(text: string, key: (typeof SETUP_KEYS)[number]): string {
  const lines = text.split('\n')
  const start = lines.findIndex(line => startsWithKey(line.trim(), key))
  if (start < 0) return ''
  const end = lines.findIndex((line, i) => i > start && SETUP_KEYS.some(k => startsWithKey(line.trim(), k)))
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim()
}

export type ScreenplayLine = { speaker: string; text: string; vo?: boolean }
export type ScreenplayScene = { heading: string; location: string; setting: string; lines: ScreenplayLine[] }

const HEADING = /^场\d+\s/
const DIALOGUE = /^([^：:△[\]，。]{1,16})[：:](.+)$/
const NOTE_BEFORE = /^[（(][^）)]*[）)]\s*/
const NOTE_AFTER = /\s*[（(][^）)]*[）)]$/

/**
 * Reads the written screenplay (script.md's format): 「场N 内 · 地点 · 时辰」 headings, the setting paragraph
 * right under each, then 「△」 actions, 「人名：台词」 lines and 「[变化]」 lines. A line that is none of these is
 * reported rather than guessed at, so the extraction never works from a misread screenplay.
 */
export function screenplay(text: string): { scenes: ScreenplayScene[]; problems: Problems } {
  const scenes: ScreenplayScene[] = []
  const strange: string[] = []
  let scene: ScreenplayScene | undefined
  let atHeading = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (HEADING.test(line)) {
      const parts = line.replace(HEADING, '').split('·').map(part => part.trim())
      scene = { heading: line, location: parts.length === 3 ? parts[1]! : '', setting: '', lines: [] }
      scenes.push(scene)
      atHeading = true
      continue
    }
    const first = atHeading
    atHeading = false
    if (!scene) {
      strange.push(line)
      continue
    }
    if (line.startsWith('△') || line.startsWith('[变化]')) continue
    const said = line.match(DIALOGUE)
    // The setting paragraph may itself hold a colon (「洞口刻着四个字：镇魔」); right under a heading only a short line reads as dialogue.
    if (said && (!first || (said[1]!.trim().length <= 8 && line.length <= 60))) {
      const who = said[1]!.trim()
      const line: ScreenplayLine = { speaker: who.replace(NOTE_AFTER, ''), text: said[2]!.trim().replace(NOTE_BEFORE, '') }
      if (who.match(NOTE_AFTER)?.[0].includes('画外音')) line.vo = true
      scene.lines.push(line)
      continue
    }
    if (first) {
      scene.setting = line
      continue
    }
    strange.push(line)
  }
  const problems: Problems = []
  if (!scenes.length) problems.push('没有场头。每场第一行写「场1 内 · 地点名 · 时辰和天气」')
  const badHeads = scenes.filter(s => !s.location).map(s => s.heading)
  if (badHeads.length) problems.push(`这些场头不是「场N 内 · 地点名 · 时辰和天气」的格式：${badHeads.slice(0, 3).join(' / ')}`)
  const bare = scenes.filter(s => s.location && !s.setting).map(s => s.heading)
  if (bare.length) problems.push(`这些场的场头下面没有写环境那一段：${bare.slice(0, 3).join(' / ')}`)
  if (strange.length) problems.push(`这些行看不出是动作、台词还是状态变化：${strange.slice(0, 3).join(' / ')}。动作以「△」开头，台词写「人名：台词」，状态变化以「[变化]」开头`)
  return { scenes, problems }
}

/** A non-empty line of the written screenplay, with the seconds the script prompt estimates for it (four characters a second spoken, three seconds an action). */
export type ScreenplayRow = { index: number; text: string; kind: 'heading' | 'setting' | 'action' | 'line' | 'change'; scene: number; seconds: number }

export function screenplayRows(text: string): ScreenplayRow[] {
  const rows: ScreenplayRow[] = []
  let scene = -1
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    if (HEADING.test(line)) return void rows.push({ index, text: line, kind: 'heading', scene: ++scene, seconds: 0 })
    const said = line.match(DIALOGUE)
    const kind = line.startsWith('△') ? 'action' : line.startsWith('[变化]') ? 'change' : rows.at(-1)?.kind === 'heading' && !(said && said[1]!.trim().length <= 8 && line.length <= 60) ? 'setting' : 'line'
    rows.push({ index, text: line, kind, scene, seconds: kind === 'action' ? 3 : kind === 'line' ? voicedCount(said?.[2] ?? line) / SPEECH_RATE : 0 })
  })
  return rows
}

/**
 * The screenplay up to and including `row` (an index into `rows`), and the rest. A rest that starts
 * inside a scene gets that scene's heading and setting again, so it reads as a screenplay of its own.
 */
export function splitScreenplay(text: string, rows: ScreenplayRow[], row: number): { first: string; rest: string } {
  const lines = text.split('\n')
  const at = rows[row]!
  const first = lines.slice(0, at.index + 1).join('\n').trimEnd()
  const after = rows[row + 1]!
  const carried = after.kind === 'heading' ? [] : rows.filter(r => r.scene === at.scene && (r.kind === 'heading' || r.kind === 'setting')).map(r => r.text)
  return { first, rest: [...carried, ...lines.slice(after.index)].join('\n').trim() }
}

/** Numbers as runs: 3–7、9. */
export const runsOf = (ns: number[]) => ns.reduce<number[][]>((out, n) => (out.at(-1)?.at(-1) === n - 1 ? out.at(-1)!.push(n) : out.push([n]), out), []).map(r => (r.length > 1 ? `${r[0]}–${r.at(-1)}` : `${r[0]}`)).join('、')

const Direction = z.object({ title: z.string().min(1), logline: z.string().min(1), situation: z.string().min(1), opposition: z.string().min(1), episode: z.string().min(1), cliffhanger: z.string().min(1), promise: z.string().min(1) })
/** `vo`: an off-screen voice; the speaker's lips do not move. */
const Line = z.object({ speaker: z.string().min(1), text: z.string().min(1), vo: z.boolean().optional() })
const Beat = z.object({ id: z.string().min(1), action: z.string(), lines: z.array(Line), seconds: z.number().int().positive(), changes: z.array(z.string()) })
export const Script = z.object({
  /** `setting` is the paragraph under the scene's heading in the written screenplay; a hand-written script (M1) has none. */
  scenes: z.array(z.object({ id: z.string(), location: z.string().min(1), setting: z.string().optional(), beats: z.array(Beat).min(1) })).min(1),
  roster: z.object({
    characters: z.array(z.object({
      name: z.string().min(1), gender: z.string(), age_look: z.string(), rank: z.string(), tier: z.string(), needs: z.string(), temperament: z.string(), appearance_lines: z.array(z.string()),
      /** How many people the name stands for (two guards); they share one costume. */
      count: z.number().int().positive().default(1),
      /** Costumes changed into after the opening one, in order, each from the beat it is first worn in. */
      costumes: z.array(z.object({ name: z.string().min(1), from: z.string().min(1) })).default([]),
    })).min(1),
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
  cuts: z.array(z.object({ index: z.number().int(), start: z.number(), end: z.number(), camera: z.string().min(1), shot: z.string().min(1), present: z.object({ characters: z.array(z.string()), backs: z.array(z.string()).default([]), props: z.array(z.string()), view: z.string().min(1) }),
    /** Where this shot is, when the segment crosses locations; otherwise the segment's own. */
    location: z.preprocess(v => (typeof v === 'string' && !v.trim() ? undefined : v), z.string().optional()) })).min(1),
  /** What happens, one entry a shot from its start to its end (creator, 2026-10-28: not one entry a second, 「就是一个完整镜头的时长」). */
  timeline: z.array(z.object({ from: z.number(), to: z.number(), text: z.string().min(1), changes: z.array(z.string()) })),
  lines: z.array(z.object({ speaker: z.string(), text: z.string(), start: z.number(), end: z.number() })),
  ambience: z.string(),
  /** A fight or chase: the video gets the martial-arts motion LoRA (design 07 二). */
  fight: z.boolean().default(false),
})
export type TimelineT = z.infer<typeof Timeline>
export type Moment = TimelineT['timeline'][number]

/** A timeline's entries as stretches of seconds; one stored before 2026-10-28 has an entry per second, read as one second each. */
export function momentsOf(timeline: TimelineT): Moment[] {
  return (timeline.timeline as (Moment | { second: number; text: string; changes: string[] })[]).map(e => ('second' in e ? { from: e.second, to: e.second + 1, text: e.text, changes: e.changes } : e))
}
export const MAIN_VIEW = '主视角'
export const ViewGroups = z.object({
  views: z.array(z.object({ name: z.string().min(1).max(12), camera: z.string(), cuts: z.array(z.string()).min(1) })).min(1),
})
export type ViewGroupsT = z.infer<typeof ViewGroups>
/** Where people can be in a scene's location; a seat holds one person at a time. */
export const SPOT_KINDS = ['座位', '站位', '出入口'] as const
/**
 * A scene's staging, decided once from the location's main picture so that every timeline and
 * keyframe of the scene puts people in the same places (creator, 2026-10-28: seats changed and
 * chairs multiplied from shot to shot). `people`: where someone is from a beat on, in beat order.
 */
export const Blocking = z.object({
  spots: z.array(z.object({ name: z.string().min(1).max(8), kind: z.enum(SPOT_KINDS), where: z.string().min(1) })).min(1),
  people: z.array(z.object({ name: z.string().min(1), from: z.string().min(1), spot: z.string().min(1), pose: z.string().min(1), how: z.string().min(1) })).min(1),
})
export type BlockingT = z.infer<typeof Blocking>

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
/** What the program read from the written screenplay; the extraction must keep every line and scene of it. */
export type ExtractData = ScriptData & { lines: ScreenplayLine[]; locations: string[] }
/** `voiced`: spoken characters per beat (punctuation left out), dialogue and voice-over alike. */
export type PlanData = { beats: string[]; voiced: Record<string, number>; min: number; max: number; locations: string[]; changes: { name: string; costume: string; from: string }[] }

/** H3 spoke about 4.1 Chinese characters a second in our samples (经验审核 05-18); one more second for the start and the end follows Toonflow's margin and is a guess. */
export const SPEECH_RATE = 4.1
const SPEECH_MARGIN = 1

export const voicedCount = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, '').length

export function voicedPerBeat(beats: { id: string; lines: { text: string }[] }[]): Record<string, number> {
  return Object.fromEntries(beats.map(beat => [beat.id, beat.lines.reduce((sum, line) => sum + voicedCount(line.text), 0)]))
}
/** Props of the episode that someone else holds: the video binds every mention of a prop's name to its picture. */
export type CharacterData = { others: { name: string; holder: string }[] }
/** Lines (numbered from 1) after which the episode would still fit its length. */
export type CutData = { allowed: number[] }
export type ViewGroupsData = { cuts: string[] }
/** The scene's beats in order, and the beat each person who is on stage in it is first there. */
export type BlockingData = { beats: string[]; first: Record<string, string> }
/** The shortest shot, by the creator (2026-10-28): H3 had only been tried at 3 cuts in 15 s, and a cut of about a second looked too choppy to trust. */
export const MIN_SHOT = 4
export type TimelineData = { seconds: number; lines: { speaker: string; text: string }[]; characters: string[]; props: string[]; locations: string[] }
/** The trim is clamped to the allowed range by the editor (design 08); only an impossible answer is sent back. */
export type TrimData = { seconds: number }
/** Artifacts on the page and their upstream: the only things the assistant may act on. */
export type AssistantData = { targets: string[] }

/** Checks every structured script must pass, whether extracted by the model or written by hand (M1). */
export function scriptProblems(out: ScriptT, data: ScriptData): Problems {
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
  const blank = out.roster.characters.filter(c => !c.gender.trim() || !c.age_look.trim()).map(c => c.name)
  if (blank.length) problems.push(`这些人物没写性别或外观年龄：${blank.join('、')}；剧本没写明的，按身份和称呼推一个，例如「看起来二十出头」`)
  for (const person of out.roster.characters) {
    const costumes = person.costumes
    const at = costumes.map(c => ids.indexOf(c.from))
    const unknown = costumes.filter((_, i) => at[i]! < 0).map(c => `${c.name}（${c.from}）`)
    if (unknown.length) problems.push(`${person.name}的换装写了剧本里没有的拍：${unknown.join('、')}；from 写他第一次穿这套的那一拍的 id`)
    else if (at.some((x, i) => i > 0 && x <= at[i - 1]!)) problems.push(`${person.name}的换装要按穿上的先后排，from 一个比一个靠后`)
    const costumeNames = costumes.map(c => c.name)
    const bad = costumeNames.filter((n, i) => n.includes('/') || costumeNames.indexOf(n) !== i)
    if (bad.length) problems.push(`${person.name}的造型名重复或带「/」：${[...new Set(bad)].join('、')}`)
  }
  return problems
}

/** Where someone changes costume: the beat a segment must start at (design 04, creator 2026-10-28). Rosters stored before then have no costumes. */
export function costumeChanges(roster: ScriptT['roster']): PlanData['changes'] {
  return roster.characters.flatMap(person => (person.costumes ?? []).map(c => ({ name: person.name, costume: c.name, from: c.from })))
}

const card = <Out, Data>(c: Omit<Card, 'checks'> & { checks?: (out: Out, data: Data) => Problems }): Card => c as Card

export const CARDS: Record<string, Card> = {
  'story-directions': card<{ directions: unknown[] }, unknown>({
    name: 'story-directions', output: 'json', schema: z.object({ directions: z.array(Direction) }),
    checks: out => (out.directions.length === 3 ? [] : [`方向要恰好 3 个，现在是 ${out.directions.length} 个`]),
  }),
  'story-setup': card<string, unknown>({ name: 'story-setup', output: 'text', checks: out => [...headed(SETUP_KEYS)(out), ...noExampleNames(out)] }),
  script: card<string, unknown>({ name: 'script', output: 'text', maxTokens: 16000, checks: out => [...screenplay(out).problems, ...noExampleNames(out)] }),
  'script-review': card<string, unknown>({ name: 'script-review', output: 'text', checks: reviewList }),
  'script-extract': card<ScriptT, ExtractData>({
    name: 'script-extract', output: 'json', schema: Script, maxTokens: 16000,
    checks: (out, data) => {
      // The length is the screenplay's, not the extraction's: the story flow rewrites the screenplay when it is off.
      const problems = scriptProblems(out, { min: 0, max: Number.POSITIVE_INFINITY })
      const locations = out.scenes.map(scene => scene.location)
      if (locations.join('|') !== data.locations.join('|')) problems.push(`场要和正文的场头一一对应、顺序不变，地点照抄场头：正文是 ${data.locations.join('、')}，现在是 ${locations.join('、')}`)
      const key = (line: ScreenplayLine) => `${line.speaker}${line.vo ? '（画外音）' : ''}：${line.text}`
      const said = out.scenes.flatMap(scene => scene.beats.flatMap(beat => beat.lines)).map(key)
      const given = data.lines.map(key)
      const lost = given.filter(line => !said.includes(line))
      const extra = said.filter(line => !given.includes(line))
      if (lost.length) problems.push(`这些台词没有逐字出现，或者画外音没有标 vo：${lost.slice(0, 5).join(' / ')}`)
      if (extra.length) problems.push(`这些台词不在正文里或改了字：${extra.slice(0, 5).join(' / ')}`)
      return problems
    },
  }),
  'episode-cut': card<{ after: number; reason: string }, CutData>({
    name: 'episode-cut', output: 'json', schema: z.object({ after: z.number().int(), reason: z.string().min(1) }),
    checks: (out, data) => (data.allowed.includes(out.after) ? [] : [`第 ${out.after} 行之后不能切，那样这一集不在单集时长里；只能在这些行之后选：${runsOf(data.allowed)}`]),
  }),
  'character-design': card<string, CharacterData>({
    name: 'character-design', output: 'text',
    checks: (out, data) => {
      const problems = lineList(['性别与年龄', '锚点', '身高', '主色', '区分'])(out)
      const taken = data.others.filter(p => out.includes(p.name))
      if (taken.length) problems.push(`这些是本集别人的道具：${taken.map(p => `${p.name}（${p.holder}）`).join('、')}。他身上的东西不用这些名字，换个叫法或者不写`)
      return problems
    },
  }),
  'location-design': card<string, unknown>({ name: 'location-design', output: 'text', checks: lineList(['身份', '视觉中心', '陈设', '尺度', '色彩', '锚点']) }),
  'prop-design': card<string, unknown>({ name: 'prop-design', output: 'text', checks: lineList(['文字', '锚点']) }),
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
      for (const segment of out.segments) {
        const chars = segment.beats.reduce((sum, id) => sum + (data.voiced[id] ?? 0), 0)
        const need = Math.ceil(chars / SPEECH_RATE + SPEECH_MARGIN)
        if (chars && segment.seconds < need) problems.push(`${segment.id} 里的台词有 ${chars} 个字，至少要 ${need} 秒才说得完，现在只有 ${segment.seconds} 秒；拉长这一段，或者把拍分到相邻的段`)
      }
      const strange = [...new Set(out.segments.map(segment => segment.location).filter(location => !data.locations.includes(location)))]
      if (strange.length) problems.push(`这些地点不在出场清单里：${strange.join('、')}；location 只能写清单里的地点名：${data.locations.join('、')}`)
      // A segment's pictures are bound once for the whole segment, so a costume change must open one.
      for (const change of data.changes) {
        const segment = out.segments.find(s => s.beats.includes(change.from))
        if (segment && segment.beats[0] !== change.from) problems.push(`${segment.id} 跨过了换装：${change.name}从 ${change.from} 起换上${change.costume}，${change.from} 要作为一段的第一拍`)
      }
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
  blocking: card<BlockingT, BlockingData>({
    name: 'blocking', output: 'json', schema: Blocking,
    checks: (out, data) => {
      const problems: Problems = []
      const names = out.spots.map(s => s.name)
      const dup = names.filter((n, i) => names.indexOf(n) !== i)
      if (dup.length) problems.push(`位置的名字重复：${[...new Set(dup)].join('、')}`)
      const people = Object.keys(data.first)
      const strangers = [...new Set(out.people.map(p => p.name).filter(n => !people.includes(n)))]
      if (strangers.length) problems.push(`这些人不在这一场：${strangers.join('、')}；name 只能写 ${people.join('、')}`)
      const nowhere = out.people.filter(p => !names.includes(p.spot)).map(p => `${p.name}（${p.from}）的「${p.spot}」`)
      if (nowhere.length) problems.push(`spot 要照抄 spots 里的名字，这些没有：${nowhere.join('、')}`)
      const offScript = out.people.filter(p => !data.beats.includes(p.from)).map(p => `${p.name}的「${p.from}」`)
      if (offScript.length) problems.push(`from 要写这一场的拍号（${data.beats.join('、')}），这些不是：${offScript.join('、')}`)
      const at = (beat: string) => data.beats.indexOf(beat)
      const unplaced = people.filter(n => !out.people.some(p => p.name === n && at(p.from) >= 0 && at(p.from) <= at(data.first[n]!)))
      if (unplaced.length) problems.push(`这些人到出场的那一拍还没有位置：${unplaced.map(n => `${n}（${data.first[n]} 出场）`).join('、')}`)
      const seats = new Set(out.spots.filter(s => s.kind === '座位').map(s => s.name))
      const crowded = data.beats.flatMap(beat => {
        const where = new Map<string, string[]>()
        for (const name of people) {
          const spot = out.people.filter(p => p.name === name && at(p.from) >= 0 && at(p.from) <= at(beat)).sort((a, b) => at(a.from) - at(b.from)).at(-1)?.spot
          if (spot && seats.has(spot)) where.set(spot, [...(where.get(spot) ?? []), name])
        }
        return [...where].filter(([, who]) => who.length > 1).map(([spot, who]) => `${beat} 的${spot}坐了${who.join('、')}`)
      })
      if (crowded.length) problems.push(`一个座位同一时刻只坐一个人：${crowded.join('；')}`)
      // Directions are the main picture's (creator, 2026-10-28); 「东西」 as "things" is not one.
      const fields = [...out.spots.flatMap(s => [s.name, s.where]), ...out.people.flatMap(p => [p.pose, p.how])]
      const compass = [...new Set(fields.flatMap(t => t.replaceAll('东西', '').match(/[东南西北]+[^\s，。；、]?/g) ?? []))]
      if (compass.length) problems.push(`方位按主图画面写上下左右，不用东南西北，名字里也不用；这些词要换掉：${compass.join('、')}。对照主图换成画面上的说法，例如门在画面下方就写「门口」，桌子靠画面右边的一头写「桌子右端」，桌子离镜头远的一侧写「桌后」`)
      return problems
    },
  }),
  timeline: card<TimelineT, TimelineData>({
    name: 'timeline', output: 'json', schema: Timeline, maxTokens: 16000,
    checks: (out, data) => {
      const problems: Problems = []
      if (out.seconds !== data.seconds) problems.push(`seconds 是 ${out.seconds}，这一段是 ${data.seconds} 秒`)
      const cuts = [...out.cuts].sort((a, b) => a.start - b.start)
      const written = out.timeline.map(m => `${m.from}–${m.to}`).join('、')
      const shots = cuts.map(cut => `${cut.start}–${cut.end}`).join('、')
      if (written !== shots) problems.push(`timeline 每个镜头写一项，按镜头顺序，from、to 照抄这个镜头的 start、end：镜头是 ${shots}，timeline 写的是 ${written || '（空）'}`)
      const seams = [
        ...(cuts[0]?.start !== 0 ? [`第一个镜头的 start 是 ${cuts[0]?.start}，要是 0`] : []),
        ...cuts.slice(1).flatMap((cut, i) => (cut.start !== cuts[i]!.end ? [`第 ${cuts[i]!.index} 个镜头的 end 是 ${cuts[i]!.end}、第 ${cut.index} 个的 start 是 ${cut.start}，两个要相等`] : [])),
        ...(cuts.at(-1)?.end !== data.seconds ? [`最后一个镜头的 end 是 ${cuts.at(-1)?.end}，要等于这一段的 ${data.seconds} 秒`] : []),
      ]
      if (seams.length) problems.push(`cuts 要首尾相接覆盖整段，start、end 是开始和结束的那一刻：${seams.join('；')}`)
      const said = out.lines.map(line => `${line.speaker}：${line.text}`)
      const given = data.lines.map(line => `${line.speaker}：${line.text}`)
      const lost = given.filter(line => !said.includes(line))
      const extra = said.filter(line => !given.includes(line))
      if (lost.length) problems.push(`这些台词没有逐字出现：${lost.join(' / ')}`)
      if (extra.length) problems.push(`这些台词不在剧本里或改了字：${extra.join(' / ')}`)
      if (out.lines.some(line => line.start < 0 || line.end > data.seconds || line.end < line.start)) problems.push('台词的起止秒数超出这一段')
      const strange = [...new Set(out.cuts.flatMap(cut => [...cut.present.characters.filter(n => !data.characters.includes(n)), ...cut.present.props.filter(n => !data.props.includes(n))]))]
      const short = out.cuts.filter(cut => cut.end - cut.start < MIN_SHOT).map(cut => `第 ${cut.index} 个镜头 ${cut.start}–${cut.end} 秒`)
      if (short.length) problems.push(`每个镜头至少 ${MIN_SHOT} 秒，这些太短：${short.join('、')}；合并相邻镜头，景别变化用推近、拉远在同一个镜头里完成`)
      const unlisted = out.cuts.flatMap(cut => cut.present.backs.filter(n => !cut.present.characters.includes(n)).map(n => `第 ${cut.index} 个镜头的 ${n}`))
      const placed = out.cuts.filter(cut => cut.location !== undefined ? !data.locations.includes(cut.location) : data.locations.length > 1)
      if (placed.length) problems.push(`这一段经过 ${data.locations.join('、')}，每个镜头的 location 要照抄其中一个：${placed.map(cut => `第 ${cut.index} 个镜头${cut.location ? `写了「${cut.location}」` : '没写'}`).join('、')}`)
      if (unlisted.length) problems.push(`backs 里的人也要写在同一个镜头的 characters 里：${unlisted.join('、')}`)
      if (strange.length) problems.push(`present 里这些名字不在出场清单里：${strange.join('、')}；人物只能写 ${data.characters.join('、')}，道具只能写 ${data.props.join('、') || '（无）'}，照抄名字，位置写进 shot`)
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
