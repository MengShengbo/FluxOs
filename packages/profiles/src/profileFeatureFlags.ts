export interface ProfileFeatureFlags {
  conversationDataV2: boolean
  profileCenterV2: boolean
  profileArchiveV2: boolean
}

export const STABLE_PROFILE_FEATURE_FLAGS: ProfileFeatureFlags = {
  conversationDataV2: true,
  profileCenterV2: true,
  profileArchiveV2: true,
}

const ENVIRONMENT_KEYS: Record<keyof ProfileFeatureFlags, string> = {
  conversationDataV2: 'FLUXAGENT_CONVERSATION_DATA_V2',
  profileCenterV2: 'FLUXAGENT_PROFILE_CENTER_V2',
  profileArchiveV2: 'FLUXAGENT_PROFILE_ARCHIVE_V2',
}

function parseFlag(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`${name} must be true or false`)
}

export function resolveProfileFeatureFlags(
  environment: Record<string, string | undefined>,
  defaults: ProfileFeatureFlags = STABLE_PROFILE_FEATURE_FLAGS,
): ProfileFeatureFlags {
  return Object.fromEntries(
    (Object.keys(ENVIRONMENT_KEYS) as Array<keyof ProfileFeatureFlags>).map(key => {
      const primaryName = ENVIRONMENT_KEYS[key]
      if (environment[primaryName]?.trim()) {
        return [key, parseFlag(environment[primaryName], defaults[key], primaryName)]
      }
      return [key, defaults[key]]
    }),
  ) as unknown as ProfileFeatureFlags
}
