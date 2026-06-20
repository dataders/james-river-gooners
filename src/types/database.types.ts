// AUTO-GENERATED Supabase database types — do NOT edit by hand.
// Regenerate with `npm run gen:types` (see scripts/gen-types.sh) whenever a
// migration under supabase/migrations/ changes the schema. The Supabase view/
// table/function shapes here are the source of truth the typed browser client
// (src/lib/supabase.js) flows into the data hooks.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cannon_credentials: {
        Row: {
          cannon_password_enc: string
          cannon_username: string
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cannon_password_enc: string
          cannon_username: string
          created_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cannon_password_enc?: string
          cannon_username?: string
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      cannons_comp_snapshots: {
        Row: {
          auction_safe_id: string
          auction_title: string | null
          detail_url: string | null
          generated_at: string
          id: number
          ingested_at: string
          item_id: string
          match_title: string | null
          rank: number
          similarity: number | null
          sold_date: string | null
          sold_price: number | null
          source: string | null
          thumbnail_url: string | null
        }
        Insert: {
          auction_safe_id: string
          auction_title?: string | null
          detail_url?: string | null
          generated_at: string
          id?: never
          ingested_at?: string
          item_id: string
          match_title?: string | null
          rank?: number
          similarity?: number | null
          sold_date?: string | null
          sold_price?: number | null
          source?: string | null
          thumbnail_url?: string | null
        }
        Update: {
          auction_safe_id?: string
          auction_title?: string | null
          detail_url?: string | null
          generated_at?: string
          id?: never
          ingested_at?: string
          item_id?: string
          match_title?: string | null
          rank?: number
          similarity?: number | null
          sold_date?: string | null
          sold_price?: number | null
          source?: string | null
          thumbnail_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      comp_quality_eval: {
        Row: {
          arm: string
          auction_safe_id: string
          created_at: string
          ebay_item_id: string | null
          item_id: string
          query: string | null
          rank: number | null
          run_id: string
          similarity: number | null
          sold_date: string | null
          sold_price: number | null
          title: string | null
        }
        Insert: {
          arm: string
          auction_safe_id: string
          created_at?: string
          ebay_item_id?: string | null
          item_id: string
          query?: string | null
          rank?: number | null
          run_id: string
          similarity?: number | null
          sold_date?: string | null
          sold_price?: number | null
          title?: string | null
        }
        Update: {
          arm?: string
          auction_safe_id?: string
          created_at?: string
          ebay_item_id?: string | null
          item_id?: string
          query?: string | null
          rank?: number | null
          run_id?: string
          similarity?: number | null
          sold_date?: string | null
          sold_price?: number | null
          title?: string | null
        }
        Relationships: []
      }
      ebay_categories: {
        Row: {
          category_id: string
          full_path: string
          leaf: boolean
          level: number
          name: string
          parent_id: string | null
          updated_at: string
        }
        Insert: {
          category_id: string
          full_path: string
          leaf?: boolean
          level: number
          name: string
          parent_id?: string | null
          updated_at?: string
        }
        Update: {
          category_id?: string
          full_path?: string
          leaf?: boolean
          level?: number
          name?: string
          parent_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ebay_comp_snapshots: {
        Row: {
          auction_id: string | null
          auction_safe_id: string | null
          cannons_description: string | null
          cannons_title: string | null
          condition: string | null
          current_bid: number | null
          detail_url: string | null
          ebay_item_id: string | null
          fetched_at: string | null
          id: number
          ingested_at: string
          item_id: string | null
          item_web_url: string | null
          lot_number: number | null
          match_confidence: string | null
          price_currency: string | null
          price_value: number | null
          query: string | null
          raw_match_json: string | null
          search_url: string | null
          shipping_label: string | null
          sold_date: string | null
          sold_date_label: string | null
          source_query: string | null
          status: string | null
          thumbnail_url: string | null
          title: string | null
          total_bids: number | null
          warning: string | null
        }
        Insert: {
          auction_id?: string | null
          auction_safe_id?: string | null
          cannons_description?: string | null
          cannons_title?: string | null
          condition?: string | null
          current_bid?: number | null
          detail_url?: string | null
          ebay_item_id?: string | null
          fetched_at?: string | null
          id?: never
          ingested_at?: string
          item_id?: string | null
          item_web_url?: string | null
          lot_number?: number | null
          match_confidence?: string | null
          price_currency?: string | null
          price_value?: number | null
          query?: string | null
          raw_match_json?: string | null
          search_url?: string | null
          shipping_label?: string | null
          sold_date?: string | null
          sold_date_label?: string | null
          source_query?: string | null
          status?: string | null
          thumbnail_url?: string | null
          title?: string | null
          total_bids?: number | null
          warning?: string | null
        }
        Update: {
          auction_id?: string | null
          auction_safe_id?: string | null
          cannons_description?: string | null
          cannons_title?: string | null
          condition?: string | null
          current_bid?: number | null
          detail_url?: string | null
          ebay_item_id?: string | null
          fetched_at?: string | null
          id?: never
          ingested_at?: string
          item_id?: string | null
          item_web_url?: string | null
          lot_number?: number | null
          match_confidence?: string | null
          price_currency?: string | null
          price_value?: number | null
          query?: string | null
          raw_match_json?: string | null
          search_url?: string | null
          shipping_label?: string | null
          sold_date?: string | null
          sold_date_label?: string | null
          source_query?: string | null
          status?: string | null
          thumbnail_url?: string | null
          title?: string | null
          total_bids?: number | null
          warning?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      enrich_runs: {
        Row: {
          auction_safe_id: string | null
          est_cost_usd: number | null
          id: number
          input_tokens: number | null
          lots_enriched: number | null
          lots_submitted: number | null
          mode: string | null
          model: string | null
          observed_at: string
          output_tokens: number | null
          raw: Json | null
          schema_version: string | null
        }
        Insert: {
          auction_safe_id?: string | null
          est_cost_usd?: number | null
          id?: never
          input_tokens?: number | null
          lots_enriched?: number | null
          lots_submitted?: number | null
          mode?: string | null
          model?: string | null
          observed_at?: string
          output_tokens?: number | null
          raw?: Json | null
          schema_version?: string | null
        }
        Update: {
          auction_safe_id?: string | null
          est_cost_usd?: number | null
          id?: never
          input_tokens?: number | null
          lots_enriched?: number | null
          lots_submitted?: number | null
          mode?: string | null
          model?: string | null
          observed_at?: string
          output_tokens?: number | null
          raw?: Json | null
          schema_version?: string | null
        }
        Relationships: []
      }
      enrichment_seen: {
        Row: {
          auction_safe_id: string
          input_hash: string
          item_id: string
          updated_at: string
        }
        Insert: {
          auction_safe_id: string
          input_hash: string
          item_id: string
          updated_at?: string
        }
        Update: {
          auction_safe_id?: string
          input_hash?: string
          item_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      eval_embeddings: {
        Row: {
          auction_safe_id: string
          category: string | null
          description: string | null
          embedding: string
          item_id: string
          n_images: number | null
          title: string | null
        }
        Insert: {
          auction_safe_id: string
          category?: string | null
          description?: string | null
          embedding: string
          item_id: string
          n_images?: number | null
          title?: string | null
        }
        Update: {
          auction_safe_id?: string
          category?: string | null
          description?: string | null
          embedding?: string
          item_id?: string
          n_images?: number | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "eval_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      favorites: {
        Row: {
          created_at: string
          item_key: string
          user_id: string
        }
        Insert: {
          created_at?: string
          item_key: string
          user_id: string
        }
        Update: {
          created_at?: string
          item_key?: string
          user_id?: string
        }
        Relationships: []
      }
      filter_preferences: {
        Row: {
          prefs: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          prefs?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          prefs?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ignored: {
        Row: {
          created_at: string
          item_key: string
          user_id: string
        }
        Insert: {
          created_at?: string
          item_key: string
          user_id: string
        }
        Update: {
          created_at?: string
          item_key?: string
          user_id?: string
        }
        Relationships: []
      }
      lot_enrichment: {
        Row: {
          auction_id: string | null
          auction_safe_id: string
          auction_title: string | null
          brand: string | null
          brand_confidence: string | null
          category: string | null
          condition: string | null
          condition_flags: string | null
          confidence: string | null
          detail_category: string | null
          detail_confidence: string | null
          detail_url: string | null
          details: string | null
          image_url: string | null
          input_hash: string | null
          is_mixed_lot: string | null
          item_id: string
          key_attributes: string | null
          lot_number: number | null
          model: string | null
          model_confidence: string | null
          model_or_sku: string | null
          notes: string | null
          product_type: string | null
          product_url: string | null
          quantity: string | null
          raw_category: string | null
          schema_version: string | null
          search_query: string | null
          secondary_items: string | null
          source: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          auction_id?: string | null
          auction_safe_id: string
          auction_title?: string | null
          brand?: string | null
          brand_confidence?: string | null
          category?: string | null
          condition?: string | null
          condition_flags?: string | null
          confidence?: string | null
          detail_category?: string | null
          detail_confidence?: string | null
          detail_url?: string | null
          details?: string | null
          image_url?: string | null
          input_hash?: string | null
          is_mixed_lot?: string | null
          item_id: string
          key_attributes?: string | null
          lot_number?: number | null
          model?: string | null
          model_confidence?: string | null
          model_or_sku?: string | null
          notes?: string | null
          product_type?: string | null
          product_url?: string | null
          quantity?: string | null
          raw_category?: string | null
          schema_version?: string | null
          search_query?: string | null
          secondary_items?: string | null
          source?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          auction_id?: string | null
          auction_safe_id?: string
          auction_title?: string | null
          brand?: string | null
          brand_confidence?: string | null
          category?: string | null
          condition?: string | null
          condition_flags?: string | null
          confidence?: string | null
          detail_category?: string | null
          detail_confidence?: string | null
          detail_url?: string | null
          details?: string | null
          image_url?: string | null
          input_hash?: string | null
          is_mixed_lot?: string | null
          item_id?: string
          key_attributes?: string | null
          lot_number?: number | null
          model?: string | null
          model_confidence?: string | null
          model_or_sku?: string | null
          notes?: string | null
          product_type?: string | null
          product_url?: string | null
          quantity?: string | null
          raw_category?: string | null
          schema_version?: string | null
          search_query?: string | null
          secondary_items?: string | null
          source?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      lot_enrichment_history: {
        Row: {
          auction_safe_id: string
          brand: string | null
          confidence: string | null
          detail_category: string | null
          detail_confidence: string | null
          details: string | null
          enriched_at: string
          id: number
          input_hash: string | null
          item_id: string
          model: string | null
          model_or_sku: string | null
          product_type: string | null
          schema_version: string | null
          search_query: string | null
        }
        Insert: {
          auction_safe_id: string
          brand?: string | null
          confidence?: string | null
          detail_category?: string | null
          detail_confidence?: string | null
          details?: string | null
          enriched_at?: string
          id?: never
          input_hash?: string | null
          item_id: string
          model?: string | null
          model_or_sku?: string | null
          product_type?: string | null
          schema_version?: string | null
          search_query?: string | null
        }
        Update: {
          auction_safe_id?: string
          brand?: string | null
          confidence?: string | null
          detail_category?: string | null
          detail_confidence?: string | null
          details?: string | null
          enriched_at?: string
          id?: never
          input_hash?: string | null
          item_id?: string
          model?: string | null
          model_or_sku?: string | null
          product_type?: string | null
          schema_version?: string | null
          search_query?: string | null
        }
        Relationships: []
      }
      lots: {
        Row: {
          archived: boolean
          auction_end_date: string | null
          auction_id: string | null
          auction_safe_id: string
          auction_title: string | null
          category: string | null
          closed: boolean | null
          current_bid: number | null
          description: string | null
          detail_url: string | null
          end_date: string | null
          final_bid: number | null
          images: string[] | null
          item_id: string
          lot_number: number | null
          raw_category: string | null
          scraped_at: string | null
          sold_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
          updated_at: string
        }
        Insert: {
          archived?: boolean
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id: string
          auction_title?: string | null
          category?: string | null
          closed?: boolean | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          final_bid?: number | null
          images?: string[] | null
          item_id: string
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          sold_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
          updated_at?: string
        }
        Update: {
          archived?: boolean
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string
          auction_title?: string | null
          category?: string | null
          closed?: boolean | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          final_bid?: number | null
          images?: string[] | null
          item_id?: string
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          sold_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      nomic_embeddings: {
        Row: {
          auction_safe_id: string
          embedding: string
          generated_at: string
          item_id: string
          model: string
          n_images: number
        }
        Insert: {
          auction_safe_id: string
          embedding: string
          generated_at?: string
          item_id: string
          model?: string
          n_images?: number
        }
        Update: {
          auction_safe_id?: string
          embedding?: string
          generated_at?: string
          item_id?: string
          model?: string
          n_images?: number
        }
        Relationships: [
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "nomic_embeddings_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      sold_listing_embeddings: {
        Row: {
          ebay_item_id: string
          embedding: string
          generated_at: string
          model: string
          n_images: number
        }
        Insert: {
          ebay_item_id: string
          embedding: string
          generated_at?: string
          model?: string
          n_images?: number
        }
        Update: {
          ebay_item_id?: string
          embedding?: string
          generated_at?: string
          model?: string
          n_images?: number
        }
        Relationships: [
          {
            foreignKeyName: "sold_listing_embeddings_listing_fkey"
            columns: ["ebay_item_id"]
            isOneToOne: true
            referencedRelation: "sold_listings"
            referencedColumns: ["ebay_item_id"]
          },
        ]
      }
      sold_listings: {
        Row: {
          category_id: string | null
          condition: string | null
          condition_id: string | null
          ebay_item_id: string
          epid: string | null
          first_seen_at: string
          full_res_thumbnail_url: string | null
          item_web_url: string | null
          last_seen_at: string
          provider_scraped_at: string | null
          raw_json: Json | null
          seen_count: number
          seller_feedback_score: number | null
          seller_positive_pct: number | null
          seller_type: string | null
          seller_username: string | null
          shipping_currency: string | null
          shipping_price: number | null
          shipping_type: string | null
          sold_currency: string | null
          sold_date: string | null
          sold_date_label: string | null
          sold_price: number | null
          source_query: string | null
          thumbnail_url: string | null
          title: string | null
          total_price: number | null
        }
        Insert: {
          category_id?: string | null
          condition?: string | null
          condition_id?: string | null
          ebay_item_id: string
          epid?: string | null
          first_seen_at?: string
          full_res_thumbnail_url?: string | null
          item_web_url?: string | null
          last_seen_at?: string
          provider_scraped_at?: string | null
          raw_json?: Json | null
          seen_count?: number
          seller_feedback_score?: number | null
          seller_positive_pct?: number | null
          seller_type?: string | null
          seller_username?: string | null
          shipping_currency?: string | null
          shipping_price?: number | null
          shipping_type?: string | null
          sold_currency?: string | null
          sold_date?: string | null
          sold_date_label?: string | null
          sold_price?: number | null
          source_query?: string | null
          thumbnail_url?: string | null
          title?: string | null
          total_price?: number | null
        }
        Update: {
          category_id?: string | null
          condition?: string | null
          condition_id?: string | null
          ebay_item_id?: string
          epid?: string | null
          first_seen_at?: string
          full_res_thumbnail_url?: string | null
          item_web_url?: string | null
          last_seen_at?: string
          provider_scraped_at?: string | null
          raw_json?: Json | null
          seen_count?: number
          seller_feedback_score?: number | null
          seller_positive_pct?: number | null
          seller_type?: string | null
          seller_username?: string | null
          shipping_currency?: string | null
          shipping_price?: number | null
          shipping_type?: string | null
          sold_currency?: string | null
          sold_date?: string | null
          sold_date_label?: string | null
          sold_price?: number | null
          source_query?: string | null
          thumbnail_url?: string | null
          title?: string | null
          total_price?: number | null
        }
        Relationships: []
      }
      soldcomps_usage: {
        Row: {
          id: number
          observed_at: string
          raw: Json | null
          remaining: number
        }
        Insert: {
          id?: never
          observed_at?: string
          raw?: Json | null
          remaining: number
        }
        Update: {
          id?: never
          observed_at?: string
          raw?: Json | null
          remaining?: number
        }
        Relationships: []
      }
      user_bids: {
        Row: {
          auction_id: string | null
          auction_item_id: string
          auction_safe_id: string | null
          bid_amount: number | null
          current_bid: number | null
          first_bid_at: string
          id: string
          is_winning: boolean | null
          item_category: string | null
          item_closed: boolean
          item_title: string | null
          last_bid_at: string
          min_next_bid: number | null
          status_refreshed_at: string | null
          user_id: string
        }
        Insert: {
          auction_id?: string | null
          auction_item_id: string
          auction_safe_id?: string | null
          bid_amount?: number | null
          current_bid?: number | null
          first_bid_at?: string
          id?: string
          is_winning?: boolean | null
          item_category?: string | null
          item_closed?: boolean
          item_title?: string | null
          last_bid_at?: string
          min_next_bid?: number | null
          status_refreshed_at?: string | null
          user_id: string
        }
        Update: {
          auction_id?: string | null
          auction_item_id?: string
          auction_safe_id?: string | null
          bid_amount?: number | null
          current_bid?: number | null
          first_bid_at?: string
          id?: string
          is_winning?: boolean | null
          item_category?: string | null
          item_closed?: boolean
          item_title?: string | null
          last_bid_at?: string
          min_next_bid?: number | null
          status_refreshed_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_feedback: {
        Row: {
          github_issue_url: string | null
          id: string
          message: string
          processed_at: string | null
          submitted_at: string | null
          user_email: string | null
        }
        Insert: {
          github_issue_url?: string | null
          id?: string
          message: string
          processed_at?: string | null
          submitted_at?: string | null
          user_email?: string | null
        }
        Update: {
          github_issue_url?: string | null
          id?: string
          message?: string
          processed_at?: string | null
          submitted_at?: string | null
          user_email?: string | null
        }
        Relationships: []
      }
      users: {
        Row: {
          cannon_bidder_id: string | null
          email: string | null
          first_seen_at: string
          id: string
          last_sign_in_at: string | null
        }
        Insert: {
          cannon_bidder_id?: string | null
          email?: string | null
          first_seen_at?: string
          id: string
          last_sign_in_at?: string | null
        }
        Update: {
          cannon_bidder_id?: string | null
          email?: string | null
          first_seen_at?: string
          id?: string
          last_sign_in_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      comp_item_freshness: {
        Row: {
          auction_safe_id: string | null
          item_id: string | null
          last_fetched_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      comp_query_attempts: {
        Row: {
          auction_safe_id: string | null
          fetched_at: string | null
          item_id: string | null
          source_query: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      public_active_lots: {
        Row: {
          auction_end_date: string | null
          auction_id: string | null
          auction_safe_id: string | null
          auction_title: string | null
          category: string | null
          current_bid: number | null
          description: string | null
          detail_url: string | null
          end_date: string | null
          images: string[] | null
          item_id: string | null
          lot_number: number | null
          raw_category: string | null
          scraped_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
        }
        Insert: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          images?: string[] | null
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Update: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          images?: string[] | null
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Relationships: []
      }
      public_active_lots_card: {
        Row: {
          auction_end_date: string | null
          auction_id: string | null
          auction_safe_id: string | null
          auction_title: string | null
          category: string | null
          current_bid: number | null
          description: string | null
          detail_url: string | null
          end_date: string | null
          images: string[] | null
          item_id: string | null
          lot_number: number | null
          raw_category: string | null
          scraped_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
        }
        Insert: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          images?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Update: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          images?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Relationships: []
      }
      public_archived_lots: {
        Row: {
          auction_end_date: string | null
          auction_id: string | null
          auction_safe_id: string | null
          auction_title: string | null
          category: string | null
          closed: boolean | null
          current_bid: number | null
          description: string | null
          detail_url: string | null
          end_date: string | null
          final_bid: number | null
          images: string[] | null
          item_id: string | null
          lot_number: number | null
          raw_category: string | null
          scraped_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
        }
        Insert: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          closed?: boolean | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          final_bid?: number | null
          images?: string[] | null
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Update: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          closed?: boolean | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          final_bid?: number | null
          images?: string[] | null
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Relationships: []
      }
      public_archived_lots_card: {
        Row: {
          auction_end_date: string | null
          auction_id: string | null
          auction_safe_id: string | null
          auction_title: string | null
          category: string | null
          closed: boolean | null
          current_bid: number | null
          description: string | null
          detail_url: string | null
          end_date: string | null
          final_bid: number | null
          images: string[] | null
          item_id: string | null
          lot_number: number | null
          raw_category: string | null
          scraped_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
        }
        Insert: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          closed?: boolean | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          final_bid?: number | null
          images?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Update: {
          auction_end_date?: string | null
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          closed?: boolean | null
          current_bid?: number | null
          description?: string | null
          detail_url?: string | null
          end_date?: string | null
          final_bid?: number | null
          images?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          scraped_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Relationships: []
      }
      public_auction_comps: {
        Row: {
          auction_safe_id: string | null
          condition: string | null
          ebay_item_id: string | null
          fetched_at: string | null
          item_id: string | null
          item_web_url: string | null
          match_confidence: string | null
          price_currency: string | null
          price_value: number | null
          query: string | null
          search_url: string | null
          shipping_label: string | null
          sold_date: string | null
          sold_date_label: string | null
          source_query: string | null
          status: string | null
          thumbnail_url: string | null
          title: string | null
          warning: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "ebay_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      public_cannons_comps: {
        Row: {
          auction_safe_id: string | null
          auction_title: string | null
          detail_url: string | null
          item_id: string | null
          match_title: string | null
          rank: number | null
          similarity: number | null
          sold_date: string | null
          sold_price: number | null
          source: string | null
          thumbnail_url: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "cannons_comp_snapshots_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: false
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      public_category_sold_stats: {
        Row: {
          category: string | null
          last_sold_at: string | null
          max_sold: number | null
          median_sold: number | null
          min_sold: number | null
          sold_count: number | null
        }
        Relationships: []
      }
      public_lot_enrichment: {
        Row: {
          auction_id: string | null
          auction_safe_id: string | null
          auction_title: string | null
          brand: string | null
          brand_confidence: string | null
          category: string | null
          condition: string | null
          condition_flags: string | null
          confidence: string | null
          detail_category: string | null
          detail_confidence: string | null
          detail_url: string | null
          details: string | null
          image_url: string | null
          is_mixed_lot: string | null
          item_id: string | null
          key_attributes: string | null
          lot_number: number | null
          model: string | null
          model_confidence: string | null
          model_or_sku: string | null
          notes: string | null
          product_type: string | null
          product_url: string | null
          quantity: string | null
          raw_category: string | null
          schema_version: string | null
          search_query: string | null
          secondary_items: string | null
          source: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          brand?: string | null
          brand_confidence?: string | null
          category?: string | null
          condition?: string | null
          condition_flags?: string | null
          confidence?: string | null
          detail_category?: string | null
          detail_confidence?: string | null
          detail_url?: string | null
          details?: string | null
          image_url?: string | null
          is_mixed_lot?: string | null
          item_id?: string | null
          key_attributes?: string | null
          lot_number?: number | null
          model?: string | null
          model_confidence?: string | null
          model_or_sku?: string | null
          notes?: string | null
          product_type?: string | null
          product_url?: string | null
          quantity?: string | null
          raw_category?: string | null
          schema_version?: string | null
          search_query?: string | null
          secondary_items?: string | null
          source?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          brand?: string | null
          brand_confidence?: string | null
          category?: string | null
          condition?: string | null
          condition_flags?: string | null
          confidence?: string | null
          detail_category?: string | null
          detail_confidence?: string | null
          detail_url?: string | null
          details?: string | null
          image_url?: string | null
          is_mixed_lot?: string | null
          item_id?: string | null
          key_attributes?: string | null
          lot_number?: number | null
          model?: string | null
          model_confidence?: string | null
          model_or_sku?: string | null
          notes?: string | null
          product_type?: string | null
          product_url?: string | null
          quantity?: string | null
          raw_category?: string | null
          schema_version?: string | null
          search_query?: string | null
          secondary_items?: string | null
          source?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_active_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_archived_lots_card"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "public_sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
          {
            foreignKeyName: "lot_enrichment_lot_fkey"
            columns: ["auction_safe_id", "item_id"]
            isOneToOne: true
            referencedRelation: "sold_lots"
            referencedColumns: ["auction_safe_id", "item_id"]
          },
        ]
      }
      public_sold_lots: {
        Row: {
          auction_safe_id: string | null
          auction_title: string | null
          category: string | null
          description: string | null
          detail_url: string | null
          final_bid: number | null
          image_url: string | null
          item_id: string | null
          lot_number: number | null
          raw_category: string | null
          sold_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
        }
        Insert: {
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          description?: string | null
          detail_url?: string | null
          final_bid?: number | null
          image_url?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          sold_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Update: {
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          description?: string | null
          detail_url?: string | null
          final_bid?: number | null
          image_url?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          sold_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
        }
        Relationships: []
      }
      sold_lots: {
        Row: {
          auction_id: string | null
          auction_safe_id: string | null
          auction_title: string | null
          category: string | null
          description: string | null
          detail_url: string | null
          final_bid: number | null
          image_url: string | null
          item_id: string | null
          lot_number: number | null
          raw_category: string | null
          sold_at: string | null
          source: string | null
          title: string | null
          total_bids: number | null
          unique_bidders: number | null
          updated_at: string | null
        }
        Insert: {
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          description?: string | null
          detail_url?: string | null
          final_bid?: number | null
          image_url?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          sold_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
          updated_at?: string | null
        }
        Update: {
          auction_id?: string | null
          auction_safe_id?: string | null
          auction_title?: string | null
          category?: string | null
          description?: string | null
          detail_url?: string | null
          final_bid?: number | null
          image_url?: never
          item_id?: string | null
          lot_number?: number | null
          raw_category?: string | null
          sold_at?: string | null
          source?: string | null
          title?: string | null
          total_bids?: number | null
          unique_bidders?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      get_active_lot_filter_bounds: {
        Args: never
        Returns: {
          bidders_p99: number
          bids_p99: number
          price_p99: number
        }[]
      }
      match_cannons_comps: {
        Args: { active_auction: string; match_count?: number; min_sim?: number }
        Returns: {
          auction_title: string
          comp_auction_safe_id: string
          comp_item_id: string
          detail_url: string
          image_url: string
          item_id: string
          similarity: number
          sold_at: string
          sold_price: number
          source: string
          title: string
        }[]
      }
      match_lots: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          auction_safe_id: string
          item_id: string
          similarity: number
        }[]
      }
      match_lots_eval: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          auction_safe_id: string
          category: string
          item_id: string
          similarity: number
          title: string
        }[]
      }
      match_sold_listings: {
        Args: { active_auction: string; match_count?: number; min_sim?: number }
        Returns: {
          condition: string
          ebay_item_id: string
          item_id: string
          item_web_url: string
          similarity: number
          sold_date: string
          sold_date_label: string
          sold_price: number
          thumbnail_url: string
          title: string
        }[]
      }
      match_sold_listings_for_item: {
        Args: {
          match_count?: number
          min_sim?: number
          p_auction_safe_id: string
          p_item_id: string
        }
        Returns: {
          condition: string
          ebay_item_id: string
          item_web_url: string
          similarity: number
          sold_date: string
          sold_date_label: string
          sold_price: number
          thumbnail_url: string
          title: string
        }[]
      }
      rank_for_you: {
        Args: {
          history_auction_ids: string[]
          history_item_ids: string[]
          ignored_auction_ids?: string[]
          ignored_item_ids?: string[]
          ignored_weight?: number
          target_auction_ids: string[]
        }
        Returns: {
          auction_safe_id: string
          item_id: string
          similarity: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
