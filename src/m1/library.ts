/**
 * Everything the project has so far, for browsing on the review page: the current version of
 * each artifact (the locked one, else the newest draft or stale one), grouped the way the creator
 * thinks of them: people, places, props, the script, the storyboard, the videos.
 */
import { DERIVED, episode, lockedImage, names, scopeOf } from '../pipeline/entities.js'
import { cutScope, planOf, segmentScope } from '../pipeline/storyboard.js'
import type { Artifact, Store } from '../store/store.js'
import { MAIN_VIEW, type TimelineT, type ViewGroupsT } from '../tasks.js'

export type Item = { id: number; kind: string; status: string; version: number; payload: unknown; media: number | null; mime: string | null }

function item(store: Store, a: Artifact | undefined): Item | null {
  if (!a) return null
  const mime = a.media_id ? (store.db.prepare('SELECT mime FROM media WHERE id = ?').get(a.media_id) as { mime: string }).mime : null
  return { id: a.id, kind: a.kind, status: a.status, version: a.version, payload: a.payload, media: a.media_id, mime }
}

/** The locked version, else the newest one still in play (a draft waiting for review, or one gone stale). */
const current = (store: Store, kind: string, scope: string) => item(store, store.locked(kind, scope) ?? store.latest(kind, scope, ['draft', 'stale']))
const picture = (store: Store, scope: string) => item(store, lockedImage(store, scope)?.image ?? store.latest('entity_image', scope, ['draft', 'stale']))

export function library(store: Store) {
  const ep = episode(store)
  const entity = (kind: 'char' | 'loc' | 'prop') => names(store, kind).map(name => {
    const scope = scopeOf(kind, name)
    const extras = kind === 'char'
      ? Object.keys(DERIVED).map(d => ({ label: d, image: picture(store, `${scope}/${d}`) }))
      : kind === 'loc'
        ? ((store.locked('view_plan', scope)?.payload as ViewGroupsT | undefined)?.views ?? []).filter(v => v.name !== MAIN_VIEW).map(v => ({ label: v.name, note: v.camera, image: picture(store, `${scope}/${v.name}`) }))
        : []
    return { name, scope, brief: current(store, 'entity_brief', scope), desc: current(store, 'entity_desc', scope), image: picture(store, scope), extras }
  })
  const plan = planOf(store)?.plan
  const segments = (plan?.segments ?? []).map(s => {
    const scope = segmentScope(s.id)
    const timeline = current(store, 'timeline', scope)
    const tl = timeline?.payload as TimelineT | undefined
    return {
      ...s, scope, timeline,
      cuts: (tl?.cuts ?? []).map(c => ({ index: c.index, start: c.start, end: c.end, keyframe: current(store, 'keyframe', cutScope(s.id, c.index)), desc: current(store, 'keyframe_desc', cutScope(s.id, c.index)) })),
      draft: current(store, 'clip_draft', scope), trim: current(store, 'trim', scope), final: current(store, 'clip_final', scope),
    }
  })
  const speakers = names(store, 'char').map(name => ({ name, audition: current(store, 'audition', scopeOf('char', name)), voice: current(store, 'voice', scopeOf('char', name)) })).filter(v => v.audition || v.voice)
  return {
    characters: entity('char'), locations: entity('loc'), props: entity('prop'),
    script: ep ? { scenes: (ep.script.payload as { scenes: { id: string; location: string; setting?: string; beats: { id: string; action: string; seconds: number; lines: { speaker: string; text: string; vo?: boolean }[]; changes: string[] }[] }[] }).scenes, roster: ep.roster } : null,
    segments, overflow: plan?.overflow ?? [], speakers,
    cutDraft: current(store, 'cut_draft', 'e1'), cutFinal: current(store, 'cut_final', 'e1'),
  }
}
