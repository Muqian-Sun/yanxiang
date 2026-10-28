import { expect, test } from 'bun:test'
import { build, canvas, frameCount, tokens, type Reference, type Spec } from '../src/video/workflow.js'
import { REQUIRED } from './fake-comfy.js'

const OPTIONAL: Record<string, string[]> = {
  CLIPLoader: ['device'], CreateVideo: ['audio'], SaveVideo: ['format.codec'], MiniMaxH3ReferenceToVideo: ['vae', 'audio_vae'],
  MiniMaxH3AddGuide: ['vae', 'audio_vae', 'image', 'audio'], MinimaxH3LatentUpscaler3D: ['mode.scale'], BlockSparseAttention: ['selection.tau'],
}
const allowed = (cls: string) => new Set([...REQUIRED[cls]!, ...(OPTIONAL[cls] ?? []), ...(cls === 'MiniMaxH3ReferenceToVideo' ? [...Array(9).keys()].map(i => `ref_images.ref_image_${i}`).concat([...Array(3).keys()].map(i => `ref_audios.ref_audio_${i}`)) : [])])

const MODELS = { unet: 'ref2va', textEncoder: 'te', videoVae: 'vvae', audioVae: 'avae', turboLora: 'turbo', upscaler: 'up' }
const spec = (references: Reference[], over: Partial<Spec> = {}): Spec => ({
  prompt: 'p', width: 1024, height: 576, frames: 362, steps: 8, seed: 7, turboStrength: 1, sampler: 'res_multistep', scheduler: 'simple',
  references, loras: [], sparse: null, refine: null, prefix: 'yanxiang/1', ...over,
})
type G = ReturnType<typeof build>
const of = (g: G, cls: string) => Object.entries(g).filter(([, n]) => n.class_type === cls)
const only = (g: G, cls: string) => {
  const nodes = of(g, cls)
  expect(nodes).toHaveLength(1)
  return nodes[0]!
}
function wellFormed(g: G) {
  for (const [id, node] of Object.entries(g)) {
    expect(REQUIRED[node.class_type], `${id} ${node.class_type}`).toBeDefined()
    for (const name of REQUIRED[node.class_type]!) expect(node.inputs, `${id} ${node.class_type} 缺 ${name}`).toHaveProperty([name])
    for (const name of Object.keys(node.inputs)) expect(allowed(node.class_type).has(name), `${id} ${node.class_type} 多了 ${name}`).toBe(true)
    for (const value of Object.values(node.inputs)) if (Array.isArray(value) && typeof value[0] === 'string') expect(g[value[0]], `${id} 连到不存在的节点 ${value[0]}`).toBeDefined()
  }
}
const kf = (name: string, at: number): Reference => ({ role: 'keyframe', name, at })
const img = (name: string): Reference => ({ role: 'reference_image', name })

test('seconds land on the 17k+5 frame grid and 16:9 at 576 is 1024×576', () => {
  expect([4, 5, 7, 15].map(frameCount)).toEqual([107, 124, 175, 362])
  expect([4, 5, 7, 15].map(frameCount).every(f => f % 17 === 5)).toBe(true)
  expect(() => frameCount(3)).toThrow()
  expect(() => frameCount(16)).toThrow()
  expect(canvas('16:9', 576)).toEqual({ width: 1024, height: 576 })
  expect(canvas('16:9', 768)).toEqual({ width: 1344, height: 768 })
})

test('pictures and voices are numbered per type in binding order; a guide clip gets no number', () => {
  const refs: Reference[] = [{ role: 'guide_clip', name: 't.mp4', at: 0 }, kf('a', 3), img('b'), { role: 'reference_audio', name: 'v.wav' }, img('c')]
  expect(tokens(refs)).toEqual([null, '<Picture 1>', '<Picture 2>', '<Audio 1>', '<Picture 3>'])
})

