import { pipeline, env } from '@xenova/transformers'

// Never attempt to load local models — always fetch from Hugging Face Hub
env.allowLocalModels = false

let extractor = null

async function loadModel() {
  extractor = await pipeline('feature-extraction', 'Xenova/clip-vit-base-patch32', { quantized: true })
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
