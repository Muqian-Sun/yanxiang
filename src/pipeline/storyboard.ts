import { imagePrompt } from '../compose.js'
import { image } from '../jobs/images.js'
import type { Section } from '../runner.js'
import type { Artifact, Store } from '../store/store.js'
import { CARDS, costumeChanges, MAIN_VIEW, voicedPerBeat, type BlockingData, type BlockingT, type PlanData, type PlanT, type TimelineT, type ViewGroupsT } from '../tasks.js'
import type { NodeDef, Ready } from './engine.js'
import {
  EPISODE, episode, figureAt, fmtBeats, imageParams, lockedImage, lookAt, names, pick, revision, scopeOf, styleRefMedia, text,
  type EntityEnv,
} from './entities.js'

type Segment = PlanT['segments'][number]
type Cut = TimelineT['cuts'][number]
type Scene = NonNullable<ReturnType<typeof episode>>['scenes'][number]

const json = (a: Artifact) => JSON.stringify(a.payload, null, 2)
export const segmentScope = (id: string) => `${EPISODE}/${id}`
export const sceneScope = (id: string) => `${EPISODE}/scene/${id}`
/** How a cut is named to the writers, and the tail of its scope. */
export const cutId = (segmentId: string, index: number) => `${segmentId}/c${index}`
export const cutScope = (segmentId: string, index: number) => `${EPISODE}/${cutId(segmentId, index)}`
const viewScope = (location: string, name: string) => `${scopeOf('loc', location)}/${name}`

function parseCut(scope: string) {
  const [ep, segmentId, cut] = scope.split('/') as [string, string, string]
  if (ep !== EPISODE || !segmentId || !cut?.startsWith('c')) throw new Error(`不是切点作用域：${scope}`)
  return { segmentId, cutIndex: Number(cut.slice(1)) }
}

function parseView(scope: string) {
  const [ep, loc, location, name] = scope.split('/')
  if (ep !== EPISODE || loc !== 'loc' || !location || !name) throw new Error(`不是换机位作用域：${scope}`)
  return { location, name }
}

export function planOf(store: Store): { artifact: Artifact; plan: PlanT } | undefined {
  const artifact = store.locked('segment_plan', EPISODE)
  return artifact ? { artifact, plan: artifact.payload as PlanT } : undefined
}

/** Changes accumulated from the script up to, but not including, this beat. */
export function stateBefore(store: Store, beatId: string): string[] {
  const changes: string[] = []
  for (const beat of episode(store)!.beats) {
    if (beat.id === beatId) break
    changes.push(...beat.changes)
  }
  return changes
}

/** The locations a segment's beats are at, in order; a segment can cross scenes (segment plan). */
export function segmentLocations(store: Store, segment: Segment): string[] {
  const beats = episode(store)!.beats.filter(b => segment.beats.includes(b.id))
  return [...new Set([segment.location, ...beats.map(b => b.location)])]
}

/** Where a shot is: its own location when the segment crosses scenes, else the segment's (timelines before 2026-10-28 have none). */
export const cutLocation = (segment: Segment, cut: Cut) => cut.location ?? segment.location

function presentNames(store: Store, segment: Segment): string[] {
  const ep = episode(store)!
  const beats = ep.beats.filter(b => segment.beats.includes(b.id))
  const roster = [...ep.roster.characters.map(c => c.name), ...ep.roster.locations.map(l => l.name), ...ep.roster.props.map(p => p.name)]
  const here = segmentLocations(store, segment)
  return roster.filter(name => here.includes(name) || beats.some(b => b.action.includes(name) || b.lines.some(l => l.speaker === name || l.text.includes(name))))
}

/** Someone is there in a beat when its action names him or he speaks other than off-screen. */
const onStage = (beat: { action: string; lines: { speaker: string; vo?: boolean }[] }, name: string) => beat.action.includes(name) || beat.lines.some(l => l.speaker === name && !l.vo)

