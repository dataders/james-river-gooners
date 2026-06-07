import { pipeline, env } from '@huggingface/transformers'

// Never attempt to load local models — always fetch from Hugging Face Hub
env.allowLocalModels = false

// Encode the text query with nomic-embed-text-v1.5 — the same model the Python
// scraper uses for the item vectors stored in Supabase pgvector, so the query
// and item embeddings share one 768-dim space. Nomic is task-prefixed: queries
// use "search_query:" (documents used "search_document:" at index time). We
// mean-pool the token embeddings and L2-normalize so the server-side cosine
// search (<=>) is comparing like with like. `dtype: 'q8'` keeps the quantized
// 8-bit weights for a small download (matches the old CLIP worker).
let extractor = null

async function loadModel() {
  extractor = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', {
    dtype: 'q8',
  })
  self.postMessage({ type: 'ready' })
}

self.onmessage = async (e) => {
  const { type, query, id } = e.data
  if (type !== 'encode') return
  if (!extractor) return // still loading; caller waits for 'ready' before sending

  try {
    const output = await extractor(`search_query: ${query}`, {
      pooling: 'mean',
      normalize: true,
    })
    // Copy into a transferable Float32Array (output.data is a typed view).
    const embedding = new Float32Array(output.data)
    self.postMessage({ type: 'embedding', id, embedding }, [embedding.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message })
  }
}

loadModel().catch(err => {
  self.postMessage({ type: 'error', message: err.message })
})
