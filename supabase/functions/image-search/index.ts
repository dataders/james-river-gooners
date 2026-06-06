// Image Search Edge Function
//
// POST body: { imageBase64: string, mimeType: string }
// Returns:   { brand, model, category, keywords, description, searchTerms, estimatedValue }
//
// Requires:
//   ANTHROPIC_API_KEY  — set in Supabase Edge Function secrets
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.39'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Verify JWT belongs to an authenticated user
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Image search is not configured (missing API key)' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  let body: { imageBase64?: string; mimeType?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const { imageBase64, mimeType = 'image/jpeg' } = body

  if (!imageBase64) {
    return new Response(JSON.stringify({ error: 'imageBase64 is required' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
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
          },
          required: ['brand', 'model', 'category', 'keywords', 'description', 'searchTerms', 'estimatedValue'],
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
            text: 'You are an expert auction appraiser. Identify this item so a buyer can research its resale value. Be specific about brand and model when visible. Focus on what makes this useful for eBay or auction price research.',
          },
        ],
      },
    ],
  })

  const toolUse = message.content.find(block => block.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    return new Response(JSON.stringify({ error: 'Failed to identify item' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify(toolUse.input), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
})