/** The beat each person is first on stage in a scene; someone in the scene's setting is there from its first beat. */
function firstOnStage(store: Store, scene: Scene): Record<string, string> {
  return Object.fromEntries(names(store, 'char').flatMap(name => {
    const beat = scene.setting?.includes(name) ? scene.beats[0] : scene.beats.find(b => onStage(b, name))
    return beat ? [[name, beat.id]] : []
  }))
}

/** The scenes a segment's beats are in, in order. */
function scenesOf(store: Store, segment: Segment): Scene[] {
  return episode(store)!.scenes.filter(scene => scene.beats.some(b => segment.beats.includes(b.id)))
}

/** A scene's staging in full, as the creator reviews it. */
export function fmtBlocking(b: BlockingT): string {
  return [
    '位置（画面左右是主图的左右）：',
    ...b.spots.map(s => `${s.name}（${s.kind}）：${s.where}`),
    '',
    '人物：',
    ...b.people.map(p => `${p.from} 起，${p.name}：${p.spot}，${p.pose}；${p.how}`),
  ].join('\n')
}

/** A scene's staging as a segment of it needs it: the places, where everyone is as it opens, and who moves during it. */
function stagingOf(scene: Scene, b: BlockingT, segment: Segment): string {
  const ids = scene.beats.map(x => x.id)
  const open = ids.findIndex(id => segment.beats.includes(id))
  const before = [...new Set(b.people.map(p => p.name))].flatMap(name => {
    const p = b.people.filter(x => x.name === name && ids.indexOf(x.from) < open).at(-1)
    return p ? [`${name}：${p.spot}，${p.pose}`] : []
  })
  const during = b.people.filter(p => segment.beats.includes(p.from)).map(p => `${p.from} 起，${p.name}：${p.spot}，${p.pose}；${p.how}`)
  return [
    `${scene.location}的位置（画面左右是主图的左右）：`,
    ...b.spots.map(s => `${s.name}（${s.kind}）：${s.where}`),
    '这一段开始时：',
    ...(before.length ? before : ['还没有人在场']),
    '这一段里：',
    ...(during.length ? during : ['没有人换位置']),
  ].join('\n')
}

/** The locked staging of every scene a segment is in, or undefined while one is missing. */
function stagings(store: Store, segment: Segment, location?: string) {
  const scenes = scenesOf(store, segment).filter(s => !location || s.location === location)
  const locked = scenes.map(scene => ({ scene, blocking: store.locked('blocking', sceneScope(scene.id)) }))
  return locked.every(s => s.blocking) ? locked.map(s => ({ scene: s.scene, blocking: s.blocking! })) : undefined
}

const layout = (brief: string) => ['格局', '陈设', '道具位置', '门窗外'].map(key => pick(brief, key)).filter(Boolean).join('\n')

function lastCutBlurb(tl: TimelineT): string {
  const cut = tl.cuts.at(-1)!
  return `运镜：${cut.camera}\n镜头：${cut.shot}\n最后一秒：${tl.timeline.at(-1)?.text ?? ''}\n底声：${tl.ambience}`
}

function rootLocks(store: Store): number[] | undefined {
  const scopes = (['char', 'loc', 'prop'] as const).flatMap(kind => names(store, kind).map(name => scopeOf(kind, name)))
  const locks = scopes.map(s => store.locked('entity_lock', s))
  if (locks.some(l => !l)) return undefined
  return locks.map(l => l!.id)
}

/**
 * Cuts that get a keyframe, with their segment and locked timeline. The first cut of a
 * continuing segment is carried by the replayed tail of the previous one (design 07).
 */
function keyframeCuts(store: Store): { segment: Segment; timeline: Artifact; cut: Cut }[] {
  const planned = planOf(store)
  if (!planned) return []
  return planned.plan.segments.flatMap(segment => {
    const timeline = store.locked('timeline', segmentScope(segment.id))
    if (!timeline) return []
    return (timeline.payload as TimelineT).cuts.filter(cut => !(segment.continues && cut.index === 1)).map(cut => ({ segment, timeline, cut }))
  })
}

