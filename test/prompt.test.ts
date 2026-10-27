import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlugin, loadPlugins, PluginError, type Plugin } from '../src/plugins.js'
import { assemble, PromptError, userMessage } from '../src/prompt.js'

const ROOT = join(import.meta.dir, '..')

function plugin(kind: 'style' | 'genre', files: Record<string, string>, manifest: object): Plugin {
  const dir = mkdtempSync(join(tmpdir(), 'yx-plugin-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ kind, ...manifest }))
  return loadPlugin(dir)
}

const style = () => plugin('style', { 'w.md': '画风要求' }, { id: 's', name: '3D 国漫', fragments: { writer: 'w.md' } })
const genre = () => plugin('genre', { 'c.md': '题材要求' }, { id: 'g', name: '仙侠', fragments: { character: 'c.md' } })

describe('assemble', () => {
  test('fills names and fragments', () => {
    const { text, version } = assemble('你是{{style.name}}{{genre.name}}。\n{{style:writer}}\n{{genre:character}}', { style: style(), genre: genre() })
    expect(text).toBe('你是3D 国漫仙侠。\n画风要求\n题材要求')
    expect(version).toMatch(/^[0-9a-f]{16}$/)
  })

  test('a fragment the plugin does not declare is an error', () => {
    expect(() => assemble('{{style:wrter}}', { style: style(), genre: genre() })).toThrow(PluginError)
  })

  test('an unknown placeholder is an error, not silently kept', () => {
    expect(() => assemble('{{project.name}}', { style: style(), genre: genre() })).toThrow(PromptError)
    expect(() => assemble('{{style.title}}', { style: style(), genre: genre() })).toThrow(PromptError)
  })

  test('a placeholder in another shape (the old Chinese ones) is caught by the leftover check', () => {
    expect(() => assemble('你是{{画风名}}', { style: style(), genre: genre() })).toThrow(/没替换的占位符/)
    expect(() => assemble('{{ style }}', { style: style(), genre: genre() })).toThrow(/没替换的占位符/)
  })

  test('the version changes when a fragment changes', () => {
    const a = assemble('{{style:writer}}', { style: style(), genre: genre() }).version
    const other = plugin('style', { 'w.md': '另一种画风要求' }, { id: 's', name: '3D 国漫', fragments: { writer: 'w.md' } })
    expect(assemble('{{style:writer}}', { style: other, genre: genre() }).version).not.toBe(a)
  })
})

describe('plugins', () => {
  test('a declared file that does not exist refuses the plugin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yx-plugin-'))
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'x', kind: 'style', name: 'X', fragments: { writer: 'missing.md' } }))
    expect(() => loadPlugin(dir)).toThrow(/missing\.md/)
  })

  test('a broken plugin is reported and left out, the rest still load', () => {
    const root = mkdtempSync(join(tmpdir(), 'yx-plugins-'))
    mkdirSync(join(root, 'style', 'good'), { recursive: true })
    writeFileSync(join(root, 'style', 'good', 'plugin.json'), JSON.stringify({ id: 'good', kind: 'style', name: '好' }))
    mkdirSync(join(root, 'style', 'bad'), { recursive: true })
    writeFileSync(join(root, 'style', 'bad', 'plugin.json'), JSON.stringify({ id: 'bad', kind: 'style', name: '坏', fragments: { writer: 'nope.md' } }))
    const { plugins, errors } = loadPlugins(root)
    expect([...plugins.keys()]).toEqual(['style:good'])
    expect(errors).toHaveLength(1)
  })

  test('the shipped plugins load and every task prompt assembles', () => {
    const { plugins, errors } = loadPlugins(join(ROOT, 'config/plugins'))
    expect(errors).toEqual([])
    const pair = { style: plugins.get('style:3d-guoman')!, genre: plugins.get('genre:xianxia')! }
    const dir = join(ROOT, 'config/prompts/tasks')
    const files = readdirSync(dir).filter(name => name.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) expect(() => assemble(readFileSync(join(dir, name), 'utf8'), pair)).not.toThrow()
  })
})

test('userMessage drops empty sections', () => {
  expect(userMessage([{ title: '甲', body: '一' }, { title: '乙', body: '  ' }])).toBe('【甲】\n一')
})
