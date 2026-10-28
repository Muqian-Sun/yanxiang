/**
 * The video prompt, compiled by the program from the timeline (design 05 五), in H3's six
 * Ref2VA sections. Section names and reference labels are H3's own; the body is Chinese,
 * dialogue verbatim from the script.
 */
import { momentsOf, type TimelineT } from '../tasks.js'
import { MAX_AUDIOS, MAX_IMAGES } from './workflow.js'

export type Bound =
  | { kind: 'keyframe'; cut: number; at: number; media: number }
  /** `outfit`: the costume's flat lay, for a name standing for that many people; `costume`: a costume changed into. */
  | { kind: 'portrait'; name: string; anchors: string; media: number; turnaround?: boolean; outfit?: number; costume?: string }
  | { kind: 'view'; label: string; cuts: number[]; media: number }
  | { kind: 'prop'; name: string; anchors: string; media: number }
export type Voice = { name: string; media: number }

/** Design 07 一: when more than nine pictures are wanted, keyframes stay, then the main characters, key props, the place, the other characters. */
export function choosePictures(wanted: Bound[], mainCharacters: string[]): { bound: Bound[]; dropped: Bound[] } {
  const rank = (b: Bound) => (b.kind === 'keyframe' ? 0 : b.kind === 'portrait' ? (mainCharacters.includes(b.name) ? 1 : 4) : b.kind === 'prop' ? 2 : 3)
  const kept = new Set([...wanted].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_IMAGES))
  return { bound: wanted.filter(b => kept.has(b)), dropped: wanted.filter(b => !kept.has(b)) }
}

