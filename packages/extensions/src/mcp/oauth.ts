import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  auth,
  selectResourceURL,
  selectClientAuthMethod,
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
  serverUrl: string | URL
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
  private readonly storageKey: string

  constructor(options: McpOAuthProviderOptions) {
    const serverUrl = new URL(options.serverUrl)
    assertSecureUrl(serverUrl)
    this.storageKey = `${options.serverName}:${createHash('sha256').update(serverUrl.href).digest('hex')}`
    this.options = { ...options, serverUrl: serverUrl.href, redirectUrl: String(options.redirectUrl) }
    const redirect = new URL(this.options.redirectUrl)
    assertSecureUrl(redirect)
    if (redirect.search || redirect.hash) throw new Error('OAuth redirect URL must not include query or fragment')
    if (!options.clientMetadata.redirect_uris?.includes(redirect.href)) throw new Error('OAuth client metadata must include the callback URL')
    if (!options.serverName.trim()) throw new Error('OAuth server name is required')
  }

  get redirectUrl(): string { return String(this.options.redirectUrl) }
  get clientMetadata(): OAuthClientMetadata { return structuredClone(this.options.clientMetadata) }
  get authorizationUrl(): URL | undefined { return this.pendingAuthorizationUrl ? new URL(this.pendingAuthorizationUrl) : undefined }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.options.store.loadClientInformation(this.storageKey)
  }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    await this.options.store.saveClientInformation(this.storageKey, information)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.options.store.loadTokens(this.storageKey)
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.store.saveTokens(this.storageKey, tokens)
  }

  async state(): Promise<string> {
    const state = randomBase64Url(32)
    this.pendingState = state
    return state
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.options.store.saveCodeVerifier(this.storageKey, verifier)
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.options.store.loadCodeVerifier(this.storageKey)
    if (!verifier) throw new Error('OAuth PKCE verifier is missing or expired')
    return verifier
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.pendingAuthorizationUrl = new URL(url)
    await this.options.onAuthorizationUrl?.(new URL(url))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await this.options.store.loadDiscoveryState(this.storageKey)
    if (state) validateDiscovery(state)
    return state
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    validateDiscovery(state)
    await this.options.store.saveDiscoveryState(this.storageKey, state)
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') await this.options.store.clearTokens(this.storageKey)
    if (scope === 'all' || scope === 'client') await this.options.store.saveClientInformation(this.storageKey, undefined)
    if (scope === 'all' || scope === 'verifier') await this.options.store.saveCodeVerifier(this.storageKey, undefined)
    if (scope === 'all' || scope === 'discovery') await this.options.store.saveDiscoveryState(this.storageKey, undefined)
  }

  async startAuthorization(serverUrl: string | URL, scope?: string): Promise<McpOAuthAuthorizationStart> {
    this.assertServerUrl(serverUrl)
    const status = await auth(this, { serverUrl, scope, fetchFn: this.secureFetch })
    return { status, authorizationUrl: this.authorizationUrl }
  }

  async completeAuthorization(serverUrl: string | URL, callbackUrl: string | URL): Promise<'AUTHORIZED'> {
    try { this.assertServerUrl(serverUrl) } catch (error) {
      await this.cancelAuthorization()
      throw error
    }
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
    try {
      const status = await auth(this, { serverUrl, authorizationCode: code, fetchFn: this.secureFetch })
      if (status !== 'AUTHORIZED') throw new Error(`Unexpected OAuth completion status: ${status}`)
      return status
    } finally {
      await this.options.store.saveCodeVerifier(this.storageKey, undefined)
    }
  }

  async refresh(serverUrl: string | URL): Promise<OAuthTokens> {
    this.assertServerUrl(serverUrl)
    const tokens = await this.tokens()
    if (!tokens?.refresh_token) throw new Error('OAuth refresh token is missing')
    const info = await this.discoveryState()
    if (!info) throw new Error('OAuth authorization server binding is missing')
    const clientInformation = await this.clientInformation()
    if (!clientInformation) throw new Error('OAuth client registration is missing')
    const next = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation,
      refreshToken: tokens.refresh_token,
      resource: await selectResourceURL(serverUrl, this, info.resourceMetadata),
      fetchFn: this.secureFetch,
    })
    await this.saveTokens(next)
    return next
  }

  async revoke(serverUrl: string | URL): Promise<boolean> {
    this.assertServerUrl(serverUrl)
    const tokens = await this.tokens()
    if (!tokens) return false
    const info = await this.discoveryState()
    if (!info) throw new Error('OAuth authorization server binding is missing')
    const metadata = info.authorizationServerMetadata as { revocation_endpoint?: string; revocation_endpoint_auth_methods_supported?: string[] } | undefined
    const endpoint = metadata?.revocation_endpoint
    if (!endpoint) throw new Error('OAuth issuer does not advertise a revocation endpoint')
    const client = await this.clientInformation()
    if (!client) throw new Error('OAuth client registration is missing')
    const method = selectClientAuthMethod(client, metadata?.revocation_endpoint_auth_methods_supported ?? [])
    const grants = [
      ...(tokens.refresh_token ? [{ token: tokens.refresh_token, hint: 'refresh_token' }] : []),
      { token: tokens.access_token, hint: 'access_token' },
    ]
    for (const grant of grants) {
      const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
      const params = new URLSearchParams({ token: grant.token, token_type_hint: grant.hint })
      if (method === 'client_secret_basic') {
        const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2)
        headers.set('authorization', `Basic ${Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret || '')}`).toString('base64')}`)
      } else {
        params.set('client_id', client.client_id)
        if (method === 'client_secret_post') params.set('client_secret', client.client_secret || '')
      }
      const response = await this.secureFetch(endpoint, { method: 'POST', headers, body: params })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`OAuth token revocation failed: HTTP ${response.status}`)
    }
    await this.options.store.clearTokens(this.storageKey)
    return true
  }

  private assertServerUrl(serverUrl: string | URL): void {
    if (new URL(serverUrl).href !== String(this.options.serverUrl)) throw new Error('OAuth server URL mismatch')
  }

  // Never follow a 307/308 carrying authorization codes or tokens to another endpoint.
  private readonly secureFetch: typeof fetch = async (input, init) => {
    assertSecureUrl(new URL(input instanceof Request ? input.url : String(input)))
    return (this.options.fetchFn ?? fetch)(input, { ...init, redirect: 'error' })
  }

  async cancelAuthorization(): Promise<void> {
    this.pendingState = undefined
    this.pendingAuthorizationUrl = undefined
    await this.options.store.saveCodeVerifier(this.storageKey, undefined)
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

function assertSecureUrl(url: URL): void {
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('OAuth URLs require HTTPS or a loopback HTTP fixture, without credentials or fragments')
  }
}

function validateDiscovery(state: OAuthDiscoveryState): void {
  const issuer = new URL(state.authorizationServerUrl)
  assertSecureUrl(issuer)
  const metadata = state.authorizationServerMetadata
  if (!metadata) throw new Error('OAuth authorization server metadata is required')
  if (new URL(metadata.issuer).href !== issuer.href) throw new Error('OAuth issuer mismatch')
  for (const name of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
    const endpoint = (metadata as unknown as Record<string, unknown>)[name]
    if (typeof endpoint === 'string') assertSecureUrl(new URL(endpoint))
  }
}
