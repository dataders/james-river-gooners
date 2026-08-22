// Facebook Marketplace listing generator — Supabase Edge Function
//
// POST body: the item object from the NDJSON read model (title, description,
// category, images, finalBid/currentBid, and optional enrichment fields).
//
// Returns: { title, description, suggestedPrice, fbCategory, fbCondition,
//            photoAssessment, photoRecommendations }
//
// Requires: OPENAI_API_KEY set as an Edge Function secret.
// Auth: requires a valid user session (Authorization: Bearer <token>).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const FB_LISTING_TOOL = {
  name: 'generate_fb_listing',
  description: 'Generate a Facebook Marketplace listing for an auction item the user has won',
  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Catchy, buyer-friendly Facebook Marketplace title. Max 100 chars. No auction jargon.',
      },
      description: {
        type: 'string',
        description: 'Conversational Facebook Marketplace description. Lead with what it is and condition, note what is included, be honest about flaws, suggest pickup/local sale. 200-500 words.',
      },
      suggestedPrice: {
        type: 'number',
        description: 'Suggested listing price in whole USD dollars. Based on paid price plus a reasonable resale margin for the item type and condition.',
      },
      fbCategory: {
        type: 'string',
        description: 'The most appropriate Facebook Marketplace category for this item.',
        enum: [
          'Antiques',
          'Apparel & Accessories',
          'Art',
          'Baby & Kids',
          'Books',
          'Collectibles',
          'Electronics',
          'Furniture',
          'Garden & Outdoor',
          'Health & Beauty',
          'Home Goods',
          'Home Improvement Supplies',
          'Jewelry & Accessories',
          'Movies & TV',
          'Music',
          'Musical Instruments',
          'Office Supplies',
          'Other',
          'Pet Supplies',
          'Sporting Goods',
          'Tools',
          'Toys & Games',
          'Vehicles',
          'Video Games & Consoles',
        ],
      },
      fbCondition: {
        type: 'string',
        description: "Condition using Facebook Marketplace's exact labels.",
        enum: ['New', 'Used - Like New', 'Used - Good', 'Used - Fair', 'Used - Poor', 'For parts or not working'],
      },
      photoAssessment: {
        type: 'array',
        description: 'Assessment of each provided photo for a Facebook Marketplace listing.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '0-based index of the photo' },
            usable: { type: 'boolean', description: 'Good enough to use on Facebook Marketplace' },
            notes: { type: 'string', description: 'Brief note on why usable or not' },
          },
          required: ['index', 'usable', 'notes'],
          additionalProperties: false,
        },
      },
      photoRecommendations: {
        type: 'array',
        description: 'Specific additional shots the seller should take if auction photos are lacking.',
        items: { type: 'string' },
      },
    },
    required: ['title', 'description', 'suggestedPrice', 'fbCategory', 'fbCondition', 'photoAssessment', 'photoRecommendations'],
    additionalProperties: false,
  },
}

function buildUserMessage(item: Record<string, unknown>): unknown[] {
  const parts: unknown[] = []

  // Add images (up to 5, passed as URLs)
  const images = Array.isArray(item.images) ? item.images as string[] : []
  for (let i = 0; i < Math.min(images.length, 5); i++) {
    parts.push({ type: 'input_image', image_url: images[i] })
  }

  const lines: string[] = []
  lines.push(`Auction title: ${item.title ?? 'Unknown'}`)
  const brand = item.brand as string | undefined
  const model = item.modelOrSku as string | undefined
  if (brand || model) lines.push(`Product: ${[brand, model].filter(Boolean).join(' ')}`)
  const condition = item.condition as string | undefined
  if (condition && condition !== 'unknown') lines.push(`Condition (AI-assessed): ${condition}`)
  lines.push(`Category: ${(item.category as string | undefined) ?? 'Unknown'}`)
  const pricePaid = (item.finalBid ?? item.currentBid ?? 0) as number
  lines.push(`Amount paid at auction: $${pricePaid}`)
  if (item.description) lines.push(`\nAuction description:\n${item.description as string}`)

  parts.push({ type: 'input_text', text: lines.join('\n') })
  return parts
}

function responseText(body: Record<string, unknown>): string {
  const output = Array.isArray(body.output) ? body.output : []
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : []
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'output_text' && typeof block.text === 'string') return block.text
    }
  }
  return ''
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    )
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const openaiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiKey) {
      return new Response(JSON.stringify({ error: 'Service not configured' }), {
        status: 503,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const item = await req.json()

    const aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        max_output_tokens: 1800,
        reasoning: { effort: 'low' },
        instructions: `You help people resell items they won at auction on Facebook Marketplace.
Given the auction listing details and photos, generate an optimized Facebook Marketplace listing.

Guidelines:
- Title: clear, searchable, buyer-friendly. No "Lot -" placeholders. Max 100 chars.
- Description: conversational, not auction-style. Lead with what it is and condition. Note what's included, any known flaws. Honest and helpful. 200-500 words.
- Price: suggest a fair resale price. The person paid the auction amount; suggest a competitive price that gives a reasonable margin (typically 30-100% above cost for most items, more for jewelry/art/collectibles).
- Photos: the provided images are from the auction house. Assess each honestly — Facebook Marketplace buyers want clear, natural photos showing actual condition. Recommend any additional shots needed.`,
        input: [{ role: 'user', content: buildUserMessage(item) }],
        text: {
          format: {
            type: 'json_schema',
            name: FB_LISTING_TOOL.name,
            strict: true,
            schema: FB_LISTING_TOOL.schema,
          },
        },
      }),
    })

    if (!aiRes.ok) {
      console.error('OpenAI API error:', await aiRes.text())
      return new Response(JSON.stringify({ error: 'AI service error' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const aiBody = await aiRes.json() as Record<string, unknown>
    const text = responseText(aiBody)
    if (!text) {
      console.error('Unexpected AI response:', JSON.stringify(aiBody))
      return new Response(JSON.stringify({ error: 'Unexpected AI response' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify(JSON.parse(text)), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('facebook-listing error:', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