/** At most three voices: the ones with the most lines. */
export function chooseVoices(voices: Voice[], lines: { speaker: string }[]): { voices: Voice[]; dropped: Voice[] } {
  const count = (v: Voice) => lines.filter(l => l.speaker === v.name).length
  const kept = new Set([...voices].sort((a, b) => count(b) - count(a)).slice(0, MAX_AUDIOS))
  return { voices: voices.filter(v => kept.has(v)), dropped: voices.filter(v => !kept.has(v)) }
}

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`
/** Script punctuation inside <d> stays; H3 wants a complete line ending in a mark. */
const said = (text: string) => (/[。！？!?.…]$/.test(text) ? text : `${text}。`)

export type SegmentPrompt = {
  style: string
  summary: string
  timeline: TimelineT
  bound: Bound[]
  voices: Voice[]
  /** Script lines (speaker：text) that are voice-over. */
  voiceOver: string[]
  /** What differs from the reference pictures when this segment starts: wounds, drawn swords. */
  states: string[]
  continues: boolean
  trigger?: string
}

export function compile(p: SegmentPrompt): string {
  const pictures = new Map<Bound, string>(p.bound.map((b, i) => [b, `<Picture ${i + 1}>`]))
  const audio = new Map(p.voices.map((v, i) => [v.name, `<Audio ${i + 1}>`]))
  const speakers = [...new Set([...p.timeline.lines].sort((a, b) => a.start - b.start).map(l => l.speaker))]
  const sid = (name: string) => `S${speakers.indexOf(name) + 1}`
  const portraits = p.bound.filter((b): b is Extract<Bound, { kind: 'portrait' }> => b.kind === 'portrait')
  const props = p.bound.filter((b): b is Extract<Bound, { kind: 'prop' }> => b.kind === 'prop')
  const labelOf = new Map<string, string>([...portraits, ...props].map(b => [b.name, pictures.get(b)!]))
  // Every mention of a bound person or prop carries its label (old project: binding only the first mention is worse than none).
  const names = [...labelOf.keys()].sort((a, b) => b.length - a.length)
  const tag = (text: string) => (names.length ? text.replace(new RegExp(names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), n => `${n}（${labelOf.get(n)}）`) : text)
  const keyframeOf = (cut: number) => p.bound.find((b): b is Extract<Bound, { kind: 'keyframe' }> => b.kind === 'keyframe' && b.cut === cut)
  const shotsWith = (name: string) => p.timeline.cuts.filter(c => c.present.characters.includes(name) || c.present.props.includes(name)).map(c => `[Shot ${c.index}]`)

  const definitions = [
    ...p.bound.map(b => {
      const t = pictures.get(b)!
      if (b.kind === 'keyframe') return `${t} 是 [Shot ${b.cut}] 开场那一刻的画面。`
      if (b.kind === 'portrait' && b.outfit) return `${t} 是${b.name}穿的这一套服装，画面里 ${b.outfit} 个${b.name}都穿它，脸和身形各不相同。`
      if (b.kind === 'portrait') return `${t} 是${b.name}${b.costume ? `（${b.costume}）` : ''}${b.turnaround ? '的三视图（正面、侧面、背面）' : ''}，${b.anchors ? `锚点：${b.anchors}` : '外观照这张图'}。`
      if (b.kind === 'prop') return `${t} 是${b.name}，${b.anchors ? `锚点：${b.anchors}` : '形制照这张图'}。`
      return `${t} 是${b.label}。`
    }),
    ...p.voices.map(v => `${audio.get(v.name)} 是${v.name}（${sid(v.name)}）的音色参考。`),
  ]

  const types = [...(p.bound.some(b => b.kind === 'keyframe') ? ['keyframe completion'] : []), 'reference generation', ...(p.voices.length ? ['audio reference'] : [])]
  const summary = `[${types.join(' + ')}] ${tag(p.summary)}${p.continues ? '这一段从上一段停下的那一刻接着演。' : ''}`

  const retention = [
    ...p.bound.map(b => {
      const t = pictures.get(b)!
      if (b.kind === 'keyframe') return `${t}（[Shot ${b.cut}] 开场画面）：fully_preserved - 只负责这一切开场的构图、站位和姿态。`
      if (b.kind === 'portrait' && b.outfit) return `${t}（出现在 ${shotsWith(b.name).join('、') || '画面里'}）：partially_preserved - 只负责${b.name}的衣服、鞋和佩物；不负责脸、发型和身形，${b.outfit} 个人各长各的，也不继承平铺的摆法。`
      if (b.kind === 'portrait') return `${t}（出现在 ${shotsWith(b.name).join('、') || '画面里'}）：partially_preserved - 只负责${b.name}的脸、发型、身形和这套造型；不负责构图、动作和表情，也不继承${b.turnaround ? '三视图的并排站姿' : '定妆照的正面居中和直视镜头'}。`
      if (b.kind === 'prop') return `${t}（出现在 ${shotsWith(b.name).join('、') || '画面里'}）：partially_preserved - 只负责${b.name}的形状和结构，不负责它在谁手里、是什么状态。`
      return `${t}（${b.cuts.map(c => `[Shot ${c}]`).join('、')}）：weak_reference - 只负责空间和陈设方位。`
    }),
    ...p.voices.map(v => `${audio.get(v.name)}：reference - ${v.name}的台词只取这段音色，不取原话和语气。`),
    ...(p.states.length ? [`此刻和参考图不一样的状态以正文为准：${tag(p.states.join('；'))}。`] : []),
  ]

  const shots = p.timeline.cuts.map(cut => {
    const head = cut.index === 1 ? '[Shot 1]' : `[Shot ${cut.index}] At ${clock(cut.start)}，切到第 ${cut.index} 个镜头。`
    const kf = keyframeOf(cut.index)
    const opening = kf ? `这一切从 ${pictures.get(kf)} 开始。` : cut.index === 1 && p.continues ? '这一切接着上一段最后的画面，机位、景别和人物左右位置不变。' : ''
    const moments = momentsOf(p.timeline).filter(m => m.from >= cut.start && m.from < cut.end).map(m => {
      const lines = p.timeline.lines.filter(l => l.start >= m.from && l.start < m.to).map(l => {
        const vo = p.voiceOver.includes(`${l.speaker}：${l.text}`)
        const others = cut.present.characters.filter(n => n !== l.speaker)
        const quiet = others.length ? `${others.map(tag).join('、')}不说话，嘴唇闭合。` : ''
        const when = `（第 ${l.start} 秒到第 ${l.end} 秒）`
        return vo
          ? `${l.speaker}（${sid(l.speaker)}）画外音说：<d>[Chinese] ${said(l.text)}</d>${when}画面里${cut.present.characters.includes(l.speaker) ? `${tag(l.speaker)}嘴唇闭合，` : ''}没有人张嘴。${quiet}`
          : `${tag(l.speaker)}（${sid(l.speaker)}）说：<d>[Chinese] ${said(l.text)}</d>${when}只说一次，说完闭嘴。${quiet}`
      })
      return `第 ${m.to - m.from > 1 ? `${m.from}–${m.to}` : m.from} 秒：${tag(m.text)}${lines.length ? ` ${lines.join(' ')}` : ''}`
    })
    return [`${head} ${opening}镜头：${tag(cut.shot)}。运镜：${cut.camera}。`, ...moments].join('\n')
  })

  return [
    ...(p.trigger ? [p.trigger] : []),
    `subject_definitions:\n${definitions.join('\n')}`,
    `summary:\n${summary}`,
    `retention_analysis:\n${retention.join('\n')}`,
    `detailed_description:\n${p.style.trim()}\n${shots.join('\n')}\n全程不生成字幕、caption 和任何文字叠加。`,
    `overall_soundscape:\n${p.timeline.ambience.replace(/[。.]$/, '')}。除了台词，没有别的人声。`,
    'non_diegetic_music:\n无',
  ].join('\n\n')
}

/** Design 07 四: one person alone, saying one of their own lines, so H3 gives them a voice to keep. */
export function auditionPrompt(p: { style: string; name: string; gender: string; age: string; anchors: string; line: string; seconds: number }): string {
  const age = p.age.replace(/^看起来/, '')
  return [
    `subject_definitions:\n<Picture 1> 是${p.name}，${p.anchors ? `锚点：${p.anchors}` : '外观照这张图'}。`,
    `summary:\n[reference generation] ${p.name}独自站在安静的室内，对着画面外的人说一句话。`,
    `retention_analysis:\n<Picture 1>（[Shot 1]）：partially_preserved - 只负责${p.name}的脸、发型、身形和这套造型，不继承定妆照的站姿和直视镜头。`,
    `detailed_description:\n${p.style.trim()}\n[Shot 1] 固定机位的中近景，${p.name}（<Picture 1>）站在素净的室内，身体微侧，目光看向画面左侧画外的人。第 0 秒：${p.name}（S1）轻吸一口气。第 1 秒：${p.name}（S1）开口说：<d>[Chinese] ${said(p.line)}</d>（第 1 秒到第 ${p.seconds - 1} 秒）声音听起来像${age}的${p.gender === '女' ? '女子' : p.gender === '男' ? '男子' : p.gender}，不是童声；只说一次，说完闭嘴，目光不动。\n全程不生成字幕、caption 和任何文字叠加。`,
    'overall_soundscape:\n只有安静的室内底声。除了台词，没有别的人声。',
    'non_diegetic_music:\n无',
  ].join('\n\n')
}
