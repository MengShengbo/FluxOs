import { describe, expect, it } from 'vitest'
import { resolveProfileFeatureFlags, STABLE_PROFILE_FEATURE_FLAGS } from './profileFeatureFlags'

describe('profile release feature flags', () => {
  it('enables every Stable profile capability by default', () => {
    expect(resolveProfileFeatureFlags({})).toEqual(STABLE_PROFILE_FEATURE_FLAGS)
  })

  it('accepts the three V2 release-channel overrides', () => {
    expect(resolveProfileFeatureFlags({
      FLUXAGENT_CONVERSATION_DATA_V2: 'true',
      FLUXAGENT_PROFILE_CENTER_V2: 'no',
      FLUXAGENT_PROFILE_ARCHIVE_V2: 'off',
    })).toEqual({
      conversationDataV2: true,
      profileCenterV2: false,
      profileArchiveV2: false,
    })
  })

  it('ignores removed V1 gates', () => {
    expect(resolveProfileFeatureFlags({
      FLUXAGENT_PROFILE_STORAGE_V1: '0',
      FLUXAGENT_LOCAL_PROFILES_UI_V1: 'off',
      FLUXAGENT_PROFILE_ARCHIVE_EXPORT_V1: 'true',
      FLUXAGENT_PROFILE_ARCHIVE_IMPORT_V1: 'false',
    })).toEqual({ conversationDataV2: true, profileCenterV2: true, profileArchiveV2: true })
    expect(resolveProfileFeatureFlags({
      FLUXAGENT_CONVERSATION_DATA_V2: 'true',
      FLUXAGENT_PROFILE_STORAGE_V1: 'false',
    }).conversationDataV2).toBe(true)
  })

  it('fails closed for an invalid flag value', () => {
    expect(() => resolveProfileFeatureFlags({ FLUXAGENT_PROFILE_ARCHIVE_V2: 'maybe' })).toThrow('must be true or false')
  })
})
