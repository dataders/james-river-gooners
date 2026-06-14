/// <reference types="vite/client" />

// Typed env vars. With `noPropertyAccessFromIndexSignature` on (tsconfig),
// `import.meta.env.VITE_FOO` against vite's default index signature is an
// error — and declaring them here also turns a typo'd var name into a compile
// error instead of a silent `undefined`. All optional: the app degrades
// gracefully when a key is absent (see src/lib/supabase.js, telemetry.js).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_POSTHOG_KEY?: string
  readonly VITE_POSTHOG_HOST?: string
  readonly VITE_HF_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
