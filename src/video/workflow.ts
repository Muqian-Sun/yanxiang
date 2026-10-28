/**
 * ComfyUI API-format graphs for MiniMax H3 Ref2VA (design 07). Pure; no I/O.
 *
 * Node classes and input names follow ComfyUI v0.42.1 and the official Multiframe Reference
 * template, as the old project's tested `tools/manju/h3_workflow.py` did; the client checks
 * every class against the server's /object_info before it submits.
 */

export const FPS = 24
export const MAX_IMAGES = 9
export const MAX_AUDIOS = 3

/**
 * keyframe: a reference image (<Picture n>) also pinned at its second; reference_image: a
 * picture only; reference_audio: a voice (<Audio n>); guide_clip: an mp4 whose frames and
 * sound are pinned at its second and never shown to the text encoder.
 */
export type Role = 'keyframe' | 'reference_image' | 'reference_audio' | 'guide_clip'
export type Reference = { role: Role; name: string; at?: number }

export type Models = { unet: string; textEncoder: string; videoVae: string; audioVae: string; turboLora: string; upscaler: string }
export type Lora = { name: string; strength: number }
export type Sparse = { tau: number; start: number; end: number }
export type Refine = { scale: number; sigmas: number[] }
export type Spec = {
  prompt: string
  width: number
  height: number
  frames: number
  steps: number
  seed: number
  turboStrength: number
  sampler: string
  scheduler: string
  references: Reference[]
  loras: Lora[]
  sparse: Sparse | null
  refine: Refine | null
  prefix: string
}

type Link = [string, number]
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

/** Seconds to frames on H3's 17k+5 grid, the template's own formula: 15 s is 362 frames. */
export function frameCount(seconds: number): number {
  if (seconds < 4 || seconds > 15) throw new Error(`H3 一段要 4–15 秒，现在是 ${seconds} 秒`)
  const base = Math.max(5, Math.round(seconds * FPS))
  return base + (((5 - (base % 17)) % 17) + 17) % 17
}

/** The pixel frame a pin starts at; it must leave at least one frame inside the video. */
export function frameIndex(seconds: number, frames: number): number {
  const index = Math.round(seconds * FPS)
  if (index < 0 || index >= frames) throw new Error(`钉帧位置 ${seconds} 秒超出 ${frames} 帧的视频`)
  return index
}

/** Width and height for a 16:9 or 9:16 canvas at a short edge, each axis on a multiple of 32 (ComfyUI's adapt_canvas, capped at short² × 1344 / 768). */
export function canvas(ratio: '16:9' | '9:16', shortEdge: number): { width: number; height: number } {
  const value = ratio === '16:9' ? 16 / 9 : 9 / 16
  let [w, h] = value >= 1 ? [shortEdge * value, shortEdge] : [shortEdge, shortEdge / value]
  const cap = (shortEdge * shortEdge * 1344) / 768
  if (w * h > cap) {
    const s = Math.sqrt(cap / (w * h))
    w *= s
    h *= s
  }
  return { width: Math.max(32, Math.round(w / 32) * 32), height: Math.max(32, Math.round(h / 32) * 32) }
}

/** <Picture n> for images and <Audio n> for audio, numbered per type in binding order; guide clips get none. */
export function tokens(references: Reference[]): (string | null)[] {
  let pictures = 0
  let audios = 0
  return references.map(r => (r.role === 'guide_clip' ? null : r.role === 'reference_audio' ? `<Audio ${++audios}>` : `<Picture ${++pictures}>`))
}

function validate(spec: Spec) {
  const images = spec.references.filter(r => r.role === 'keyframe' || r.role === 'reference_image').length
  const audios = spec.references.filter(r => r.role === 'reference_audio').length
  if (!images) throw new Error('Ref2VA 至少要一张参考图')
  if (images > MAX_IMAGES) throw new Error(`Ref2VA 最多 ${MAX_IMAGES} 张参考图，现在 ${images} 张`)
  if (audios > MAX_AUDIOS) throw new Error(`Ref2VA 最多 ${MAX_AUDIOS} 段参考音频，现在 ${audios} 段`)
  for (const r of spec.references) {
    const timed = r.role === 'keyframe' || r.role === 'guide_clip'
    if (timed !== (r.at !== undefined)) throw new Error(`${r.role} ${timed ? '要' : '不能'}写钉帧秒数`)
    if (timed) frameIndex(r.at!, spec.frames)
  }
  if (spec.steps < 1 || spec.steps > 100) throw new Error('steps 要在 1–100')
  if (spec.refine && (spec.refine.scale < 1 || spec.refine.scale > 4 || spec.refine.sigmas.length < 2 || spec.refine.sigmas.at(-1) !== 0)) throw new Error('精修的放大倍数要在 1–4，sigmas 以 0 结尾')
}

