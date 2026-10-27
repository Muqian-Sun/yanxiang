import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { imagePrompt, type ImageType } from '../compose.js'
import { image } from '../jobs/images.js'
import type { Plugin } from '../plugins.js'
import type { Section } from '../runner.js'
import type { Artifact, NodeRun, Store } from '../store/store.js'
import { CARDS, type ScriptT } from '../tasks.js'
import type { Env, NodeDef, Ready } from './engine.js'

type Roster = ScriptT['roster']
type Kind = 'char' | 'loc' | 'prop'
export const EPISODE = 'e1'
const TASK = { char: 'character-design', loc: 'location-design', prop: 'prop-design' } as const
const DESC = { char: 'portrait-desc', loc: 'location-desc', prop: 'prop-desc' } as const
const PICTURE: Record<Kind, ImageType> = { char: 'portrait', loc: 'location', prop: 'prop-sheet' }
/** Aspect per kind of picture; guesses (a full figure is tall, sheets and scenes are wide). */
const ASPECT: Record<ImageType, string> = { portrait: '2:3', turnaround: '16:9', face: '1:1', 'prop-sheet': '16:9', location: '16:9', 'location-view': '16:9', keyframe: '16:9' }
export const imageParams = (type: ImageType) => ({ resolution: '1K', quality: 'medium', n: 1, aspect_ratio: ASPECT[type] })
/** Two candidates per root picture (design 06); a guess. */
const CANDIDATES = 2
export const DERIVED = { 三视图: 'turnaround', 脸部特写: 'face' } as const

export type EntityEnv = Env & { style: Plugin }

export const scopeOf = (kind: Kind, name: string) => `${EPISODE}/${kind}/${name}`
export const parse = (scope: string) => {
  const [, kind, name, derived] = scope.split('/') as [string, Kind, string, string | undefined]
  return { kind, name, derived }
}
export const text = (a: Artifact) => (a.payload as { text: string }).text
export const lines = (t: string) => t.split('\n').map(l => l.trim()).filter(Boolean)
export const pick = (t: string, key: string) => lines(t).filter(l => l.startsWith(`${key}：`)).join('\n')

export function episode(store: Store) {
  const script = store.locked('script', EPISODE)
  const roster = store.locked('roster', EPISODE)
  if (!script || !roster) return undefined
  const beats = (script.payload as Pick<ScriptT, 'scenes'>).scenes.flatMap(scene => scene.beats.map(beat => ({ ...beat, location: scene.location })))
  return { script, roster: roster.payload as Roster, rosterId: roster.id, beats }
}

export function names(store: Store, kind: Kind): string[] {
  const ep = episode(store)
  if (!ep) return []
  return kind === 'char' ? ep.roster.characters.map(c => c.name) : kind === 'loc' ? ep.roster.locations.map(l => l.name) : ep.roster.props.map(p => p.name)
}

export function fmtBeats(store: Store, ids: string[]) {
  const ep = episode(store)!
  return ep.beats.filter(b => ids.includes(b.id)).map(b => [`${b.id}（${b.location}，约 ${b.seconds} 秒）${b.action}`, ...b.lines.map(l => `  ${l.speaker}：${l.text}`), ...(b.changes.length ? [`  状态变化：${b.changes.join('；')}`] : [])].join('\n')).join('\n')
}

/** Props used in the location's beats. */
function propsAt(store: Store, location: string): Roster['props'] {
  const ep = episode(store)!
  const here = ep.roster.locations.find(l => l.name === location)!.beats
  return ep.roster.props.filter(p => p.beats.some(b => here.includes(b)))
}

/** Props the location's appearance brief actually places in the scene; carried ones it leaves out. */
function placedProps(store: Store, location: string, brief: string): string[] {
  return propsAt(store, location).filter(p => brief.includes(p.name)).map(p => p.name)
}

/** A rerun for the creator's instruction sees the version it replaces and what to change. */
export function revision(store: Store, run: NodeRun, body: (a: Artifact) => string = text): Section[] {
  if (!run.instruction) return []
  const previous = run.previous_id ? store.artifact(run.previous_id) : undefined
  return [{ title: '上一版', body: previous ? body(previous) : '' }, { title: '创作者的修改意见', body: run.instruction }]
}

