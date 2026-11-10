/** st_dev may change after remounting a volume. Keep journal keys unchanged. */
export function stablePhysicalKey(key: string): string {
  const parts = key.split('|')
  if (
    parts.length !== 4 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parts[0]!)
  )
    return key
  return `${parts[0]!.toLowerCase()}|${parts[2]}|${parts[3]}`
}

export function stableVolume(key: string): string | null {
  return stablePhysicalKey(key) !== key ? key.split('|')[0]! : null
}