export function build(spec: Spec, models: Models): Graph {
  validate(spec)
  const graph: Graph = {}
  const add = (class_type: string, inputs: Record<string, unknown>): string => {
    const id = String(Object.keys(graph).length + 1)
    graph[id] = { class_type, inputs }
    return id
  }
  const unet = add('UNETLoader', { unet_name: models.unet, weight_dtype: 'default' })
  const clip = add('CLIPLoader', { clip_name: models.textEncoder, type: 'minimax', device: 'default' })
  const videoVae = add('VAELoader', { vae_name: models.videoVae })
  const audioVae = add('VAELoader', { vae_name: models.audioVae })

  const modelChain = (): Link => {
    let model: Link = [unet, 0]
    model = [add('LoraLoaderModelOnly', { model, lora_name: models.turboLora, strength_model: spec.turboStrength }), 0]
    for (const lora of spec.loras) model = [add('LoraLoaderModelOnly', { model, lora_name: lora.name, strength_model: lora.strength }), 0]
    if (spec.sparse) {
      model = [add('BlockSparseAttention', {
        model, selection: 'sol-attn', 'selection.tau': spec.sparse.tau, start_percent: spec.sparse.start, end_percent: spec.sparse.end,
        dense_blocks: '', min_tokens: 12288, extra_tokens: 256, sink_conditioning: 'exact_kv_and_rows', verbose: false,
      }), 0]
    }
    return model
  }
  const model = modelChain()

  // Each load is (picture or frames, sound or null).
  const loads = spec.references.map((r): [Link, Link | null] => {
    if (r.role === 'reference_audio') return [[add('LoadAudio', { audio: r.name }), 0], null]
    if (r.role === 'guide_clip') {
      const parts = add('GetVideoComponents', { video: [add('LoadVideo', { file: r.name }), 0] })
      return [[parts, 0], [parts, 1]]
    }
    return [[add('LoadImage', { image: r.name }), 0], null]
  })

  const inputs: Record<string, unknown> = { clip: [clip, 0], vae: [videoVae, 0], audio_vae: [audioVae, 0], prompt: spec.prompt, width: spec.width, height: spec.height, length: spec.frames, ref_image_size: 'match' }
  let image = 0
  let audio = 0
  spec.references.forEach((r, i) => {
    if (r.role === 'reference_audio') inputs[`ref_audios.ref_audio_${audio++}`] = loads[i]![0]
    else if (r.role !== 'guide_clip') inputs[`ref_images.ref_image_${image++}`] = loads[i]![0]
  })
  const conditioning = add('MiniMaxH3ReferenceToVideo', inputs)
  const unpinned: Link = [conditioning, 0]
  const latent: Link = [conditioning, 1]

  // Keyframes and guide clips are pinned at their second with MiniMaxH3AddGuide, chained as the official template does.
  const pinned = (on: Link): Link => {
    let positive = unpinned
    spec.references.forEach((r, i) => {
      if (r.at === undefined) return
      const [picture, sound] = loads[i]!
      positive = [add('MiniMaxH3AddGuide', {
        positive, latent: on, frame_idx: frameIndex(r.at, spec.frames), vae: [videoVae, 0], image: picture,
        ...(sound ? { audio: sound, audio_vae: [audioVae, 0] } : {}),
      }), 0]
    })
    return positive
  }

  const sampler = add('KSamplerSelect', { sampler_name: spec.sampler })
  const noise = add('RandomNoise', { noise_seed: spec.seed })
  const sigmas = add('BasicScheduler', { scheduler: spec.scheduler, steps: spec.steps, denoise: 1, model })
  const guider = add('BasicGuider', { model, conditioning: pinned(latent) })
  let samples: Link = [add('SamplerCustomAdvanced', { noise: [noise, 0], guider: [guider, 0], sampler: [sampler, 0], sigmas: [sigmas, 0], latent_image: latent }), 0]

  if (spec.refine) {
    // The first pass is the draft exactly; the latent is upscaled and only the last steps are redone, pinned again on the bigger latent.
    const split = add('LTXVSeparateAVLatent', { av_latent: samples })
    const upscaled = add('MinimaxH3LatentUpscaler3D', {
      latent: [split, 0], model_name: models.upscaler, mode: 'scale by multiplier', 'mode.scale': spec.refine.scale,
      align: 32, enable_temporal_chunking: true, force_unload: true, device: 'cuda', precision: 'fp16',
    })
    const joined: Link = [add('LTXVConcatAVLatent', { video_latent: [upscaled, 0], audio_latent: [split, 1] }), 0]
    const refineModel = modelChain()
    const refineSigmas = add('ManualSigmas', { sigmas: spec.refine.sigmas.map(v => String(v)).join(', ') })
    const refineGuider = add('BasicGuider', { model: refineModel, conditioning: pinned(joined) })
    samples = [add('SamplerCustomAdvanced', { noise: [noise, 0], guider: [refineGuider, 0], sampler: [sampler, 0], sigmas: [refineSigmas, 0], latent_image: joined }), 0]
  }

  const images = add('VAEDecode', { samples, vae: [videoVae, 0] })
  const sound = add('VAEDecodeAudio', { samples, vae: [audioVae, 0] })
  const video = add('CreateVideo', { images: [images, 0], audio: [sound, 0], fps: FPS })
  add('SaveVideo', { video: [video, 0], filename_prefix: spec.prefix, format: 'mp4', 'format.codec': 'h264' })
  return graph
}

/** Inputs that name a model file, per loader class, for the preflight check. */
export const MODEL_INPUTS: Record<string, string> = {
  UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name', LoraLoaderModelOnly: 'lora_name', MinimaxH3LatentUpscaler3D: 'model_name',
}
