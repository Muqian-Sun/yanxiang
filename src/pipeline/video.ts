/**
 * Video and editing nodes (design 04 一, 07, 08): audition → voice, draft (★7) → trim,
 * cut_draft (★8), refine → cut_final (★9).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fragment } from '../plugins.js'
import type { Artifact, Store } from '../store/store.js'
import { CARDS, SPEECH_RATE, type PlanT, type TimelineT, type TrimT } from '../tasks.js'
import { seedFor, video, type VideoRequest } from '../jobs/videos.js'
import { concat, cut, FONT, gaps, loudness, probe, run as ffmpeg, stills, tail, transcribe, voiceSample } from '../video/media.js'
import { auditionPrompt, chooseVoices, choosePictures, compile, type Bound } from '../video/prompt.js'
import { align, ass, type Cue } from '../video/subtitles.js'
import { FPS } from '../video/workflow.js'
import type { Env, NodeDef, Ready } from './engine.js'
import { EPISODE, episode, lockedImage, names, pick, scopeOf, text, type EntityEnv } from './entities.js'
import { cutId, cutLocation, planOf, segmentScope, stateBefore, viewOf } from './storyboard.js'

type Segment = PlanT['segments'][number]

/** Design 07 一: the replayed tail of the previous segment, in frames; 22 is on H3's 17k+5 grid. */
export const REPLAY_FRAMES = 22
const REPLAY = REPLAY_FRAMES / FPS
/** Audition length (design 07 四): 4–6 seconds, a guess; the line is cut to fit. */
const AUDITION = { min: 4, max: 6 }

const work = (store: Store, scope: string, runId: number) => {
  const dir = join(store.dir, 'work', scope.replaceAll('/', '-'), String(runId))
  mkdirSync(dir, { recursive: true })
  return dir
}
const charName = (scope: string) => scope.split('/')[2]!
const anchors = (store: Store, scope: string) => {
  const brief = store.locked('entity_brief', scope)
  return brief ? pick(text(brief), '锚点').replace(/^锚点：/, '') : ''
}
const timelineOf = (store: Store, id: string) => store.locked('timeline', segmentScope(id))
const segmentOf = (store: Store, scope: string) => planOf(store)?.plan.segments.find(s => segmentScope(s.id) === scope)
const previousOf = (store: Store, segment: Segment) => {
  const segments = planOf(store)!.plan.segments
  return segment.continues ? segments[segments.findIndex(s => s.id === segment.id) - 1] : undefined
}

/** Speakers with lines in the script, for the audition. */
function speakers(store: Store): string[] {
  const ep = episode(store)
  if (!ep) return []
  const voiced = new Set(ep.beats.flatMap(b => b.lines.map(l => l.speaker)))
  return names(store, 'char').filter(n => voiced.has(n))
}

/** The character's own line that fits the audition, or the longest cut at a pause (design 07 四, creator's choice 2026-10-28). */
export function auditionLine(lines: string[]): { line: string; seconds: number } {
  const room = Math.floor((AUDITION.max - 2) * SPEECH_RATE)
  const fits = lines.filter(l => [...l.replace(/[，。！？、：；…—\s]/g, '')].length <= room).sort((a, b) => b.length - a.length)
  let line = fits[0]
  if (!line) {
    const longest = [...lines].sort((a, b) => b.length - a.length)[0] ?? '……'
    const parts = longest.split(/(?<=[，。！？；])/)
    line = ''
    for (const part of parts) {
      if ([...(line + part).replace(/[，。！？、：；…—\s]/g, '')].length > room) break
      line += part
    }
    if (!line) line = [...longest].slice(0, room).join('')
  }
  const spoken = [...line.replace(/[，。！？、：；…—\s]/g, '')].length
  return { line, seconds: Math.min(AUDITION.max, Math.max(AUDITION.min, Math.ceil(spoken / SPEECH_RATE) + 2)) }
}

