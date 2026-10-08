import type { ApprovalPolicy, CapabilityProfile, NativeReasoningConfig } from './agentTypes'

export interface FluxAgentConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'glm' | 'openrouter' | 'custom'
  apiKey: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  modelCapabilities?: ModelCapabilities
  modelMetadataSources?: ModelMetadataSource[]
  approvalPolicy: ApprovalPolicy
  capabilityProfile?: CapabilityProfile
  gitEnabled: boolean
  reasoning?: NativeReasoningConfig
  apiConfigs?: FluxAgentApiConfigProfile[]
  activeApiConfigId?: string
}

export interface ModelPreset {
  id: string
  name: string
  model: string
  provider: FluxAgentProvider
  baseUrl: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  reasoning?: NativeReasoningConfig
  description: string
  capabilities?: ModelCapabilities
  metadataSources?: ModelMetadataSource[]
  availability?: 'api' | 'configured' | 'builtin'
}

export type ModelMetadataSource = 'api' | 'gateway' | 'models.dev' | 'builtin' | 'default'

export interface ModelCapabilities {
  tools?: boolean
  /** Explicit endpoint capability; never inferred from a provider/model name. */
  responsesCustomTools?: boolean
  vision?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
  supportedParameters?: string[]
  supportedEndpoints?: string[]
  reasoningEfforts?: Array<NonNullable<NativeReasoningConfig['effort']>>
  reasoningDefaultEffort?: NonNullable<NativeReasoningConfig['effort']>
  reasoningDefaultEnabled?: boolean
  reasoningMandatory?: boolean
  reasoningSupportsMaxTokens?: boolean
}

export type FluxAgentProvider = FluxAgentConfig['provider']
export type FluxAgentConfigKey = keyof FluxAgentConfig

export interface FluxAgentApiConfigProfile {
  id: string
  name: string
  provider: FluxAgentProvider
  apiKey: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  modelCapabilities?: ModelCapabilities
  modelMetadataSources?: ModelMetadataSource[]
  reasoning?: NativeReasoningConfig
  createdAt: number
  updatedAt: number
}

export interface ProviderPreset {
  id: string
  name: string
  provider: FluxAgentProvider
  baseUrl: string
  defaultModel: string
  description: string
}
