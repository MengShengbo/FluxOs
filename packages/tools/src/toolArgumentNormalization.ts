export function normalizeBuiltInToolArguments(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = { ...args }
  // Defaults apply only to an omitted optional path (null is strict omission).
  // Preserve supplied bytes and unknown keys for validation; never repair an
  // invalid required path into the workspace root or accept a parameter alias.
  if (toolName === 'search_content' && normalized.path == null) normalized.path = '.'
  return normalized
}
