import { join, resolve } from 'node:path'
import { loadModels } from '../llm.js'
import { Engine, type Event } from '../pipeline/engine.js'
import { ENTITY_NODES, type EntityEnv } from '../pipeline/entities.js'
import { STORYBOARD_NODES } from '../pipeline/storyboard.js'
import { textRunner } from '../pipeline/text.js'
import { loadPlugins } from '../plugins.js'
import { Store } from '../store/store.js'
import { yir } from '../yir.js'

export const ROOT = resolve(import.meta.dir, '../..')

/** The engine over one project directory, with the real text model and Yir. */
export function open(dir: string, say?: (e: Event) => void) {
  const store = new Store(resolve(dir))
  const project = store.project()
  const { plugins, errors } = loadPlugins(join(ROOT, 'config/plugins'))
  if (errors.length) throw new Error(`插件加载失败：\n${errors.join('\n')}`)
  const style = plugins.get(`style:${project.style}`)
  const genre = plugins.get(`genre:${project.genre}`)
  if (!style || !genre) throw new Error(`项目用的插件 ${project.style}、${project.genre} 没有加载`)
  const models = loadModels(join(ROOT, 'config/models.json'))
  const env: EntityEnv = { store, root: ROOT, style, text: textRunner(store, ROOT, { style, genre }, models), images: models.image ? yir(models.image) : null }
  return { store, engine: new Engine(env, [...ENTITY_NODES, ...STORYBOARD_NODES], say) }
}