function cutAt(store: Store, scope: string) {
  const { segmentId, cutIndex } = parseCut(scope)
  const segment = planOf(store)?.plan.segments.find(s => s.id === segmentId)
  const timeline = store.locked('timeline', segmentScope(segmentId))
  const cut = (timeline?.payload as TimelineT | undefined)?.cuts.find(c => c.index === cutIndex)
  return segment && timeline && cut ? { segment, timeline, cut, id: cutId(segmentId, cutIndex) } : undefined
}

/** What has changed by the opening of a cut: the script's changes before its segment, then the timeline's before the cut. */
export function cutState(store: Store, scope: string): string[] | undefined {
  const at = cutAt(store, scope)
  if (!at) return undefined
  return [...stateBefore(store, at.segment.beats[0]!), ...(at.timeline.payload as TimelineT).timeline.filter(e => e.second < at.cut.start).flatMap(e => e.changes)]
}

/** What has changed by the start of a segment. */
export function segmentState(store: Store, scope: string): string[] | undefined {
  const segment = planOf(store)?.plan.segments.find(s => segmentScope(s.id) === scope)
  return segment && stateBefore(store, segment.beats[0]!)
}

/** The picture that stands for a person in a cut, in the costume worn through its segment. */
export function figure(store: Store, segment: Segment, cut: Cut, name: string) {
  // Timelines written before backs existed (2026-10-28) are stored without it.
  return figureAt(store, name, segment.beats[0]!, (cut.present.backs ?? []).includes(name))
}

/** The camera position a cut was grouped into, and the picture standing for it once locked. */
export function viewOf(store: Store, location: string, id: string) {
  const groups = store.locked('view_plan', scopeOf('loc', location))
  const view = (groups?.payload as ViewGroupsT | undefined)?.views.find(v => v.cuts.includes(id))
  if (!groups || !view) return undefined
  const main = view.name === MAIN_VIEW
  return {
    groups,
    label: main ? `${location}的主图` : `${location}的${view.name}`,
    picture: main ? lockedImage(store, scopeOf('loc', location)) : lockedImage(store, viewScope(location, view.name)),
  }
}

