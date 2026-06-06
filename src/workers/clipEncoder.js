import { pipeline, env } from '@huggingface/transformers'

// Never attempt to load local models — always fetch from Hugging Face Hub
env.allowLocalModels = false

let extractor = null

async function loadModel() {
  // Encode a text query into the Nomic Embed shared text/image projection space
  // so it can be compared (dot product = cosine) against precomputed item
  // embeddings produced by the Python scraper with nomic-embed-text-v1.5 +
  // nomic-embed-vision-v1.5 — both project into the same 768-dim space.
  //
  // The feature-extraction pipeline with pooling:'mean' + normalize:true
  // returns a flat 768-element Float32Array matching the scraper's output.
  // dtype:'q8' keeps model size manageable for a browser worker.
  extractor = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', { dtype: 'q8' })
  self.postMessage({ type: 'ready' })
}

self.onmessage = async (e) => {
  const { type, query, id } = e.data
  if (type !== 'encode') return
  if (!extractor) return  // still loading; caller waits for 'ready' before sending

  try {
    // search_query: prefix matches Nomic's recommended task type for retrieval queries;
    // items were indexed with search_document: prefix.
    const output = await extractor('search_query: ' + query, { pooling: 'mean', normalize: true })
    const embedding = new Float32Array(output.data)
    self.postMessage({ type: 'embedding', id, embedding }, [embedding.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message })
  }
}

loadModel().catch(err => {
  self.postMessage({ type: 'error', message: err.message })
})
