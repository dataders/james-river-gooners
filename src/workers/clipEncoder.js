import { pipeline, env } from '@huggingface/transformers'

// Never attempt to load local models — always fetch from Hugging Face Hub
env.allowLocalModels = false

let extractor = null

async function loadModel() {
  // v3 replaced the `quantized` boolean with `dtype`; 'q8' is the quantized
  // 8-bit model (the wasm default) — the same weights v2's `quantized: true` used.
  extractor = await pipeline('feature-extraction', 'Xenova/clip-vit-base-patch32', { dtype: 'q8' })
  self.postMessage({ type: 'ready' })
}

self.onmessage = async (e) => {
  const { type, query, id } = e.data
  if (type !== 'encode') return
  if (!extractor) return  // still loading; caller waits for 'ready' before sending

  try {
    const output = await extractor(query, { pooling: 'mean', normalize: true })
    const embedding = new Float32Array(output.data)
    self.postMessage({ type: 'embedding', id, embedding }, [embedding.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message })
  }
}

loadModel().catch(err => {
  self.postMessage({ type: 'error', message: err.message })
})
