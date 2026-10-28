import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { imagePrompt, type ImageType } from '../compose.js'
import { image } from '../jobs/images.js'
import type { Plugin } from '../plugins.js'
import type { Section } from '../runner.js'
import type { Artifact, NodeRun, Store } from '../store/store.js'
import { CARDS, setupSection, type CharacterData, type ScriptT } from '../tasks.js'
import type { Env, NodeDef, Ready } from './engine.js'

type Roster = ScriptT['roster']
type Kind = 'char' | 'loc' | 'prop'
export const EPISODE = 'e1'
const TASK = { char: 'character-design', loc: 'location-design', prop: 'prop-design' } as const
const DESC = { char: 'portrait-desc', loc: 'location-desc', prop: 'prop-desc' } as const
const PICTURE: Record<Kind, ImageType> = { char: 'portrait', loc: 'location', prop: 'prop-sheet' }
/** Aspect per kind of picture; guesses (a full figure is tall, sheets and scenes are wide). */
const ASPECT: Record<ImageType, string> = { portrait: '2:3', turnaround: '16:9', face: '1:1', 'prop-sheet': '16:9', location: '16:9', 'location-view': '16:9', keyframe: '16:9', outfit: '16:9' }
export const imageParams = (type: ImageType) => ({ resolution: '1K', quality: 'medium', n: 1, aspect_ratio: ASPECT[type] })
/** Two candidates per root picture (design 06); a guess. */
const CANDIDATES = 2
export const DERIVED = { 三视图: 'turnaround', 脸部特写: 'face', 服装平铺: 'outfit' } as const
type Derived = keyof typeof DERIVED

export type EntityEnv = Env & { style: Plugin }

export const scopeOf = (kind: Kind, name: string) => `${EPISODE}/${kind}/${name}`
const COSTUME = '造型'
/** A costume changed into after the opening one: its own design and portrait, drawn from the opening portrait. */
export const costumeScope = (name: string, costume: string) => `${scopeOf('char', name)}/${COSTUME}/${costume}`
export const parse = (scope: string) => {
  const [, kind, name, ...rest] = scope.split('/') as [string, Kind, string, ...string[]]
  const costume = kind === 'char' && rest[0] === COSTUME ? rest[1] : undefined
  return { kind, name, costume, derived: costume ? rest[2] : rest[0] }
}
/** The scope whose design a picture was drawn from: the entity or the costume, without a derived picture or view. */
export function designScope(scope: string) {
  const { kind, name, costume } = parse(scope)
  return costume ? costumeScope(name, costume) : scopeOf(kind, name)
}
export const text = (a: Artifact) => (a.payload as { text: string }).text
export const lines = (t: string) => t.split('\n').map(l => l.trim()).filter(Boolean)
export const pick = (t: string, key: string) => lines(t).filter(l => l.startsWith(`${key}：`)).join('\n')

export function episode(store: Store) {
  const script = store.locked('script', EPISODE)
  const roster = store.locked('roster', EPISODE)
  if (!script || !roster) return undefined
  const beats = (script.payload as Pick<ScriptT, 'scenes'>).scenes.flatMap(scene => scene.beats.map(beat => ({ ...beat, location: scene.location })))
  return { script, roster: roster.payload as Roster, rosterId: roster.id, beats, scenes: (script.payload as Pick<ScriptT, 'scenes'>).scenes }
}

export function names(store: Store, kind: Kind): string[] {
  const ep = episode(store)
  if (!ep) return []
  return kind === 'char' ? ep.roster.characters.map(c => c.name) : kind === 'loc' ? ep.roster.locations.map(l => l.name) : ep.roster.props.map(p => p.name)
}

type Person = Roster['characters'][number]
/** Rosters stored before 2026-10-28 have no count and no costumes. */
export const headcount = (p: Person) => p.count ?? 1
export const costumesOf = (p: Person) => p.costumes ?? []
export const personOf = (store: Store, name: string) => episode(store)!.roster.characters.find(c => c.name === name)!
const people = (store: Store) => episode(store)?.roster.characters ?? []
/** The opening look and each costume changed into. */
export const looks = (p: Person) => [scopeOf('char', p.name), ...costumesOf(p).map(c => costumeScope(p.name, c.name))]