async function write(env: Env, task: string, scope: string, run: NodeRun, sections: Section[], inputs: number[], kind: string): Promise<number[]> {
  const result = await env.text({ card: CARDS[task]!, sections: [...sections, ...revision(env.store, run)], tag: `${task}-${scope.replaceAll('/', '-')}-${run.id}`, nodeRunId: run.id })
  return [env.store.addArtifact({ kind, scope, payload: { text: result.output as string }, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
}

const brief: NodeDef = {
  name: 'brief',
  pool: 'text',
  output: 'entity_brief',
  review: 4,
  scopes: store => (['char', 'loc', 'prop'] as Kind[]).flatMap(kind => names(store, kind).map(name => scopeOf(kind, name))),
  ready(store, scope): Ready {
    const ep = episode(store)
    if (!ep) return { ok: false }
    const { kind, name } = parse(scope)
    // Each kind is designed in order, each seeing the ones before it; a location also waits for its props (lock order: props before locations).
    const before = names(store, kind).slice(0, names(store, kind).indexOf(name)).map(n => scopeOf(kind, n))
    const props = kind === 'loc' ? propsAt(store, name).map(p => scopeOf('prop', p.name)) : []
    const needed = [...before, ...props].map(s => store.latest('entity_brief', s, ['draft', 'locked']))
    if (needed.some(a => !a)) return { ok: false }
    return { ok: true, inputs: [ep.script.id, ep.rosterId, ...needed.map(a => a!.id)] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const ep = episode(store)!
    const { kind, name } = parse(scope)
    const briefs = inputs.slice(2).map(id => store.artifact(id))
    const earlier = briefs.filter(a => parse(a.scope).kind === kind)
    let sections: Section[]
    if (kind === 'char') {
      const person = ep.roster.characters.find(c => c.name === name)!
      sections = [
        { title: '人物卡', body: `${person.name}：${person.gender}，看起来${person.age_look.replace(/^看起来/, '')}，${person.rank}，${person.tier}；本集要${person.needs.replace(/^本集要/, '')}；${person.temperament}` },
        { title: '剧本里写到他外貌的原句', body: person.appearance_lines.join('\n') },
        { title: '和他有关的道具', body: ep.roster.props.filter(p => p.holder.includes(name)).map(p => `${p.name}：${p.holder}`).join('\n') },
        { title: '同集其他人物', body: earlier.map(a => `${parse(a.scope).name}：${pick(text(a), '主色').replace('主色：', '主色 ')}；${pick(text(a), '区分').replace('区分：', '')}`).join('\n') },
      ]
    } else if (kind === 'loc') {
      const place = ep.roster.locations.find(l => l.name === name)!
      const props = briefs.filter(a => parse(a.scope).kind === 'prop')
      sections = [
        { title: '地点', body: name },
        { title: '在这里发生的剧情', body: fmtBeats(store, place.beats) },
        { title: '场内的关键道具', body: props.map(a => `${parse(a.scope).name}（${ep.roster.props.find(p => p.name === parse(a.scope).name)!.holder}）\n${text(a)}`).join('\n\n') },
        { title: '已设计的地点', body: earlier.map(a => `${parse(a.scope).name}\n${text(a)}`).join('\n\n') },
      ]
    } else {
      const prop = ep.roster.props.find(p => p.name === name)!
      sections = [
        { title: '道具', body: name },
        { title: '持有人', body: prop.holder },
        { title: '用到它的剧情', body: fmtBeats(store, prop.beats) },
        { title: '已设计的道具', body: earlier.map(a => `${parse(a.scope).name}\n${text(a)}`).join('\n\n') },
      ]
    }
    return write(env, TASK[kind], scope, run, sections, inputs, 'entity_brief')
  },
}

const desc: NodeDef = {
  name: 'desc',
  pool: 'text',
  output: 'entity_desc',
  scopes: brief.scopes,
  ready(store, scope) {
    const b = store.locked('entity_brief', scope)
    return b ? { ok: true, inputs: [b.id] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const { kind, name } = parse(scope)
    const b = text(env.store.artifact(inputs[0]!))
    const sections: Section[] = [{ title: '外观要点', body: lines(b).filter(l => !l.startsWith('区分：')).join('\n') }]
    if (kind === 'loc') sections.push({ title: '场内的关键道具（照参考图画）', body: placedProps(env.store, name, b).join('、') })
    return write(env, DESC[kind], scope, run, sections, inputs, 'entity_desc')
  },
}

export function styleRefMedia(env: EntityEnv): number {
  if (!env.style.styleRef) throw new Error(`画风插件 ${env.style.id} 没有风格参考图`)
  return env.store.putMedia(readFileSync(join(env.style.dir, env.style.styleRef)), 'image/png')
}

/** Draws `count` candidates of one picture and stores them as drafts. */
export async function draw(env: EntityEnv, scope: string, run: NodeRun, inputs: number[], type: ImageType, body: string, refs: { label: string; media: number }[], count: number, kind = 'entity_image'): Promise<number[]> {
  if (!env.images) throw new Error('没有配置出图服务')
  const prompt = imagePrompt(env.root, env.style, type, body, refs.map(r => r.label))
  const drawn = await Promise.all(Array.from({ length: count }, (_, k) =>
    image(env.store, env.images!, { type, prompt, params: imageParams(type), references: refs.map(r => r.media), node_run_id: run.id, candidate: k + 1 }, env.sleep)))
  return env.store.tx(() => drawn.map(d => env.store.addArtifact({ kind, scope, payload: { job_id: d.job, prompt }, media_id: d.media, inputs, node_run_id: run.id, created_by: 'model' }).id))
}

export const lockedImage = (store: Store, scope: string) => {
  const lock = store.locked('entity_lock', scope)
  return lock ? { lock, image: store.artifact((lock.payload as { image_id: number }).image_id) } : undefined
}

const picture: NodeDef = {
  name: 'image',
  pool: 'image',
  output: 'entity_image',
  review: 5,
  images: CANDIDATES,
  scopes: brief.scopes,
  ready(store, scope): Ready {
    const d = store.locked('entity_desc', scope)
    if (!d) return { ok: false }
    const { kind, name } = parse(scope)
    if (kind !== 'loc') return { ok: true, inputs: [d.id] }
    const style = store.locked('style_ref', 'p')
    const b = store.locked('entity_brief', scope)
    if (!style || !b) return { ok: false }
    const props = placedProps(store, name, text(b)).map(p => lockedImage(store, scopeOf('prop', p)))
    if (props.some(p => !p)) return { ok: false }
    return { ok: true, inputs: [d.id, style.id, ...props.map(p => p!.lock.id)] }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    const { kind } = parse(scope)
    const body = text(e.store.artifact(inputs[0]!))
    const refs = kind !== 'loc' ? [] : [
      { label: '风格参考图', media: styleRefMedia(e) },
      ...inputs.slice(2).map(id => {
        const img = e.store.artifact((e.store.artifact(id).payload as { image_id: number }).image_id)
        return { label: `${parse(img.scope).name}的设定图`, media: img.media_id! }
      }),
    ]
    return draw(e, scope, run, inputs, PICTURE[kind], body, refs, CANDIDATES)
  },
}

const derive: NodeDef = {
  name: 'derive',
  pool: 'image',
  output: 'entity_image',
  review: 5,
  images: 1,
  scopes: store => names(store, 'char').flatMap(name => Object.keys(DERIVED).map(d => `${scopeOf('char', name)}/${d}`)),
  ready(store, scope) {
    const { name } = parse(scope)
    const root = lockedImage(store, scopeOf('char', name))
    return root ? { ok: true, inputs: [root.lock.id] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    const { name, derived } = parse(scope)
    const root = e.store.artifact((e.store.artifact(inputs[0]!).payload as { image_id: number }).image_id)
    return draw(e, scope, run, inputs, DERIVED[derived!], '', [{ label: `${name}的定妆照`, media: root.media_id! }], 1)
  },
}

export const ENTITY_NODES: NodeDef[] = [brief, desc, picture, derive]
