import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'

export interface McpOAuthTokenStore {
  loadTokens(serverName: string): Promise<OAuthTokens | undefined>
  saveTokens(serverName: string, tokens: OAuthTokens): Promise<void>
  clearTokens(serverName: string): Promise<void>
  loadClientInformation(serverName: string): Promise<OAuthClientInformationMixed | undefined>
  saveClientInformation(serverName: string, information: OAuthClientInformationMixed | undefined): Promise<void>
  loadCodeVerifier(serverName: string): Promise<string | undefined>
  saveCodeVerifier(serverName: string, verifier: string | undefined): Promise<void>
  loadDiscoveryState(serverName: string): Promise<OAuthDiscoveryState | undefined>
  saveDiscoveryState(serverName: string, state: OAuthDiscoveryState | undefined): Promise<void>
}

/** Test and embedder store. Production hosts should provide a platform keychain-backed implementation. */
export class MemoryMcpOAuthTokenStore implements McpOAuthTokenStore {
  private readonly tokens = new Map<string, OAuthTokens>()
  private readonly clients = new Map<string, OAuthClientInformationMixed>()
  private readonly verifiers = new Map<string, string>()
  private readonly discovery = new Map<string, OAuthDiscoveryState>()

  async loadTokens(serverName: string): Promise<OAuthTokens | undefined> { return clone(this.tokens.get(serverName)) }
  async saveTokens(serverName: string, tokens: OAuthTokens): Promise<void> { this.tokens.set(serverName, clone(tokens)!) }
  async clearTokens(serverName: string): Promise<void> { this.tokens.delete(serverName) }
  async loadClientInformation(serverName: string): Promise<OAuthClientInformationMixed | undefined> { return clone(this.clients.get(serverName)) }
  async saveClientInformation(serverName: string, information: OAuthClientInformationMixed | undefined): Promise<void> {
    if (information) this.clients.set(serverName, clone(information)!)
    else this.clients.delete(serverName)
  }
  async loadCodeVerifier(serverName: string): Promise<string | undefined> { return this.verifiers.get(serverName) }
  async saveCodeVerifier(serverName: string, verifier: string | undefined): Promise<void> {
    if (verifier) this.verifiers.set(serverName, verifier)
    else this.verifiers.delete(serverName)
  }
  async loadDiscoveryState(serverName: string): Promise<OAuthDiscoveryState | undefined> { return clone(this.discovery.get(serverName)) }
  async saveDiscoveryState(serverName: string, state: OAuthDiscoveryState | undefined): Promise<void> {
    if (state) this.discovery.set(serverName, clone(state)!)
    else this.discovery.delete(serverName)
  }
}

export interface McpOAuthProviderOptions {
  serverName: string
  redirectUrl: string | URL
  clientMetadata: OAuthClientMetadata
  store: McpOAuthTokenStore
  fetchFn?: typeof fetch
  onAuthorizationUrl?: (url: URL) => void | Promise<void>
}

export interface McpOAuthAuthorizationStart {
  status: 'AUTHORIZED' | 'REDIRECT'
  authorizationUrl?: URL
}