/**
 * Pictures derived from a look. A name standing for several people is bound by its costume's flat
 * lay only (review 01-14: a shared portrait brings one face to all of them). A later costume needs
 * its three-view for backs; the face close-up is the opening one's.
 */
export function derivedOf(p: Person, look: string): Derived[] {
  if (headcount(p) > 1) return ['服装平铺']
  return parse(look).costume ? ['三视图'] : ['三视图', '脸部特写']
}

/** Beats a person is in: named in the action, speaking, or spoken of. */
const appearsIn = (beat: { action: string; lines: { speaker: string; text: string }[] }, name: string) =>
  beat.action.includes(name) || beat.lines.some(l => l.speaker === name || l.text.includes(name))

/** The look a person wears at a beat: the last costume put on by then, else the opening one. */
export function lookAt(store: Store, name: string, beatId: string): string {
  const ids = episode(store)!.beats.map(b => b.id)
  const worn = costumesOf(personOf(store, name)).filter(c => ids.indexOf(c.from) <= ids.indexOf(beatId)).at(-1)
  return worn ? costumeScope(name, worn.name) : scopeOf('char', name)
}

/**
 * The picture that stands for a person from a beat on, in the look worn then: a group's flat lay;
 * else the turnaround when seen from behind (creator, 2026-10-28), else the portrait.
 */
export function figureAt(store: Store, name: string, beatId: string, back: boolean) {
  const look = lookAt(store, name, beatId)
  const count = headcount(personOf(store, name))
  const { costume } = parse(look)
  const as: Derived | undefined = count > 1 ? '服装平铺' : back ? '三视图' : undefined
  const scope = as ? `${look}/${as}` : look
  const label = count > 1 ? `${name}的服装平铺（${count} 个人都穿这一套，脸和身形各不相同）` : `${name}${costume ? `（${costume}）` : ''}的${back ? '三视图' : '定妆照'}`
  return { look, scope, label, picture: lockedImage(store, scope), outfit: count > 1 ? count : undefined, turnaround: as === '三视图', costume }
}

