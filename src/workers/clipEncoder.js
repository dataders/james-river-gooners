import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers'

// Never attempt to load local models — always fetch from Hugging Face Hub
env.allowLocalModels = false

let tokenizer = null
let textModel = null

async function loadModel() {
  // Encode the text query into CLIP's shared text/image projection space so it
  // can be compared (dot product = cosine) against the precomputed image
  // embeddings, which the Python scraper produces with sentence-transformers
  // clip-ViT-B-32 — also projected and L2-normalized.
  //
  // transformers.js v4 note: the old `feature-extraction` pipeline loads the
  // *full* CLIP model, which demands `pixel_values` and throws on text input.
  // CLIPTextModelWithProjection runs only the text tower and returns the
  // projected `text_embeds` — the correct CLIP text embedding. `dtype: 'q8'`
  // keeps the quantized 8-bit weights (the wasm default).
  tokenizer = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32')
  textModel = await CLIPTextModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', { dtype: 'q8' })
  self.postMessage({ type: 'ready' })
}

self.onmessage = async (e) => {
  const { type, query, id } = e.data
  if (type !== 'encode') return
  if (!tokenizer || !textModel) return  // still loading; caller waits for 'ready' before sending

  try {
    const inputs = tokenizer([query], { padding: true, truncation: true })
    const { text_embeds } = await textModel(inputs)
    // L2-normalize so the consumer's dot product equals cosine similarity
    // (stored image embeddings are L2-normalized too).
    const raw = text_embeds.data
    let norm = 0
    for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i]
    norm = Math.sqrt(norm) || 1
    const embedding = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) embedding[i] = raw[i] / norm
    self.postMessage({ type: 'embedding', id, embedding }, [embedding.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message })
  }
}

loadModel().catch(err => {
  self.postMessage({ type: 'error', message: err.message })
})