test('keyframes are reference pictures pinned at their second; the guider sees the last pin', () => {
  const g = build(spec([kf('kf1.png', 0), kf('kf2.png', 5), img('sheet.png'), kf('kf3.png', 9), { role: 'reference_audio', name: 'v.wav' }]), MODELS)
  wellFormed(g)
  const [, r2v] = only(g, 'MiniMaxH3ReferenceToVideo')
  const pictures = [0, 1, 2, 3].map(i => g[(r2v.inputs[`ref_images.ref_image_${i}`] as [string])[0]]!.inputs.image)
  expect(pictures).toEqual(['kf1.png', 'kf2.png', 'sheet.png', 'kf3.png'])
  expect(g[(r2v.inputs['ref_audios.ref_audio_0'] as [string])[0]]!.inputs.audio).toBe('v.wav')
  const pins = of(g, 'MiniMaxH3AddGuide').map(([, n]) => [n.inputs.frame_idx, g[(n.inputs.image as [string])[0]]!.inputs.image])
  expect(pins).toEqual([[0, 'kf1.png'], [120, 'kf2.png'], [216, 'kf3.png']])
  const last = of(g, 'MiniMaxH3AddGuide').at(-1)![0]
  expect(only(g, 'BasicGuider')[1].inputs.conditioning).toEqual([last, 0])
})

test('a guide clip pins its frames and its sound, and is not a reference picture', () => {
  const g = build(spec([{ role: 'guide_clip', name: 'tail.mp4', at: 0 }, kf('kf2.png', 4), img('sheet.png')]), MODELS)
  wellFormed(g)
  const [, r2v] = only(g, 'MiniMaxH3ReferenceToVideo')
  expect(Object.keys(r2v.inputs).filter(k => k.startsWith('ref_images.'))).toHaveLength(2)
  const [partsId] = only(g, 'GetVideoComponents')
  const clipPin = of(g, 'MiniMaxH3AddGuide').map(([, n]) => n.inputs).find(i => (i.image as [string])[0] === partsId)!
  expect([clipPin.frame_idx, clipPin.image, clipPin.audio]).toEqual([0, [partsId, 0], [partsId, 1]])
})

test('turbo, then extra LoRAs in order, then sparse attention drive the sampler', () => {
  const g = build(spec([img('s')], { loras: [{ name: 'wushu', strength: 0.7 }], sparse: { tau: 1.3, start: 0.2, end: 1 } }), MODELS)
  wellFormed(g)
  const loras = of(g, 'LoraLoaderModelOnly')
  expect(loras.map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([['turbo', 1], ['wushu', 0.7]])
  expect(loras[1]![1].inputs.model).toEqual([loras[0]![0], 0])
  const [sparseId, sparse] = only(g, 'BlockSparseAttention')
  expect(sparse.inputs.model).toEqual([loras[1]![0], 0])
  expect(only(g, 'BasicGuider')[1].inputs.model).toEqual([sparseId, 0])
  expect(only(g, 'BasicScheduler')[1].inputs.model).toEqual([sparseId, 0])
})

test('the refine pass upscales the draft latent and pins the keyframes again on it', () => {
  const g = build(spec([kf('kf1.png', 0), kf('kf2.png', 5), img('sheet.png')], { refine: { scale: 1.875, sigmas: [0.45, 0.3, 0.15, 0] } }), MODELS)
  wellFormed(g)
  const [r2vId] = only(g, 'MiniMaxH3ReferenceToVideo')
  const [joinId] = only(g, 'LTXVConcatAVLatent')
  const latents = of(g, 'MiniMaxH3AddGuide').map(([, n]) => [n.inputs.frame_idx, (n.inputs.latent as [string])[0]])
  expect(latents).toEqual([[0, r2vId], [120, r2vId], [0, joinId], [120, joinId]])
  expect(only(g, 'ManualSigmas')[1].inputs.sigmas).toBe('0.45, 0.3, 0.15, 0')
  const samplers = of(g, 'SamplerCustomAdvanced')
  expect(samplers).toHaveLength(2)
  expect(only(g, 'VAEDecode')[1].inputs.samples).toEqual([samplers[1]![0], 0])
  expect(only(g, 'SaveVideo')[1].inputs.filename_prefix).toBe('yanxiang/1')
})

test('a graph that H3 would reject is refused before it reaches the server', () => {
  expect(() => build(spec([]), MODELS)).toThrow('至少要一张参考图')
  expect(() => build(spec(Array.from({ length: 10 }, (_, i) => img(`${i}`))), MODELS)).toThrow('最多 9 张')
  expect(() => build(spec([img('a'), ...Array.from({ length: 4 }, (_, i): Reference => ({ role: 'reference_audio', name: `${i}` }))]), MODELS)).toThrow('最多 3 段')
  expect(() => build(spec([{ role: 'keyframe', name: 'a' }]), MODELS)).toThrow('要写钉帧秒数')
  expect(() => build(spec([kf('a', 20)]), MODELS)).toThrow('超出')
})