/**
 * OAuth provider boundary for MCP transports. Secrets and transient PKCE state
 * never enter MCP settings, tool arguments, logs, or the renderer.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private pendingState?: string
  private pendingAuthorizationUrl?: URL
  private readonly options: McpOAuthProviderOptions

  constructor(options: McpOAuthProviderOptions) {
    this.options = { ...options, redirectUrl: String(options.redirectUrl) }
    const redirect = new URL(this.options.redirectUrl)
    if (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') throw new Error('OAuth redirect URL must use http or https')
    if (!options.serverName.trim()) throw new Error('OAuth server name is required')
  }

  get redirectUrl(): string { return String(this.options.redirectUrl) }
  get clientMetadata(): OAuthClientMetadata { return structuredClone(this.options.clientMetadata) }
  get authorizationUrl(): URL | undefined { return this.pendingAuthorizationUrl ? new URL(this.pendingAuthorizationUrl) : undefined }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.options.store.loadClientInformation(this.options.serverName)
  }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    await this.options.store.saveClientInformation(this.options.serverName, information)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.options.store.loadTokens(this.options.serverName)
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.store.saveTokens(this.options.serverName, tokens)
  }

  async state(): Promise<string> {
    const state = randomBase64Url(32)
    this.pendingState = state
    return state
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.options.store.saveCodeVerifier(this.options.serverName, verifier)
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.options.store.loadCodeVerifier(this.options.serverName)
    if (!verifier) throw new Error('OAuth PKCE verifier is missing or expired')
    return verifier
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.pendingAuthorizationUrl = new URL(url)
    await this.options.onAuthorizationUrl?.(new URL(url))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.options.store.loadDiscoveryState(this.options.serverName)
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.options.store.saveDiscoveryState(this.options.serverName, state)
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') await this.options.store.clearTokens(this.options.serverName)
    if (scope === 'all' || scope === 'client') await this.options.store.saveClientInformation(this.options.serverName, undefined)
    if (scope === 'all' || scope === 'verifier') await this.options.store.saveCodeVerifier(this.options.serverName, undefined)
    if (scope === 'all' || scope === 'discovery') await this.options.store.saveDiscoveryState(this.options.serverName, undefined)
  }

  async startAuthorization(serverUrl: string | URL, scope?: string): Promise<McpOAuthAuthorizationStart> {
    const status = await auth(this, { serverUrl, scope, fetchFn: this.options.fetchFn })
    return { status, authorizationUrl: this.authorizationUrl }
  }

  async completeAuthorization(serverUrl: string | URL, callbackUrl: string | URL): Promise<'AUTHORIZED'> {
    const callback = new URL(callbackUrl)
    const expected = new URL(this.redirectUrl)
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.searchParams.get('error')) {
      await this.cancelAuthorization()
      throw new Error(callback.searchParams.get('error_description') || callback.searchParams.get('error') || 'OAuth callback URL is not allowed')
    }
    if (!this.pendingState || !constantTimeEqual(this.pendingState, callback.searchParams.get('state') || '')) {
      await this.cancelAuthorization()
      throw new Error('OAuth callback state mismatch')
    }
    const code = callback.searchParams.get('code')
    if (!code) {
      await this.cancelAuthorization()
      throw new Error('OAuth callback did not contain an authorization code')
    }
    this.pendingState = undefined
    this.pendingAuthorizationUrl = undefined
    const status = await auth(this, { serverUrl, authorizationCode: code, fetchFn: this.options.fetchFn })
    await this.options.store.saveCodeVerifier(this.options.serverName, undefined)
    if (status !== 'AUTHORIZED') throw new Error(`Unexpected OAuth completion status: ${status}`)
    return status
  }

  async refresh(serverUrl: string | URL): Promise<OAuthTokens> {
    const tokens = await this.tokens()
    if (!tokens?.refresh_token) throw new Error('OAuth refresh token is missing')
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: this.options.fetchFn })
    const clientInformation = await this.clientInformation()
    if (!clientInformation) throw new Error('OAuth client registration is missing')
    const next = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation,
      refreshToken: tokens.refresh_token,
      resource: info.resourceMetadata?.resource ? new URL(info.resourceMetadata.resource) : undefined,
      fetchFn: this.options.fetchFn,
    })
    await this.saveTokens(next)
    return next
  }

  async revoke(serverUrl: string | URL): Promise<boolean> {
    const tokens = await this.tokens()
    if (!tokens) return false
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: this.options.fetchFn })
    const endpoint = (info.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint
    if (!endpoint) throw new Error('OAuth issuer does not advertise a revocation endpoint')
    const client = await this.clientInformation()
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
    const params = new URLSearchParams({ token: tokens.access_token })
    if (tokens.token_type) params.set('token_type_hint', tokens.token_type)
    if (client?.client_id) params.set('client_id', client.client_id)
    if (client?.client_secret) {
      const basic = Buffer.from(`${client.client_id}:${client.client_secret}`, 'utf8').toString('base64')
      headers.set('authorization', `Basic ${basic}`)
    }
    const response = await (this.options.fetchFn ?? fetch)(endpoint, { method: 'POST', headers, body: params })
    if (!response.ok) throw new Error(`OAuth token revocation failed: HTTP ${response.status}`)
    await this.options.store.clearTokens(this.options.serverName)
    return true
  }

  async cancelAuthorization(): Promise<void> {
    this.pendingState = undefined
    this.pendingAuthorizationUrl = undefined
    await this.options.store.saveCodeVerifier(this.options.serverName, undefined)
  }
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}
