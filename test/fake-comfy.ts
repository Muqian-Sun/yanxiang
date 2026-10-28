/** A stand-in for the ComfyUI HTTP API the video jobs use; each prompt renders a real mp4 of the graph's length and size with ffmpeg. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Input names of the nodes the graph uses, transcribed from ComfyUI v0.42.1 (old project's tests/comfy_inputs.py). */
export const REQUIRED: Record<string, string[]> = {
  UNETLoader: ['unet_name', 'weight_dtype'], CLIPLoader: ['clip_name', 'type'], VAELoader: ['vae_name'],
  LoraLoaderModelOnly: ['model', 'lora_name', 'strength_model'], LoadImage: ['image'], LoadAudio: ['audio'], LoadVideo: ['file'],
  GetVideoComponents: ['video'], KSamplerSelect: ['sampler_name'], BasicScheduler: ['model', 'scheduler', 'steps', 'denoise'],
  RandomNoise: ['noise_seed'], BasicGuider: ['model', 'conditioning'], SamplerCustomAdvanced: ['noise', 'guider', 'sampler', 'sigmas', 'latent_image'],
  VAEDecode: ['samples', 'vae'], VAEDecodeAudio: ['samples', 'vae'], CreateVideo: ['images', 'fps'], SaveVideo: ['video', 'filename_prefix', 'format'],
  MiniMaxH3ReferenceToVideo: ['clip', 'prompt', 'width', 'height', 'length', 'ref_image_size'], MiniMaxH3AddGuide: ['positive', 'latent', 'frame_idx'],
  LTXVSeparateAVLatent: ['av_latent'], LTXVConcatAVLatent: ['video_latent', 'audio_latent'], ManualSigmas: ['sigmas'],
  MinimaxH3LatentUpscaler3D: ['latent', 'model_name', 'mode', 'align', 'enable_temporal_chunking', 'force_unload', 'device', 'precision'],
  BlockSparseAttention: ['model', 'selection', 'start_percent', 'end_percent', 'dense_blocks', 'min_tokens', 'extra_tokens', 'sink_conditioning', 'verbose'],
}
const MODEL_INPUT: Record<string, string> = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name', LoraLoaderModelOnly: 'lora_name', MinimaxH3LatentUpscaler3D: 'model_name' }

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
type Prompt = { id: string; graph: Graph; polls: number; done: boolean; file: string }

export function render(width: number, height: number, seconds: number, dest: string, tone = 440) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=24:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dest], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}

export function fakeComfy(models: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'yx-comfy-'))
  const prompts: Prompt[] = []
  const fake = {
    models: [...models],
    missingNodes: new Set<string>(),
    /** History answers {} this many times before a prompt is done. */
    pendingPolls: 1,
    /** Forget every prompt, as a restarted server does. */
    lost: false,
    uploads: [] as { folder: string; name: string; bytes: number }[],
    prompts,
    url: '',
    stop: () => server.stop(true),
  }
  const entry = (p: Prompt) => {
    const save = Object.entries(p.graph).find(([, n]) => n.class_type === 'SaveVideo')![0]
    return { status: { status_str: 'success', completed: true, messages: [] }, outputs: { [save]: { images: [{ filename: `${p.id}.mp4`, subfolder: 'yanxiang', type: 'output' }] } }, prompt: [1, p.id, p.graph, {}, [save]] }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      if (path === '/system_stats') return Response.json({ system: { comfyui_version: '0.42.1' }, devices: [{ name: 'cuda:0 fake', vram_total: 32 * 2 ** 30, vram_free: 30 * 2 ** 30 }] })
      if (path.startsWith('/object_info/')) {
        const cls = decodeURIComponent(path.slice('/object_info/'.length))
        if (fake.missingNodes.has(cls) || !REQUIRED[cls]) return Response.json({})
        const required = Object.fromEntries(REQUIRED[cls]!.map(name => [name, MODEL_INPUT[cls] === name ? [fake.models, {}] : ['*', {}]]))
        return Response.json({ [cls]: { input: { required, optional: {} } } })
      }
      if (path === '/upload/image') {
        const form = await req.formData()
        const file = form.get('image') as File
        fake.uploads.push({ folder: String(form.get('subfolder')), name: file.name, bytes: file.size })
        return Response.json({ name: file.name, subfolder: String(form.get('subfolder')), type: 'input' })
      }
      if (path === '/prompt') {
        const { prompt } = (await req.json()) as { prompt: Graph }
        const id = `p${prompts.length + 1}`
        const r2v = Object.values(prompt).find(n => n.class_type === 'MiniMaxH3ReferenceToVideo')!.inputs
        const up = Object.values(prompt).find(n => n.class_type === 'MinimaxH3LatentUpscaler3D')?.inputs['mode.scale'] as number | undefined
        const file = join(dir, `${id}.mp4`)
        render(Math.round((r2v.width as number) * (up ?? 1)), Math.round((r2v.height as number) * (up ?? 1)), (r2v.length as number) / 24, file)
        prompts.push({ id, graph: prompt, polls: 0, done: false, file })
        return Response.json({ prompt_id: id, number: prompts.length, node_errors: {} })
      }
      if (path === '/queue') return Response.json({ queue_running: fake.lost ? [] : prompts.filter(p => !p.done).map(p => [1, p.id, p.graph, {}, []]), queue_pending: [] })
      if (path === '/history') return Response.json(fake.lost ? {} : Object.fromEntries(prompts.filter(p => p.done).map(p => [p.id, entry(p)])))
      if (path.startsWith('/history/')) {
        const p = prompts.find(x => x.id === path.slice('/history/'.length))
        if (!p || fake.lost) return Response.json({})
        if (p.polls < fake.pendingPolls) {
          p.polls++
          return Response.json({})
        }
        p.done = true
        return Response.json({ [p.id]: entry(p) })
      }
      if (path === '/view') {
        const p = prompts.find(x => `${x.id}.mp4` === url.searchParams.get('filename'))
        return p ? new Response(readFileSync(p.file)) : new Response('', { status: 404 })
      }
      return new Response('', { status: 404 })
    },
  })
  fake.url = `http://127.0.0.1:${server.port}`
  return fake
}
