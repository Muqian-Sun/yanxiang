import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Manifest = z.object({
  id: z.string().min(1),
  kind: z.enum(['style', 'genre']),
  name: z.string().min(1),
  fragments: z.record(z.string(), z.string()).default({}),
  imagePrefix: z.record(z.string(), z.string()).default({}),
  /** The style's own reference picture: no people, no writing, bound to scene and keyframe images. */
  styleRef: z.string().optional(),
})

export type Plugin = z.infer<typeof Manifest> & { dir: string }

export class PluginError extends Error {}

export function loadPlugin(dir: string): Plugin {
  const path = join(dir, 'plugin.json')
  if (!existsSync(path)) throw new PluginError(`${dir} 没有 plugin.json`)
  const parsed = Manifest.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) throw new PluginError(`${path} 格式不对：${parsed.error.message}`)
  const plugin = { ...parsed.data, dir }
  const declared = [...Object.values(plugin.fragments), ...Object.values(plugin.imagePrefix), ...(plugin.styleRef ? [plugin.styleRef] : [])]
  const missing = declared.filter(file => !existsSync(join(dir, file)))
  if (missing.length) throw new PluginError(`插件 ${plugin.id} 声明的文件不存在：${missing.join('、')}`)
  return plugin
}

/** Every plugin under root; a broken one is left out and reported, never half-loaded. */
export function loadPlugins(root: string): { plugins: Map<string, Plugin>; errors: string[] } {
  const plugins = new Map<string, Plugin>()
  const errors: string[] = []
  for (const kind of ['style', 'genre']) {
    const base = join(root, kind)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const plugin = loadPlugin(join(base, entry.name))
        if (plugin.kind !== kind) throw new PluginError(`插件 ${plugin.id} 的 kind 是 ${plugin.kind}，却放在 ${kind}/ 下`)
        const key = `${kind}:${plugin.id}`
        if (plugins.has(key)) throw new PluginError(`插件 id 重复：${key}`)
        plugins.set(key, plugin)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  return { plugins, errors }
}

export function fragment(plugin: Plugin, key: string): string {
  const file = plugin.fragments[key]
  if (!file) throw new PluginError(`插件 ${plugin.id} 没有声明片段 ${key}`)
  return readFileSync(join(plugin.dir, file), 'utf8').trim()
}