const audition: NodeDef = {
  name: 'audition',
  pool: 'video',
  output: 'audition',
  review: 5,
  paid: { pool: 'video', count: 1 },
  scopes: store => speakers(store).map(n => scopeOf('char', n)),
  ready(store, scope): Ready {
    const portrait = lockedImage(store, scope)
    const brief = store.locked('entity_brief', scope)
    return portrait && brief ? { ok: true, inputs: [portrait.lock.id, brief.id] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    if (!e.gpu) throw new Error('没有配置 GPU')
    const name = charName(scope)
    const person = episode(e.store)!.roster.characters.find(c => c.name === name)!
    const { line, seconds } = auditionLine(episode(e.store)!.beats.flatMap(b => b.lines.filter(l => l.speaker === name).map(l => l.text)))
    const prompt = auditionPrompt({ style: fragment(e.style, 'video'), name, gender: person.gender, age: person.age_look, anchors: anchors(e.store, scope), line, seconds })
    const portrait = e.store.artifact((e.store.artifact(inputs[0]!).payload as { image_id: number }).image_id)
    const request: VideoRequest = { prompt, seconds, seed: seedFor(run.id, 1), refine: false, loras: [], references: [{ role: 'reference_image', media: portrait.media_id! }], node_run_id: run.id, candidate: 1 }
    const made = await video(e.store, e.gpu.client, e.gpu.profile, request, e.sleep)
    return [e.store.addArtifact({ kind: 'audition', scope, payload: { job_id: made.job, prompt, line, seconds, seed: request.seed }, media_id: made.media, inputs, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/** The picked audition's speech, cut to a 2–15 second sample (design 07 四). */
const voice: NodeDef = {
  name: 'voice',
  pool: 'edit',
  output: 'voice',
  scopes: audition.scopes,
  ready(store, scope): Ready {
    const a = store.locked('audition', scope)
    return a ? { ok: true, inputs: [a.id] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const source = store.mediaPath(store.artifact(inputs[0]!).media_id!)
    const dir = work(store, scope, run.id)
    const words = await (env.listen ?? transcribe)(source, dir)
    if (!words.length) throw new Error('试音片段里没听出人声，重出一条试音')
    const duration = (await probe(source)).duration
    // From just before the first word to just after the last, at least 2 s (H3's lower bound for reference audio).
    let from = Math.max(0, words[0]!.start - 0.1)
    let to = Math.min(duration, words.at(-1)!.end + 0.2)
    if (to - from < 2) {
      to = Math.min(duration, from + 2)
      from = Math.max(0, to - 2)
    }
    const wav = join(dir, 'voice.wav')
    await voiceSample(source, from, Math.min(15, to - from), wav)
    const media = store.putMedia(readFileSync(wav), 'audio/wav', { duration_s: to - from, has_audio: true })
    const r = (x: number) => Math.round(x * 100) / 100
    return [store.addArtifact({ kind: 'voice', scope, payload: { from: r(from), to: r(to) }, media_id: media, inputs, node_run_id: run.id, created_by: 'program' }).id]
  },
}

/** Everything a segment's video is made from, once each of them is locked. */
function segmentInputs(store: Store, segment: Segment) {
  const timeline = timelineOf(store, segment.id)
  if (!timeline) return undefined
  const tl = timeline.payload as TimelineT
  const keyframes = tl.cuts.filter(c => !(segment.continues && c.index === 1)).map(c => ({ cut: c, kf: store.locked('keyframe', `${segmentScope(segment.id)}/c${c.index}`) }))
  if (keyframes.some(k => !k.kf)) return undefined
  const present = [...new Set(tl.cuts.flatMap(c => c.present.characters))]
  const props = [...new Set(tl.cuts.flatMap(c => c.present.props))]
  // Seen from behind anywhere in the segment: the turnaround stands for them (it has the front too, so it takes no extra slot).
  const backs = new Set(tl.cuts.flatMap(c => c.present.backs ?? []))
  const portraits = present.map(n => ({ name: n, turnaround: backs.has(n), img: lockedImage(store, backs.has(n) ? `${scopeOf('char', n)}/三视图` : scopeOf('char', n)) }))
  const sheets = props.map(n => ({ name: n, img: lockedImage(store, scopeOf('prop', n)) }))
  // A continuing segment's first cut is carried by the replayed tail, so it has no keyframe and no camera group.
  const views = keyframes.map(({ cut }) => ({ cut: cut.index, view: viewOf(store, cutLocation(segment, cut), cutId(segment.id, cut.index)) }))
  if ([...portraits, ...sheets].some(p => !p.img) || views.some(v => !v.view?.picture)) return undefined
  const speaking = [...new Set(tl.lines.map(l => l.speaker))]
  const voices = speaking.map(n => ({ name: n, voice: store.locked('voice', scopeOf('char', n)) }))
  if (voices.some(v => !v.voice)) return undefined
  return { timeline, tl, keyframes: keyframes.map(k => ({ cut: k.cut, kf: k.kf! })), portraits: portraits.map(p => ({ name: p.name, turnaround: p.turnaround, img: p.img! })), sheets: sheets.map(s => ({ name: s.name, img: s.img! })), views: views.map(v => ({ cut: v.cut, view: v.view! })), voices: voices.map(v => ({ name: v.name, voice: v.voice! })) }
}

type Made = NonNullable<ReturnType<typeof segmentInputs>>

/** The pictures and voices bound to a segment, in binding order, and what had to be left out. */
function references(store: Store, made: Made) {
  const mediaOfLock = (lock: Artifact) => store.artifact((lock.payload as { image_id: number }).image_id).media_id!
  const viewPictures = new Map<number, { label: string; cuts: number[]; media: number }>()
  for (const { cut, view } of made.views) {
    const entry = viewPictures.get(view.picture!.lock.id) ?? { label: view.label, cuts: [], media: mediaOfLock(view.picture!.lock) }
    entry.cuts.push(cut)
    viewPictures.set(view.picture!.lock.id, entry)
  }
  const wanted: Bound[] = [
    ...made.keyframes.map(k => ({ kind: 'keyframe' as const, cut: k.cut.index, at: k.cut.start, media: k.kf.media_id! })),
    ...made.portraits.map(p => ({ kind: 'portrait' as const, name: p.name, anchors: anchors(store, scopeOf('char', p.name)), media: mediaOfLock(p.img.lock), turnaround: p.turnaround })),
    ...made.sheets.map(s => ({ kind: 'prop' as const, name: s.name, anchors: anchors(store, scopeOf('prop', s.name)), media: mediaOfLock(s.img.lock) })),
    ...[...viewPictures.values()].map(v => ({ kind: 'view' as const, ...v })),
  ]
  const count = (n: string) => made.tl.cuts.filter(c => c.present.characters.includes(n)).length
  const most = Math.max(0, ...made.portraits.map(p => count(p.name)))
  const main = made.portraits.filter(p => count(p.name) === most || made.tl.lines.some(l => l.speaker === p.name)).map(p => p.name)
  const pictures = choosePictures(wanted, main)
  const voices = chooseVoices(made.voices.map(v => ({ name: v.name, media: v.voice.media_id! })), made.tl.lines)
  return { ...pictures, voices: voices.voices, droppedVoices: voices.dropped }
}

const label = (b: Bound) => (b.kind === 'keyframe' ? `第 ${b.cut} 切的关键帧` : b.kind === 'portrait' ? `${b.name}的${b.turnaround ? '三视图' : '定妆照'}` : b.kind === 'prop' ? `${b.name}的设定图` : b.label)

/** The request for a segment, draft or refine: same prompt, references and seed; only the guide clip and the refine pass differ. */
function segmentRequest(env: EntityEnv, segment: Segment, made: Made, nodeRunId: number, seed: number, refine: boolean, guide: number | undefined) {
  const { store } = env
  const refs = references(store, made)
  const ep = episode(store)!
  const voiceOver = ep.beats.filter(b => segment.beats.includes(b.id)).flatMap(b => b.lines.filter(l => l.vo).map(l => `${l.speaker}：${l.text}`))
  const prompt = compile({
    style: fragment(env.style, 'video'), summary: segment.summary, timeline: made.tl, bound: refs.bound, voices: refs.voices, voiceOver,
    states: stateBefore(store, segment.beats[0]!), continues: segment.continues, trigger: made.tl.fight ? env.gpu!.profile.fight.trigger : undefined,
  })
  const request: VideoRequest = {
    prompt, seconds: segment.seconds, seed, refine,
    loras: made.tl.fight ? [{ name: env.gpu!.profile.fight.lora, strength: env.gpu!.profile.fight.strength }] : [],
    references: [
      ...(guide !== undefined ? [{ role: 'guide_clip' as const, media: guide, at: 0 }] : []),
      ...refs.bound.map(b => (b.kind === 'keyframe' ? { role: 'keyframe' as const, media: b.media, at: b.at } : { role: 'reference_image' as const, media: b.media })),
      ...refs.voices.map(v => ({ role: 'reference_audio' as const, media: v.media })),
    ],
    node_run_id: nodeRunId, candidate: 1,
  }
  return { request, dropped: [...refs.dropped.map(label), ...refs.droppedVoices.map(v => `${v.name}的音色`)] }
}

/** The last 22 frames (with sound) before a trimmed clip's out point, stored as media. */
async function guideClip(store: Store, clip: Artifact, trimmed: Artifact, dir: string): Promise<number> {
  const out = join(dir, `tail-${clip.id}.mp4`)
  await tail(store.mediaPath(clip.media_id!), (trimmed.payload as TrimT).out, REPLAY_FRAMES, out)
  return store.putMedia(readFileSync(out), 'video/mp4', { frames: REPLAY_FRAMES, has_audio: true })
}

const draft: NodeDef = {
  name: 'draft',
  pool: 'video',
  output: 'clip_draft',
  review: 7,
  paid: { pool: 'video', count: 1 },
  reviseVia: (store, a) => store.locked('timeline', a.scope),
  scopes: store => planOf(store)?.plan.segments.map(s => segmentScope(s.id)) ?? [],
  ready(store, scope): Ready {
    const segment = segmentOf(store, scope)
    const made = segment && segmentInputs(store, segment)
    if (!segment || !made) return { ok: false }
    const prev = previousOf(store, segment)
    const before = prev ? [store.locked('clip_draft', segmentScope(prev.id)), store.locked('trim', segmentScope(prev.id))] : []
    if (before.some(a => !a)) return { ok: false }
    return { ok: true, inputs: [made.timeline.id, ...made.keyframes.map(k => k.kf.id), ...made.portraits.map(p => p.img.lock.id), ...made.sheets.map(s => s.img.lock.id), ...new Set(made.views.map(v => v.view.picture!.lock.id)), ...made.voices.map(v => v.voice.id), ...before.map(a => a!.id)] }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    if (!e.gpu) throw new Error('没有配置 GPU')
    const segment = segmentOf(e.store, scope)!
    const made = segmentInputs(e.store, segment)!
    const prev = previousOf(e.store, segment)
    const guide = prev ? await guideClip(e.store, e.store.locked('clip_draft', segmentScope(prev.id))!, e.store.locked('trim', segmentScope(prev.id))!, work(e.store, scope, run.id)) : undefined
    const { request, dropped } = segmentRequest(e, segment, made, run.id, seedFor(run.id, 1), false, guide)
    const clip = await video(e.store, e.gpu.client, e.gpu.profile, request, e.sleep)
    return [e.store.addArtifact({ kind: 'clip_draft', scope, payload: { job_id: clip.job, prompt: request.prompt, seed: request.seed, dropped, guide: guide ?? null }, media_id: clip.media, inputs, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/**
 * Design 08 二: the in and out points, tightened to what is allowed. A continuing segment
 * starts after the replay; otherwise at most 1 s is cut at the head (beyond the replay) and
 * 1.5 s at the tail, and no line is cut (out no earlier than 0.2 s after the last line).
 * The 1, 1.5 and 0.2 are guesses until M1's clips are watched.
 */
export function clampTrim(t: { in: number; out: number }, c: { duration: number; continues: boolean; firstLine?: number; lastLineEnd?: number }) {
  const head = c.continues ? REPLAY : 0
  let from = Math.min(Math.max(t.in, head), head + 1)
  if (c.firstLine !== undefined) from = Math.min(from, Math.max(head, c.firstLine))
  let to = Math.max(Math.min(t.out, c.duration), c.duration - 1.5)
  if (c.lastLineEnd !== undefined) to = Math.max(to, Math.min(c.duration, c.lastLineEnd + 0.2))
  const r = (x: number) => Math.round(x * 100) / 100
  return { in: r(from), out: r(to), adjusted: r(from) !== r(t.in) || r(to) !== r(t.out) }
}

const trim: NodeDef = {
  name: 'trim',
  pool: 'vision',
  output: 'trim',
  scopes: draft.scopes,
  ready(store, scope): Ready {
    const clip = store.locked('clip_draft', scope)
    return clip ? { ok: true, inputs: [clip.id] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    if (!env.vision) throw new Error('没有配置视觉模型')
    const segment = segmentOf(store, scope)!
    const tl = timelineOf(store, segment.id)!.payload as TimelineT
    const source = store.mediaPath(store.artifact(inputs[0]!).media_id!)
    const duration = (await probe(source)).duration
    // Every 0.25 s over the first and last 2 s (design 08 二).
    const times = [...Array.from({ length: 8 }, (_, i) => i * 0.25), ...Array.from({ length: 8 }, (_, i) => Math.max(0, duration - 2 + i * 0.25))]
    const pictures = await stills(source, times, join(work(store, scope, run.id), 'stills'))
    const lines = [...tl.lines].sort((a, b) => a.start - b.start)
    const result = await env.vision({
      card: CARDS.trim!,
      sections: [
        { title: '这一段', body: `${duration.toFixed(2)} 秒${segment.continues ? `，承接上一段：开头 ${REPLAY.toFixed(2)} 秒是重放的上一段末尾` : '，不承接上一段'}` },
        { title: '台词时间（计划）', body: lines.map(l => `${l.speaker}：第 ${l.start} 秒到第 ${l.end} 秒`).join('\n') || '没有台词' },
        { title: '抽帧', body: times.map((t, i) => `第 ${i + 1} 张：${t.toFixed(2)} 秒`).join('\n') },
      ],
      images: pictures,
      data: { seconds: duration },
      tag: `trim-${scope.replaceAll('/', '-')}-${run.id}`,
      nodeRunId: run.id,
    })
    const asked = result.output as TrimT
    const t = clampTrim(asked, { duration, continues: segment.continues, firstLine: lines[0]?.start, lastLineEnd: lines.at(-1)?.end })
    return [store.addArtifact({ kind: 'trim', scope, payload: { ...t, reason: asked.reason, asked: { in: asked.in, out: asked.out } }, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/** Every segment's clip of `kind` and its trim, in order, once all are locked. */
function allClips(store: Store, kind: 'clip_draft' | 'clip_final') {
  const segments = planOf(store)?.plan.segments ?? []
  const clips = segments.map(s => ({ segment: s, clip: store.locked(kind, segmentScope(s.id)), trim: store.locked('trim', segmentScope(s.id)) }))
  return clips.length && clips.every(c => c.clip && c.trim) ? clips.map(c => ({ segment: c.segment, clip: c.clip!, trim: c.trim! })) : undefined
}

/** Cuts every clip by its trim, joins them and times the subtitles on the joined speech. */
async function assemble(env: Env, clips: NonNullable<ReturnType<typeof allClips>>, dir: string) {
  const { store } = env
  const parts: string[] = []
  const planned: { text: string; start: number; end: number }[] = []
  let offset = 0
  for (const [i, c] of clips.entries()) {
    const t = c.trim.payload as TrimT
    const part = join(dir, `part-${String(i).padStart(2, '0')}.mp4`)
    await cut(store.mediaPath(c.clip.media_id!), t.in, t.out, part)
    parts.push(part)
    for (const l of (timelineOf(store, c.segment.id)!.payload as TimelineT).lines) planned.push({ text: l.text, start: offset + Math.max(0, l.start - t.in), end: offset + Math.max(0, l.end - t.in) })
    offset += t.out - t.in
  }
  planned.sort((a, b) => a.start - b.start)
  const joined = join(dir, 'joined.mp4')
  await concat(parts, joined)
  return { joined, cues: align(planned, await (env.listen ?? transcribe)(joined, join(dir, 'asr'))) }
}

/**
 * Burns the subtitles (laid out for the frame after `frame` filters, e.g. a crop) and then the
 * `overlay` filters into `source`; `audio` are the output's audio arguments.
 */
async function burn(source: string, cues: Cue[], dest: string, o: { frame?: string[]; size?: [number, number]; overlay?: string[]; audio: string[] }) {
  const info = await probe(source)
  const [width, height] = o.size ?? [info.width, info.height]
  const subs = `${dest}.ass`
  writeFileSync(subs, ass(cues, width, height, 'Hiragino Sans GB'))
  const filters = [...(o.frame ?? []), `subtitles=${subs.replace(/([:\\'])/g, '\\$1')}`, ...(o.overlay ?? [])]
  await ffmpeg(['ffmpeg', '-v', 'error', '-y', '-i', source, '-vf', filters.join(','), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(FPS), ...o.audio, dest])
}

const cutDraft: NodeDef = {
  name: 'cut_draft',
  pool: 'edit',
  output: 'cut_draft',
  review: 8,
  scopes: store => (planOf(store) ? [EPISODE] : []),
  ready(store): Ready {
    const clips = allClips(store, 'clip_draft')
    return clips ? { ok: true, inputs: clips.flatMap(c => [c.clip.id, c.trim.id]) } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const clips = allClips(store, 'clip_draft')!
    const dir = work(store, scope, run.id)
    const { joined, cues } = await assemble(env, clips, dir)
    const out = join(dir, 'cut-draft.mp4')
    await burn(joined, cues, out, { audio: ['-c:a', 'copy'] })
    const info = await probe(out)
    const media = store.putMedia(readFileSync(out), 'video/mp4', { width: info.width, height: info.height, duration_s: info.duration, has_audio: info.hasAudio })
    const adjusted = clips.filter(c => (c.trim.payload as { adjusted?: boolean }).adjusted).map(c => c.segment.id)
    return [store.addArtifact({ kind: 'cut_draft', scope, payload: { cues, unmeasured: cues.filter(c => !c.measured).map(c => c.text), adjusted }, media_id: media, inputs, node_run_id: run.id, created_by: 'program' }).id]
  },
}

const refine: NodeDef = {
  name: 'refine',
  pool: 'video',
  output: 'clip_final',
  paid: { pool: 'video', count: 1 },
  scopes: draft.scopes,
  ready(store, scope): Ready {
    const cutD = store.locked('cut_draft', EPISODE)
    const clip = store.locked('clip_draft', scope)
    const t = store.locked('trim', scope)
    const segment = segmentOf(store, scope)
    if (!cutD || !clip || !t || !segment) return { ok: false }
    const prev = previousOf(store, segment)
    const before = prev ? [store.locked('clip_final', segmentScope(prev.id)), store.locked('trim', segmentScope(prev.id))] : []
    if (before.some(a => !a)) return { ok: false }
    return { ok: true, inputs: [cutD.id, clip.id, t.id, ...before.map(a => a!.id)] }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    if (!e.gpu) throw new Error('没有配置 GPU')
    const segment = segmentOf(e.store, scope)!
    const made = segmentInputs(e.store, segment)
    if (!made) throw new Error(`${scope} 的参考图或音色不全`)
    const clip = e.store.artifact(inputs[1]!)
    const prev = previousOf(e.store, segment)
    // Design 07 二: the refine of a continuing segment is guided by the previous segment's refined tail.
    const guide = prev ? await guideClip(e.store, e.store.locked('clip_final', segmentScope(prev.id))!, e.store.locked('trim', segmentScope(prev.id))!, work(e.store, scope, run.id)) : undefined
    const { request } = segmentRequest(e, segment, made, run.id, (clip.payload as { seed: number }).seed, true, guide)
    const made2 = await video(e.store, e.gpu.client, e.gpu.profile, request, e.sleep)
    return [e.store.addArtifact({ kind: 'clip_final', scope, payload: { job_id: made2.job, prompt: request.prompt, seed: request.seed, guide: guide ?? null }, media_id: made2.media, inputs, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/** GB 45438-2025's implicit label, as the old project's deliver.py wrote it. */
function aigcLabel(produceId: string) {
  return JSON.stringify({ Label: '1', ContentProducer: 'yanxiang-self-hosted-MiniMax-H3', ProduceID: produceId, ReservedCode1: '', ContentPropagator: '', PropagateID: '', ReservedCode2: '' })
}

/** Design 08 六; every check is reported, none blocks delivery. Black and silence limits are guesses. */
export function deliveryChecks(p: { width: number; height: number; fps: number; vcodec: string; acodec: string | null; duration: number; loudness: number; black: [number, number][]; silence: [number, number][]; size: [number, number]; seconds: [number, number]; unmeasured: string[] }) {
  return [
    { check: '分辨率', ok: p.width === p.size[0] && p.height === p.size[1], detail: `${p.width}×${p.height}，要 ${p.size[0]}×${p.size[1]}` },
    { check: '帧率、编码', ok: Math.abs(p.fps - FPS) < 0.01 && p.vcodec === 'h264' && p.acodec === 'aac', detail: `${p.fps.toFixed(2)} 帧/秒，${p.vcodec}，${p.acodec}` },
    { check: '总时长', ok: p.duration >= p.seconds[0] && p.duration <= p.seconds[1], detail: `${p.duration.toFixed(1)} 秒，要 ${p.seconds[0]}–${p.seconds[1]} 秒` },
    { check: '黑场', ok: !p.black.length, detail: p.black.length ? p.black.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} 秒`).join('、') : '没有超过 0.5 秒的黑场' },
    { check: '静音', ok: !p.silence.length, detail: p.silence.length ? p.silence.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} 秒`).join('、') : '没有超过 3 秒的静音' },
    { check: '响度', ok: Math.abs(p.loudness + 15) <= 1, detail: `${p.loudness.toFixed(1)} LKFS，要 -15 ± 1` },
    { check: '字幕', ok: !p.unmeasured.length, detail: p.unmeasured.length ? `这几句没从声音里找到，用的计划时间：${p.unmeasured.join(' / ')}` : '每句都按声音对上了时间' },
  ]
}

const cutFinal: NodeDef = {
  name: 'cut_final',
  pool: 'edit',
  output: 'cut_final',
  review: 9,
  scopes: cutDraft.scopes,
  ready(store): Ready {
    const cutD = store.locked('cut_draft', EPISODE)
    const clips = allClips(store, 'clip_final')
    return cutD && clips ? { ok: true, inputs: [cutD.id, ...clips.flatMap(c => [c.clip.id, c.trim.id])] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const project = store.project()
    const clips = allClips(store, 'clip_final')!
    const dir = work(store, scope, run.id)
    const { joined, cues } = await assemble(env, clips, dir)
    // Design 08 三: 1920×1088 is cropped to 1080 without scaling; 720p is that crop scaled down.
    const size: [number, number] = project.delivery === '1080p' ? [1920, 1080] : [1280, 720]
    const frame = ['crop=1920:1080:0:4', ...(project.delivery === '720p' ? ['scale=1280:720'] : [])]
    const m = await loudness(joined)
    const font = FONT
    if (!font) throw new Error('找不到中文字体，画不了「AI生成」')
    const notice = `drawtext=fontfile='${font}':text='AI生成':fontsize=${Math.ceil(size[1] * 0.06)}:fontcolor=white:borderw=3:bordercolor=black@0.8:x=w-tw-${Math.ceil(size[1] * 0.03)}:y=${Math.ceil(size[1] * 0.03)}:enable='between(t,0,2)'`
    const out = join(dir, '成片.mp4')
    const produceId = `yanxiang-${run.id}-${Date.now()}`
    await burn(joined, cues, out, {
      frame, size, overlay: [notice],
      audio: [
        // Design 08 五: the second loudnorm pass, from the first pass's measurement.
        '-af', `loudnorm=I=-15:TP=-1:LRA=11:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true`,
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-map_metadata', '-1', '-metadata', `comment=${aigcLabel(produceId)}`, '-movflags', '+faststart',
      ],
    })
    const info = await probe(out)
    const { black, silence } = await gaps(out, 0.5, 3)
    const checks = deliveryChecks({ ...info, loudness: (await loudness(out)).I, black, silence, size, seconds: [project.seconds_min, project.seconds_max], unmeasured: cues.filter(c => !c.measured).map(c => c.text) })
    const media = store.putMedia(readFileSync(out), 'video/mp4', { width: info.width, height: info.height, duration_s: info.duration, has_audio: info.hasAudio })
    // Design 08 七: the delivery folder.
    const folder = join(store.dir, '交付', '第1集')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '成片.mp4'), readFileSync(out))
    writeFileSync(join(folder, '字幕.ass'), readFileSync(`${out}.ass`))
    writeFileSync(join(folder, '剧本.json'), JSON.stringify(episode(store)!.script.payload, null, 2))
    writeFileSync(join(folder, '交付检查.json'), JSON.stringify(checks, null, 2))
    return [store.addArtifact({ kind: 'cut_final', scope, payload: { cues, checks, folder, label: aigcLabel(produceId) }, media_id: media, inputs, node_run_id: run.id, created_by: 'program' }).id]
  },
}

export const VIDEO_NODES: NodeDef[] = [audition, voice, draft, trim, cutDraft, refine, cutFinal]
