import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { H3Profile } from '../jobs/videos.js'
import { loadModels } from '../llm.js'
import { Engine, type Event, type Gpu, type Pending, type VisionRunner } from '../pipeline/engine.js'
import { ENTITY_NODES, type EntityEnv } from '../pipeline/entities.js'
import { STORYBOARD_NODES } from '../pipeline/storyboard.js'
import { textRunner } from '../pipeline/text.js'
import { VIDEO_NODES } from '../pipeline/video.js'
import { loadPlugins } from '../plugins.js'
import { Store } from '../store/store.js'
import { comfy } from '../video/comfy.js'
import { yir } from '../yir.js'

export const ROOT = resolve(import.meta.dir, '../..')

/** The engine over one project directory, with the real text model, Yir and the GPU's ComfyUI. */
export function open(dir: string, say?: (e: Event) => void, shared?: Gpu) {
  const store = new Store(resolve(dir))
  const project = store.project()
  const { plugins, errors } = loadPlugins(join(ROOT, 'config/plugins'))
  if (errors.length) throw new Error(`插件加载失败：\n${errors.join('\n')}`)
  const style = plugins.get(`style:${project.style}`)
  const genre = plugins.get(`genre:${project.genre}`)
  if (!style || !genre) throw new Error(`项目用的插件 ${project.style}、${project.genre} 没有加载`)
  const models = loadModels(join(ROOT, 'config/models.json'))
  const profile = JSON.parse(readFileSync(join(ROOT, 'config/h3.json'), 'utf8')) as H3Profile
  const gpu: Gpu = shared ?? { client: comfy(process.env.COMFYUI_URL ?? profile.url), profile, online: false }
  const text = textRunner(store, ROOT, { style, genre }, models)
  const env: EntityEnv = { store, root: ROOT, style, text, vision: text as VisionRunner, images: models.image ? yir(models.image) : null, gpu }
  return { store, gpu, engine: new Engine(env, [...ENTITY_NODES, ...STORYBOARD_NODES, ...VIDEO_NODES], say) }
}

/** What is waiting for a grant or for the GPU, in one line per kind. */
export function describePending(pending: Pending[]): string[] {
  const images = pending.filter(p => p.pool === 'image' && !p.gpu)
  const videos = pending.filter(p => p.pool === 'video' && !p.gpu)
  const gpu = pending.filter(p => p.gpu)
  return [
    ...(images.length ? [`待开始出图 ${images.reduce((s, p) => s + p.count, 0)} 张：${images.map(p => `${p.scope}（${p.count} 张）`).join('、')}`] : []),
    ...(videos.length ? [`待开始出片 ${videos.length} 段：${videos.map(p => `${p.node} ${p.scope}`).join('、')}`] : []),
    ...(gpu.length ? [`已授权、等 GPU 开机：${gpu.map(p => `${p.node} ${p.scope}`).join('、')}`] : []),
  ]
}
