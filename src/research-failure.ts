import type { ResearchFailure } from './shared'
export class ProviderFailure extends Error {
  constructor(
    public status: number,
    public retryAfter = 0
  ) {
    super('MusicBrainz request failed.')
  }
}
// Never persist raw network messages or provider response bodies.
export function researchFailure(error: unknown): ResearchFailure {
  const seen = new Set<unknown>()
  let current = error
  let network = false,
    timeout = false
  for (
    let depth = 0;
    current && typeof current === 'object' && depth < 8 && !seen.has(current);
    depth++
  ) {
    seen.add(current)
    if (current instanceof ProviderFailure) return { kind: 'http', status: current.status }
    const e = current as {
      name?: unknown
      code?: unknown
      cause?: unknown
      message?: unknown
    }
    if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT')
      timeout = true
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EPIPE',
        'UND_ERR_SOCKET',
        'CERT_HAS_EXPIRED',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN',
      ].includes(String(e.code))
    )
      network = true
    if (
      e.name === 'TypeError' &&
      typeof e.message === 'string' &&
      ['fetch failed', 'failed to fetch'].includes(e.message.toLowerCase())
    )
      network = true
    current = e.cause
  }
  if (timeout) return { kind: 'timeout' }
  if (network) return { kind: 'network' }
  return { kind: 'unknown' }
}
export function failureMessage(f: ResearchFailure) {
  if (f.kind === 'http') {
    if (f.status === 429)
      return 'MusicBrainz rate-limited the request (HTTP 429). Wait before starting a smaller previewed batch.'
    if (f.status === 413)
      return "MusicBrainz's response exceeded the app's safe size limit. Try a one-track batch."
    if ((f.status || 0) >= 500)
      return `MusicBrainz is temporarily unavailable (HTTP ${f.status}). Wait before previewing a new batch.`
    return `MusicBrainz rejected the request (HTTP ${f.status}). Report this diagnostic if it persists.`
  }
  if (f.kind === 'timeout')
    return 'MusicBrainz did not finish within two minutes. Try a one-track batch later.'
  if (f.kind === 'network')
    return 'Could not connect securely to MusicBrainz. Check your internet connection, VPN or firewall.'
  return 'The MusicBrainz lookup failed. No result was saved.'
}