export function fmtBeats(store: Store, ids: string[]) {
  const ep = episode(store)!
  return ep.beats.filter(b => ids.includes(b.id)).map(b => [`${b.id}（${b.location}，约 ${b.seconds} 秒）${b.action}`, ...b.lines.map(l => `  ${l.speaker}${l.vo ? '（画外音）' : ''}：${l.text}`), ...(b.changes.length ? [`  状态变化：${b.changes.join('；')}`] : [])].join('\n')).join('\n')
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

async function write(env: Env, task: string, scope: string, run: NodeRun, sections: Section[], inputs: number[], kind: string, data?: unknown): Promise<number[]> {
  const result = await env.text({ card: CARDS[task]!, sections: [...sections, ...revision(env.store, run)], data, tag: `${task}-${scope.replaceAll('/', '-')}-${run.id}`, nodeRunId: run.id })
  return [env.store.addArtifact({ kind, scope, payload: { text: result.output as string }, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
}

const brief: NodeDef = {
  name: 'brief',
  pool: 'text',
  output: 'entity_brief',
  review: 4,
  scopes: store => [...people(store).flatMap(looks), ...(['loc', 'prop'] as Kind[]).flatMap(kind => names(store, kind).map(name => scopeOf(kind, name)))],
  ready(store, scope): Ready {
    const ep = episode(store)
    if (!ep) return { ok: false }
    const { kind, name, costume } = parse(scope)
    // A later costume copies the face and build of the opening design, once that is approved.
    if (costume) {
      const opening = store.locked('entity_brief', scopeOf('char', name))
      return opening ? { ok: true, inputs: [ep.script.id, ep.rosterId, opening.id] } : { ok: false }
    }
    // Each kind is designed in order, each seeing the ones before it; a location also waits for its props (lock order: props before locations).
    const before = names(store, kind).slice(0, names(store, kind).indexOf(name)).map(n => scopeOf(kind, n))
    const props = kind === 'loc' ? propsAt(store, name).map(p => scopeOf('prop', p.name)) : []
    const needed = [...before, ...props].map(s => store.latest('entity_brief', s, ['draft', 'locked']))
    if (needed.some(a => !a)) return { ok: false }
    // The episode setup is written before the script; a hand-written script (the first M1 sample) has none.
    const setup = kind === 'loc' ? store.locked('setup', EPISODE) : undefined
    return { ok: true, inputs: [ep.script.id, ep.rosterId, ...needed.map(a => a!.id), ...(setup ? [setup.id] : [])] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const ep = episode(store)!
    const { kind, name, costume } = parse(scope)
    const briefs = inputs.slice(2).map(id => store.artifact(id)).filter(a => a.kind === 'entity_brief')
    const earlier = briefs.filter(a => parse(a.scope).kind === kind)
    let sections: Section[]
    let data: CharacterData | undefined
    if (kind === 'char') {
      const person = personOf(store, name)
      const others = ep.roster.props.filter(p => !p.holder.includes(name))
      data = { others: others.map(p => ({ name: p.name, holder: p.holder })) }
      const card = [
        { title: '人物卡', body: `${person.name}：${person.gender}，看起来${person.age_look.replace(/^看起来/, '')}，${person.rank}，${person.tier}；本集要${person.needs.replace(/^本集要/, '')}；${person.temperament}` },
        { title: '剧本里写到他外貌的原句', body: person.appearance_lines.join('\n') },
      ]
      const props = [
        // Names only: a holder is how the prop changes hands over the episode, which is no part of a costume.
        { title: '和他有关的道具', body: ep.roster.props.filter(p => p.holder.includes(name)).map(p => p.name).join('、') },
        { title: '本集其他人的道具', body: others.map(p => p.name).join('、') },
      ]
      if (costume) {
        const all = costumesOf(person)
        const index = all.findIndex(c => c.name === costume)
        const ids = ep.beats.map(b => b.id)
        const until = all[index + 1]?.from
        const worn = ep.beats.slice(ids.indexOf(all[index]!.from), until ? ids.indexOf(until) : undefined).filter(b => appearsIn(b, name))
        sections = [
          ...card,
          { title: '这一套造型', body: `${costume}：从 ${all[index]!.from} 起穿，${until ? `到 ${until} 换下` : '一直穿到本集结束'}` },
          { title: '穿这套的剧情', body: fmtBeats(store, worn.map(b => b.id)) },
          { title: '他开场那一套', body: text(briefs[0]!) },
          ...props,
        ]
      } else {
        sections = [
          ...card,
          ...props,
          { title: '同集其他人物', body: earlier.map(a => `${parse(a.scope).name}：${[pick(text(a), '主色').replace('主色：', '主色 '), pick(text(a), '区分').replace('区分：', ''), pick(text(a), '身高').replace('身高：', '身高 ')].filter(Boolean).join('；')}`).join('\n') },
        ]
      }
    } else if (kind === 'loc') {
      // The sections and their wording are the ones the location experiments ran with (src/m0/chain.ts, runs/ab-story).
      const place = ep.roster.locations.find(l => l.name === name)!
      const setup = store.locked('setup', EPISODE)
      sections = [
        { title: '地点', body: name },
        { title: '本集设定里的世界和地点', body: setup ? [setupSection(text(setup), '世界一角'), setupSection(text(setup), '地点')].join('\n\n') : '' },
        { title: '剧本里这个地点的环境', body: ep.scenes.filter(scene => scene.location === name).map(scene => scene.setting ?? '').join('\n') },
        { title: '在这里发生的剧情', body: fmtBeats(store, place.beats) },
        { title: '场内的关键道具', body: propsAt(store, name).map(p => `${p.name}：${p.holder}`).join('\n') },
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
    return write(env, TASK[kind], scope, run, sections, inputs, 'entity_brief', data)
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
export async function draw(env: EntityEnv, scope: string, run: NodeRun, inputs: number[], type: ImageType, body: string, refs: { label: string; media: number }[], count: number, kind = 'entity_image', extra: object = {}): Promise<number[]> {
  if (!env.images) throw new Error('没有配置出图服务')
  const prompt = imagePrompt(env.root, env.style, type, body, refs.map(r => r.label))
  const drawn = await Promise.all(Array.from({ length: count }, (_, k) =>
    image(env.store, env.images!, { type, prompt, params: imageParams(type), references: refs.map(r => r.media), node_run_id: run.id, candidate: k + 1 }, env.sleep)))
  return env.store.tx(() => drawn.map(d => env.store.addArtifact({ kind, scope, payload: { job_id: d.job, prompt, ...extra }, media_id: d.media, inputs, node_run_id: run.id, created_by: 'model' }).id))
}

/** What a note on one candidate leaves as it was, per kind; the wording follows the three-view's 「都和参考图一致，不重新设计」. */
const KEEP: Record<Kind, string> = { char: '脸、发型、服装、饰物、颜色、身形和构图', loc: '陈设、布局、光线、颜色和构图', prop: '形制、材质、纹样、颜色和构图' }

/** What a root picture is drawn from besides its description, as the prompt names them. */
function pictureLabels(store: Store, scope: string): string[] {
  const { kind, name, costume } = parse(scope)
  if (costume) return [`${name}的定妆照`]
  if (kind !== 'loc') return []
  return ['风格参考图', ...placedProps(store, name, text(store.locked('entity_brief', scope)!)).map(p => `${p}的设定图`)]
}

function pictureBody(root: string, scope: string, desc: string): string {
  const { name, costume } = parse(scope)
  return costume ? `${readFileSync(join(root, 'config/prompts/costume.md'), 'utf8').trim().replaceAll('{{name}}', name)}\n\n${desc}` : desc
}

/** The prompt a root picture would be drawn with from this description, for the creator to read before paying for it. */
export function picturePrompt(env: EntityEnv, scope: string, desc: string): string {
  return imagePrompt(env.root, env.style, PICTURE[parse(scope).kind], pictureBody(env.root, scope, desc), pictureLabels(env.store, scope))
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
  paid: { pool: 'image', count: CANDIDATES },
  reviseVia: (store, a) => store.locked('entity_desc', a.scope),
  edits: true,
  scopes: brief.scopes,
  ready(store, scope): Ready {
    const d = store.locked('entity_desc', scope)
    if (!d) return { ok: false }
    const { kind, name, costume } = parse(scope)
    // One group, one root (design 06): a later costume is drawn from the opening portrait.
    if (costume) {
      const opening = lockedImage(store, scopeOf('char', name))
      return opening ? { ok: true, inputs: [d.id, opening.lock.id] } : { ok: false }
    }
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
    const { kind, costume } = parse(scope)
    const lockedMedia = (id: number) => e.store.artifact((e.store.artifact(id).payload as { image_id: number }).image_id).media_id!
    // In the order of pictureLabels: the opening portrait, or the style picture and the placed props (ready's inputs).
    const media = costume ? [lockedMedia(inputs[1]!)] : kind !== 'loc' ? [] : [styleRefMedia(e), ...inputs.slice(2).map(lockedMedia)]
    const refs = pictureLabels(e.store, scope).map((label, i) => ({ label, media: media[i]! }))
    const body = pictureBody(e.root, scope, text(e.store.artifact(inputs[0]!)))
    if (!run.instruction) return draw(e, scope, run, inputs, PICTURE[kind], body, refs, CANDIDATES)
    // The creator's note on one candidate (Engine.edit): drawn from that candidate, which goes into the review beside the new ones.
    const from = e.store.artifact(run.previous_id!)
    const edit = readFileSync(join(e.root, 'config/prompts/image-edit.md'), 'utf8').trim().replace('{{instruction}}', run.instruction).replace('{{keep}}', KEEP[kind])
    const drawn = await draw(e, scope, run, inputs, PICTURE[kind], edit, [{ label: '要改的这张图', media: from.media_id! }, ...refs], CANDIDATES, 'entity_image', { edited_from: from.id, instruction: run.instruction })
    return from.status === 'draft' ? [from.id, ...drawn] : drawn
  },
}

const derive: NodeDef = {
  name: 'derive',
  pool: 'image',
  output: 'entity_image',
  review: 5,
  paid: { pool: 'image', count: 1 },
  scopes: store => people(store).flatMap(p => looks(p).flatMap(look => derivedOf(p, look).map(d => `${look}/${d}`))),
  ready(store, scope) {
    const root = lockedImage(store, designScope(scope))
    return root ? { ok: true, inputs: [root.lock.id] } : { ok: false }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    const { name, costume, derived } = parse(scope)
    const root = e.store.artifact((e.store.artifact(inputs[0]!).payload as { image_id: number }).image_id)
    return draw(e, scope, run, inputs, DERIVED[derived as Derived], '', [{ label: `${name}${costume ? `（${costume}）` : ''}的定妆照`, media: root.media_id! }], 1)
  },
}

export const ENTITY_NODES: NodeDef[] = [brief, desc, picture, derive]
