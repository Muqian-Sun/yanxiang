import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Plugin, PluginError } from './plugins.js'

export const IMAGE_TYPES = ['portrait', 'turnaround', 'face', 'prop-sheet', 'location', 'location-view', 'keyframe', 'outfit'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

/**
 * An image prompt in the fixed order: the style's sentence for this kind of image,
 * what each reference image is, the writer's paragraph, then the kind's fixed part.
 */
export function imagePrompt(root: string, style: Plugin, type: ImageType, body: string, refs: string[] = []): string {
  const prefixFile = style.imagePrefix[type]
  if (!prefixFile) throw new PluginError(`画风插件 ${style.id} 没有 ${type} 的画风句`)
  const fixedPath = join(root, 'config/prompts/image-types', `${type}.md`)
  if (!existsSync(fixedPath)) throw new PluginError(`没有 ${type} 的固定部分：${fixedPath}`)
  return [
    readFileSync(join(style.dir, prefixFile), 'utf8').trim(),
    refs.map((label, i) => `图 ${i + 1} 是${label}。`).join(''),
    body.trim(),
    readFileSync(fixedPath, 'utf8').trim(),
  ].filter(Boolean).join('\n\n')
}