const plan: NodeDef = {
  name: 'plan',
  pool: 'text',
  output: 'segment_plan',
  scopes: () => [EPISODE],
  ready(store): Ready {
    const ep = episode(store)
    const locks = rootLocks(store)
    if (!ep || !locks) return { ok: false }
    return { ok: true, inputs: [ep.script.id, ...locks] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const ep = episode(store)!
    const project = store.project()
    const entities = [...names(store, 'char'), ...names(store, 'loc'), ...names(store, 'prop')]
    const changes = costumeChanges(ep.roster)
    const result = await env.text({
      card: CARDS['segment-plan']!,
      sections: [
        { title: '剧本', body: fmtBeats(store, ep.beats.map(b => b.id)) },
        { title: '已定的人物、地点、道具', body: entities.join('、') },
        { title: '地点只能写这些', body: names(store, 'loc').join('、') },
        { title: '换装', body: changes.map(c => `${c.name}从 ${c.from} 起换上${c.costume}`).join('\n') },
        { title: '单集时长', body: `${project.seconds_min}–${project.seconds_max} 秒` },
        ...revision(store, run, json),
      ],
      data: { beats: ep.beats.map(b => b.id), voiced: voicedPerBeat(ep.beats), min: project.seconds_min, max: project.seconds_max, locations: names(store, 'loc'), changes } satisfies PlanData,
      tag: `segment-plan-${scope}-${run.id}`,
      nodeRunId: run.id,
    })
    return [store.addArtifact({ kind: 'segment_plan', scope, payload: result.output, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/** ★6: a scene's staging, written looking at its location's main picture, before any of its timelines. */
const blocking: NodeDef = {
  name: 'blocking',
  pool: 'vision',
  output: 'blocking',
  review: 6,
  scopes(store) {
    return episode(store)?.scenes.map(s => sceneScope(s.id)) ?? []
  },
  ready(store, scope): Ready {
    const ep = episode(store)
    const scene = ep?.scenes.find(s => sceneScope(s.id) === scope)
    if (!ep || !scene) return { ok: false }
    const place = scopeOf('loc', scene.location)
    const brief = store.locked('entity_brief', place)
    const desc = store.locked('entity_desc', place)
    const picture = lockedImage(store, place)
    if (!brief || !desc || !picture) return { ok: false }
    return { ok: true, inputs: [ep.script.id, ep.rosterId, brief.id, desc.id, picture.lock.id] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    if (!env.vision) throw new Error('没有配置视觉模型')
    const scene = episode(store)!.scenes.find(s => sceneScope(s.id) === scope)!
    const first = firstOnStage(store, scene)
    const picture = store.artifact((store.artifact(inputs[4]!).payload as { image_id: number }).image_id)
    const result = await env.vision({
      card: CARDS.blocking!,
      sections: [
        { title: '这一场', body: `${scene.id}，地点：${scene.location}${scene.setting ? `\n${scene.setting}` : ''}` },
        { title: '这一场的剧本', body: fmtBeats(store, scene.beats.map(b => b.id)) },
        { title: '这一场的人物', body: Object.entries(first).map(([name, beat]) => `${name}：${beat === scene.beats[0]!.id ? `开场就在（${beat}）` : `${beat} 出场`}`).join('\n') },
        { title: '地点的外观要点', body: text(store.artifact(inputs[2]!)) },
        { title: '参考图', body: `图 1：${scene.location}的主图` },
        ...revision(store, run, json),
      ],
      images: [store.mediaPath(picture.media_id!)],
      data: { beats: scene.beats.map(b => b.id), first } satisfies BlockingData,
      tag: `blocking-${scope.replaceAll('/', '-')}-${run.id}`,
      nodeRunId: run.id,
    })
    return [store.addArtifact({ kind: 'blocking', scope, payload: result.output, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
  },
}

const timeline: NodeDef = {
  name: 'timeline',
  pool: 'text',
  output: 'timeline',
  scopes(store) {
    return planOf(store)?.plan.segments.map(s => segmentScope(s.id)) ?? []
  },
  ready(store, scope): Ready {
    const planned = planOf(store)
    if (!planned) return { ok: false }
    const segment = planned.plan.segments.find(s => segmentScope(s.id) === scope)
    if (!segment) return { ok: false }
    const index = planned.plan.segments.indexOf(segment)
    const previous = segment.continues ? store.locked('timeline', segmentScope(planned.plan.segments[index - 1]!.id)) : undefined
    if (segment.continues && !previous) return { ok: false }
    const present = presentNames(store, segment)
    const locks = present.flatMap(name => {
      const kind = names(store, 'char').includes(name) ? 'char' : names(store, 'loc').includes(name) ? 'loc' : 'prop'
      const lock = store.locked('entity_lock', scopeOf(kind, name))
      return lock ? [lock.id] : []
    })
    if (locks.length < present.length) return { ok: false }
    const staged = stagings(store, segment)
    if (!staged) return { ok: false }
    return { ok: true, inputs: [planned.artifact.id, ...locks, ...staged.map(s => s.blocking.id), ...(previous ? [previous.id] : [])] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const planned = planOf(store)!
    const index = planned.plan.segments.findIndex(s => segmentScope(s.id) === scope)
    const segment = planned.plan.segments[index]!
    const prevSeg = planned.plan.segments[index - 1]
    const nextSeg = planned.plan.segments[index + 1]
    const previous = segment.continues && prevSeg ? store.locked('timeline', segmentScope(prevSeg.id)) : undefined
    const sections: Section[] = [
      { title: '这一段', body: `${segment.id}，${segment.seconds} 秒，地点：${segmentLocations(store, segment).join(' → ')}${segment.continues ? '，承接上一段' : ''}\n概要：${segment.summary}` },
      { title: '这一段的剧本', body: fmtBeats(store, segment.beats) },
      { title: '前一段', body: prevSeg?.summary ?? '' },
      { title: '上一段最后一个镜头', body: previous ? lastCutBlurb(previous.payload as TimelineT) : '' },
      { title: '后一段', body: nextSeg?.summary ?? '' },
      { title: '出场的人物、地点、道具', body: presentNames(store, segment).join('、') },
      { title: '地点的格局', body: segmentLocations(store, segment).map(l => `${l}\n${layout(text(store.locked('entity_brief', scopeOf('loc', l))!))}`).join('\n\n') },
      { title: '站位', body: stagings(store, segment)!.map(s => stagingOf(s.scene, s.blocking.payload as BlockingT, segment)).join('\n\n') },
      { title: '这一段开始时的状态', body: stateBefore(store, segment.beats[0]!).join('\n') },
      ...revision(store, run, json),
    ]
    const lines = episode(store)!.beats.filter(b => segment.beats.includes(b.id)).flatMap(b => b.lines)
    const result = await env.text({
      card: CARDS.timeline!,
      sections,
      data: { seconds: segment.seconds, lines, characters: names(store, 'char'), props: names(store, 'prop'), locations: segmentLocations(store, segment) },
      tag: `timeline-${scope.replaceAll('/', '-')}-${run.id}`,
      nodeRunId: run.id,
    })
    return [store.addArtifact({ kind: 'timeline', scope, payload: result.output, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/** Groups every keyframe cut at one location into a few camera positions, once all its timelines are written. */
const views: NodeDef = {
  name: 'views',
  pool: 'text',
  output: 'view_plan',
  scopes(store) {
    return [...new Set(planOf(store)?.plan.segments.flatMap(s => segmentLocations(store, s).map(l => scopeOf('loc', l))) ?? [])]
  },
  ready(store, scope): Ready {
    const planned = planOf(store)
    const brief = store.locked('entity_brief', scope)
    if (!planned || !brief) return { ok: false }
    const here = planned.plan.segments.filter(s => segmentLocations(store, s).some(l => scopeOf('loc', l) === scope))
    const timelines = here.map(s => store.locked('timeline', segmentScope(s.id)))
    if (timelines.some(t => !t)) return { ok: false }
    return { ok: true, inputs: [brief.id, ...timelines.map(t => t!.id)] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const cuts = keyframeCuts(store).filter(c => scopeOf('loc', cutLocation(c.segment, c.cut)) === scope)
    const result = await env.text({
      card: CARDS['view-groups']!,
      sections: [
        { title: '地点的外观要点', body: text(store.artifact(inputs[0]!)) },
        { title: '镜头', body: cuts.map(c => `${cutId(c.segment.id, c.cut.index)}｜镜头：${c.cut.shot}｜运镜：${c.cut.camera}｜视角：${c.cut.present.view}`).join('\n') },
        ...revision(store, run, json),
      ],
      data: { cuts: cuts.map(c => cutId(c.segment.id, c.cut.index)) },
      tag: `view-groups-${scope.replaceAll('/', '-')}-${run.id}`,
      nodeRunId: run.id,
    })
    return [store.addArtifact({ kind: 'view_plan', scope, payload: result.output, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
  },
}

const view: NodeDef = {
  name: 'view',
  pool: 'image',
  output: 'entity_image',
  review: 6,
  paid: { pool: 'image', count: 1 },
  // Its run writes the view's description from the note before drawing, so the note stays on the picture.
  reviseVia: (_store, a) => a,
  scopes(store) {
    return views.scopes(store).flatMap(scope => {
      const groups = store.locked('view_plan', scope)?.payload as ViewGroupsT | undefined
      return groups?.views.filter(v => v.name !== MAIN_VIEW).map(v => `${scope}/${v.name}`) ?? []
    })
  },
  ready(store, scope): Ready {
    const { location } = parseView(scope)
    const root = lockedImage(store, scopeOf('loc', location))
    const style = store.locked('style_ref', 'p')
    const brief = store.locked('entity_brief', scopeOf('loc', location))
    const groups = store.locked('view_plan', scopeOf('loc', location))
    if (!root || !style || !brief || !groups) return { ok: false }
    return { ok: true, inputs: [root.lock.id, style.id, brief.id, groups.id] }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    const { location, name } = parseView(scope)
    const camera = (e.store.artifact(inputs[3]!).payload as ViewGroupsT).views.find(v => v.name === name)!.camera
    const desc = await e.text({
      card: CARDS['location-view-desc']!,
      sections: [
        { title: '地点的外观要点', body: text(e.store.artifact(inputs[2]!)) },
        { title: '需要的视角', body: camera },
        ...revision(e.store, run, a => (a.payload as { prompt: string }).prompt),
      ],
      tag: `location-view-desc-${scope.replaceAll('/', '-')}-${run.id}`,
      nodeRunId: run.id,
    })
    if (!e.images) throw new Error('没有配置出图服务')
    const root = e.store.artifact((e.store.artifact(inputs[0]!).payload as { image_id: number }).image_id)
    const refs = [{ label: `${location}的主图`, media: root.media_id! }, { label: '风格参考图', media: styleRefMedia(e) }]
    const prompt = imagePrompt(e.root, e.style, 'location-view', desc.output as string, refs.map(r => r.label))
    const drawn = await image(e.store, e.images, { type: 'location-view', prompt, params: imageParams('location-view'), references: refs.map(r => r.media), node_run_id: run.id, candidate: 1 }, e.sleep)
    return [e.store.addArtifact({ kind: 'entity_image', scope, payload: { job_id: drawn.job, prompt, desc: desc.output }, media_id: drawn.media, inputs, node_run_id: run.id, created_by: 'model' }).id]
  },
}

/** What a cut's camera position shows, left to right, for a writer who cannot see its picture. */
function viewText(store: Store, location: string, id: string): string {
  const view = (store.locked('view_plan', scopeOf('loc', location))!.payload as ViewGroupsT).views.find(v => v.cuts.includes(id))!
  if (view.name === MAIN_VIEW) return `主图：${text(store.locked('entity_desc', scopeOf('loc', location))!)}`
  // Views drawn before 2026-10-28 kept only the whole prompt.
  const picture = viewOf(store, location, id)!.picture!.image.payload as { desc?: string; prompt: string }
  return `相机：${view.camera}\n这个机位的图：${picture.desc ?? picture.prompt}`
}

/** The pictures a keyframe is drawn from, as its description and its prompt number them. */
function keyframeLabels(store: Store, scope: string): string[] {
  const { segment, cut, id } = cutAt(store, scope)!
  return [
    ...cut.present.characters.map(name => figure(store, segment, cut, name).label),
    viewOf(store, cutLocation(segment, cut), id)!.label,
    ...cut.present.props.map(name => `${name}的设定图`),
    '风格参考图',
  ]
}

/** The prompt a keyframe would be drawn with from this description, for the creator to read before paying for it. */
export function keyframePrompt(env: EntityEnv, scope: string, desc: string): string {
  return imagePrompt(env.root, env.style, 'keyframe', desc, keyframeLabels(env.store, scope))
}

const kfdesc: NodeDef = {
  name: 'kfdesc',
  pool: 'text',
  output: 'keyframe_desc',
  scopes(store) {
    return keyframeCuts(store).map(({ segment, cut }) => cutScope(segment.id, cut.index))
  },
  ready(store, scope): Ready {
    const at = cutAt(store, scope)
    if (!at) return { ok: false }
    const place = viewOf(store, cutLocation(at.segment, at.cut), at.id)
    if (!place?.picture) return { ok: false }
    const location = cutLocation(at.segment, at.cut)
    const briefs = [
      ...at.cut.present.characters.map(name => store.locked('entity_brief', lookAt(store, name, at.segment.beats[0]!))),
      store.locked('entity_brief', scopeOf('loc', location)),
      store.locked('entity_desc', scopeOf('loc', location)),
    ]
    const staged = stagings(store, at.segment, location)
    if (briefs.some(b => !b) || !staged) return { ok: false }
    return { ok: true, inputs: [at.timeline.id, place.groups.id, place.picture.lock.id, ...briefs.map(b => b!.id), ...staged.map(s => s.blocking.id)] }
  },
  async run(env, scope, run, inputs) {
    const { store } = env
    const { segment, timeline, cut, id } = cutAt(store, scope)!
    const tl = timeline.payload as TimelineT
    const second = tl.timeline.find(entry => entry.second === Math.floor(cut.start))
    const refs = keyframeLabels(store, scope).map((label, i) => `图 ${i + 1}：${label}`)
    const colors = cut.present.characters.map(name => `${name}：${pick(text(store.locked('entity_brief', lookAt(store, name, segment.beats[0]!))!), '主色').replace('主色：', '')}`)
    const location = cutLocation(segment, cut)
    const brief = text(store.locked('entity_brief', scopeOf('loc', location))!)
    const atCut = cutState(store, scope)!
    const result = await env.text({
      card: CARDS['keyframe-desc']!,
      sections: [
        { title: '这一秒', body: `第 ${cut.start} 秒，第 ${cut.index} 个镜头的开头。\n画面：${second?.text ?? ''}\n镜头：${cut.shot}\n运镜：${cut.camera}` },
        { title: '参考图', body: refs.join('\n') },
        { title: '人物主色', body: colors.join('\n') },
        { title: '这个视角', body: viewText(store, location, id) },
        { title: '场内陈设', body: pick(brief, '陈设') },
        { title: '光源', body: pick(brief, '光源') },
        { title: '站位', body: stagings(store, segment, location)!.map(s => stagingOf(s.scene, s.blocking.payload as BlockingT, segment)).join('\n\n') },
        { title: '此刻的状态', body: atCut.join('\n') },
        ...revision(store, run, a => (a.payload as { text: string }).text),
      ],
      tag: `keyframe-desc-${scope.replaceAll('/', '-')}-${run.id}`,
      nodeRunId: run.id,
    })
    return [store.addArtifact({ kind: 'keyframe_desc', scope, payload: { at: cut.start, text: result.output }, inputs, prompt_version: result.promptVersion, node_run_id: run.id, created_by: 'model' }).id]
  },
}

const keyframe: NodeDef = {
  name: 'keyframe',
  pool: 'image',
  output: 'keyframe',
  review: 6,
  paid: { pool: 'image', count: 1 },
  reviseVia: (store, a) => store.locked('keyframe_desc', a.scope),
  scopes: kfdesc.scopes,
  ready(store, scope): Ready {
    const desc = store.locked('keyframe_desc', scope)
    const at = cutAt(store, scope)
    if (!desc || !at) return { ok: false }
    const style = store.locked('style_ref', 'p')
    const place = viewOf(store, cutLocation(at.segment, at.cut), at.id)
    const chars = at.cut.present.characters.map(name => figure(store, at.segment, at.cut, name).picture)
    const props = at.cut.present.props.map(name => lockedImage(store, scopeOf('prop', name)))
    if (!style || !place?.picture || chars.some(c => !c) || props.some(p => !p)) return { ok: false }
    return { ok: true, inputs: [desc.id, place.picture.lock.id, style.id, ...chars.map(c => c!.lock.id), ...props.map(p => p!.lock.id)] }
  },
  async run(env, scope, run, inputs) {
    const e = env as EntityEnv
    const { cut } = cutAt(e.store, scope)!
    const mediaOf = (lockId: number) => e.store.artifact((e.store.artifact(lockId).payload as { image_id: number }).image_id).media_id!
    // In the order of keyframeLabels: the people, the view, the props, the style picture.
    const media = [...inputs.slice(3, 3 + cut.present.characters.length).map(mediaOf), mediaOf(inputs[1]!), ...inputs.slice(3 + cut.present.characters.length).map(mediaOf), styleRefMedia(e)]
    const refs = keyframeLabels(e.store, scope).map((label, i) => ({ label, media: media[i]! }))
    if (!e.images) throw new Error('没有配置出图服务')
    const prompt = keyframePrompt(e, scope, (e.store.artifact(inputs[0]!).payload as { text: string }).text)
    const drawn = await image(e.store, e.images, { type: 'keyframe', prompt, params: imageParams('keyframe'), references: refs.map(r => r.media), node_run_id: run.id, candidate: 1 }, e.sleep)
    return [e.store.addArtifact({ kind: 'keyframe', scope, payload: { job_id: drawn.job, prompt }, media_id: drawn.media, inputs, node_run_id: run.id, created_by: 'model' }).id]
  },
}

export const STORYBOARD_NODES: NodeDef[] = [plan, blocking, timeline, views, view, kfdesc, keyframe]
