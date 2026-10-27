import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { IMAGE_TYPES, imagePrompt } from '../src/compose.js'
import { loadPlugins, PluginError } from '../src/plugins.js'

const ROOT = join(import.meta.dir, '..')
const style = () => loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')!

test('every kind of image has a style sentence and a fixed part', () => {
  for (const type of IMAGE_TYPES) expect(() => imagePrompt(ROOT, style(), type, '主体')).not.toThrow()
})

test('the parts come in order: style, references, body, fixed part', () => {
  const text = imagePrompt(ROOT, style(), 'location-view', '相机站在洞门内侧，朝北看向石台。', ['封剑洞的场景主图', '风格参考图'])
  const parts = text.split('\n\n')
  expect(parts).toHaveLength(4)
  expect(parts[0]).toContain('3D 国漫')
  expect(parts[1]).toBe('图 1 是封剑洞的场景主图。图 2 是风格参考图。')
  expect(parts[2]).toBe('相机站在洞门内侧，朝北看向石台。')
  expect(parts[3]).toContain('只改变观看的位置和方向')
})

test('a keyframe has no fixed part, and the empty file adds nothing', () => {
  expect(imagePrompt(ROOT, style(), 'keyframe', '主体').split('\n\n')).toHaveLength(2)
})

test('the shipped style has its own style reference', () => {
  expect(style().styleRef).toBe('style-ref.png')
})

test('a style without the sentence for a kind of image is an error', () => {
  const partial = { ...style(), imagePrefix: { portrait: 'image/character.md' } }
  expect(() => imagePrompt(ROOT, partial, 'keyframe', '主体')).toThrow(PluginError)
})
