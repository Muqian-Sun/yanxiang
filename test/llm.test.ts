import { expect, test } from 'bun:test'
import { LlmError, streamed } from '../src/llm.js'

/** An event stream cut into the given pieces, the way the gateway hands them over (pieces end mid-line). */
const sse = (pieces: string[]) => new Response(new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(new TextEncoder().encode(p)); c.close() } }))
const ev = (data: object) => `event: x\ndata: ${JSON.stringify(data)}\n\n`
const delta = (text: string) => ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
const end = (stop: string) => ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: { input_tokens: 12, output_tokens: 34 } })

test('a streamed answer hands over everything written so far at each piece', async () => {
  const all = ev({ type: 'message_start', message: { usage: { input_tokens: 0 } } }) + delta('场1 内') + delta(' · 山门') + delta('\n△ 沈烬') + end('end_turn') + ev({ type: 'message_stop' })
  const cut = [all.slice(0, 150), all.slice(150, 260), all.slice(260)]
  const seen: string[] = []
  const reply = await streamed(sse(cut), 'u', 100, Date.now(), t => seen.push(t))
  expect(reply.text).toBe('场1 内 · 山门\n△ 沈烬')
  expect([reply.tokensIn, reply.tokensOut]).toEqual([12, 34])
  expect(seen.length).toBeGreaterThan(1)
  expect(seen.at(-1)).toBe(reply.text)
  seen.reduce((before, now) => (expect(now.startsWith(before)).toBe(true), now), '')
})

test('a streamed answer cut by max_tokens, cut off before its end, or reporting an error fails', async () => {
  await expect(streamed(sse([delta('写'), end('max_tokens')]), 'u', 100, 0, () => {})).rejects.toThrow('max_tokens')
  const broken = streamed(sse([delta('写到一半')]), 'u', 100, 0, () => {})
  await expect(broken).rejects.toThrow('没写完')
  await broken.catch((e: LlmError) => expect(e.retryable).toBe(true))
  const failed = streamed(sse([delta('写'), ev({ type: 'error', error: { type: 'overloaded_error' } })]), 'u', 100, 0, () => {})
  await expect(failed).rejects.toThrow('overloaded_error')
})
