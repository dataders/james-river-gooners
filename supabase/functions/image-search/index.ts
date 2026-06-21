// Image Search Edge Function
//
// POST body: { imageBase64: string, mimeType: string }
// Returns:   { brand, model, category, keywords, description, searchTerms, estimatedValue,
//              productType, searchQuery, condition, brandConfidence, modelConfidence }
//
// Requires:
//   ANTHROPIC_API_KEY  — set in Supabase Edge Function secrets
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.39'
import { requireUser, jsonResponse, CORS_HEADERS } from '../_shared/auth.ts'

const VALID_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const auth = await requireUser(req)
  if ('response' in auth && auth.response) return auth.response

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return jsonResponse({ error: 'Image search is not configured (missing API key)' }, 503)
  }

  let body: { imageBase64?: string; mimeType?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const { imageBase64, mimeType = 'image/jpeg' } = body

  if (!imageBase64) {
    return jsonResponse({ error: 'imageBase64 is required' }, 400)
  }

  const safeMime = VALID_MIME_TYPES.has(mimeType) ? mimeType : 'image/jpeg'

  const anthropic = new Anthropic({ apiKey })

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    tools: [
      {
        name: 'identify_item',
        description: 'Identify an auction item from a photo for resale research',
        input_schema: {
          type: 'object',
          properties: {
            brand: {
              type: 'string',
              description: 'Manufacturer or brand name. Empty string if unknown.',
            },
            model: {
              type: 'string',
              description: 'Model name, model number, or SKU. Empty string if unknown.',
            },
            category: {
              type: 'string',
              description: 'Broad category such as Furniture, Electronics, Tools, Jewelry, Clothing, Art, Collectibles, Appliances, Sporting Goods, Books, Toys, Other.',
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: '5-8 specific search keywords that would find this item on eBay or at auction.',
            },
            description: {
              type: 'string',
              description: '1-2 sentence plain-English description useful for auction context.',
            },
            searchTerms: {
              type: 'string',
              description: 'Compact 3-6 word search phrase optimized for eBay/auction search.',
            },
            estimatedValue: {
              type: 'string',
              description: 'Rough US retail or resale market value estimate such as "$50-100". Empty string if uncertain.',
            },
            productType: {
              type: 'string',
              description: 'The plain noun for what this is (e.g. "cordless drill", "credenza"). Empty string if unclear.',
            },
            searchQuery: {
              type: 'string',
              description: 'The single best eBay sold-listings search phrase: brand + model + product type + one key attribute. Unquoted. This is what we search eBay with.',
            },
            condition: {
              type: 'string',
              enum: ['new', 'open_box', 'used', 'for_parts', ''],
              description: 'Item condition. Empty string if not determinable.',
            },
            brandConfidence: {
              type: 'string',
              enum: ['high', 'medium', 'low', ''],
              description: 'Confidence in the brand identification.',
            },
            modelConfidence: {
              type: 'string',
              enum: ['high', 'medium', 'low', ''],
              description: 'Confidence in the model identification.',
            },
          },
          required: ['brand', 'model', 'category', 'keywords', 'description', 'searchTerms', 'estimatedValue', 'productType', 'searchQuery', 'condition', 'brandConfidence', 'modelConfidence'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'identify_item' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: safeMime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: 'You are an expert auction appraiser. Identify this item so a buyer can research its resale value. Be specific about brand and model when visible. Compose a strong searchQuery: the single best eBay sold-listings phrase (brand + model + product type + one key attribute, unquoted) that we will search eBay with. Rate your brand and model confidence honestly. Focus on what makes this useful for eBay or auction price research.',
          },
        ],
      },
    ],
  })

  const toolUse = message.content.find(block => block.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    return jsonResponse({ error: 'Failed to identify item' }, 500)
  }

  return jsonResponse(toolUse.input)
})
