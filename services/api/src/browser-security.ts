// Model artifacts may use the listed origins; executable scripts stay on our origin.
export const browserContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https://*.grogoni.com wss://*.grogoni.com https://*.supabase.co wss://*.supabase.co https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co https://raw.githubusercontent.com",
  "upgrade-insecure-requests"
].join("; ");
