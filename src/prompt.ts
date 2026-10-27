import { createHash } from 'node:crypto'
import { fragment, type Plugin } from './plugins.js'

export class PromptError extends Error {}

const PLACEHOLDER = /\{\{\s*([a-z]+)([.:])([a-z-]+)\s*\}\}/g

/**
 * Fill a task prompt's placeholders from the project's style and genre plugins:
 * {{style.name}}, {{genre.name}}, {{style:<fragment>}}, {{genre:<fragment>}}.
 * Anything left in braces afterwards is an error, so a typo never reaches the model.
 */
export function assemble(template: string, plugins: { style: Plugin; genre: Plugin }): { text: string; version: string } {
  const text = template.replace(PLACEHOLDER, (whole, owner: string, sep: string, key: string) => {
    if (owner !== 'style' && owner !== 'genre') throw new PromptError(`未知的占位符 ${whole}`)
    const plugin = plugins[owner]
    if (sep === '.') {
      if (key !== 'name') throw new PromptError(`未知的占位符 ${whole}`)
      return plugin.name
    }
    return fragment(plugin, key)
  })
  const left = text.match(/\{\{[^}]*\}\}?/g)
  if (left) throw new PromptError(`组装后还有没替换的占位符：${left.join('、')}`)
  return { text, version: createHash('sha256').update(text).digest('hex').slice(0, 16) }
}

export function userMessage(sections: { title: string; body: string }[]): string {
  return sections
    .filter(section => section.body.trim())
    .map(section => `【${section.title}】\n${section.body.trim()}`)
    .join('\n\n')
}
