import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryMcpOAuthTokenStore, McpOAuthProvider } from './oauth'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return new URLSearchParams(body)
}

async function fixture() {
  let expectedChallenge = ''
  let tokenRequests = 0
  let revoked = false
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    if (url.pathname.includes('oauth-authorization-server')) {
      return json(res, 200, {
        issuer: `http://${req.headers.host}`,
        authorization_endpoint: `http://${req.headers.host}/authorize`,
        token_endpoint: `http://${req.headers.host}/token`,
        registration_endpoint: `http://${req.headers.host}/register`,
        revocation_endpoint: `http://${req.headers.host}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      return json(res, 201, {
        client_id: 'fixture-client',
        client_id_issued_at: 1,
        redirect_uris: ['http://127.0.0.1:43127/oauth/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      tokenRequests += 1
      const body = await readBody(req)
      if (body.get('grant_type') === 'authorization_code') {
        const verifier = body.get('code_verifier') || ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (body.get('code') !== 'fixture-code' || challenge !== expectedChallenge) return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 60 })
      }
      if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'refresh-1') {
        return json(res, 200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 60 })
      }
      return json(res, 400, { error: 'invalid_grant' })
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const body = await readBody(req)
      revoked = body.get('token') === 'access-2'
      return json(res, 200, {})
    }
    if (url.pathname === '/authorize') {
      expectedChallenge = url.searchParams.get('code_challenge') || ''
      return json(res, 200, { ok: true })
    }
    res.writeHead(404).end()
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  return {
    serverUrl: `http://127.0.0.1:${address.port}/mcp`,
    get tokenRequests() { return tokenRequests },
    get revoked() { return revoked },
    set expectedChallenge(value: string) { expectedChallenge = value },
  }
}

function provider(fixtureData: Awaited<ReturnType<typeof fixture>>, onUrl?: (url: URL) => void) {
  return new McpOAuthProvider({
    serverName: 'fixture',
    redirectUrl: 'http://127.0.0.1:43127/oauth/callback',
    clientMetadata: {
      redirect_uris: ['http://127.0.0.1:43127/oauth/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'FluxAgent fixture',
    },
    store: new MemoryMcpOAuthTokenStore(),
    onAuthorizationUrl: onUrl,
  })
}

describe('McpOAuthProvider', () => {
  it('performs registration, PKCE authorization, callback state validation and token exchange', async () => {
    const fixtureData = await fixture()
    let redirected: URL | undefined
    const oauth = provider(fixtureData, url => { redirected = url })
    const start = await oauth.startAuthorization(fixtureData.serverUrl)
    expect(start.status).toBe('REDIRECT')
    expect(redirected?.searchParams.get('client_id')).toBe('fixture-client')
    expect(redirected?.searchParams.get('state')).toBeTruthy()
    expect(redirected?.searchParams.get('code_challenge_method')).toBe('S256')
    fixtureData.expectedChallenge = redirected?.searchParams.get('code_challenge') || ''

    await expect(oauth.completeAuthorization(fixtureData.serverUrl, `${oauth.redirectUrl}?code=fixture-code&state=wrong`)).rejects.toThrow('state mismatch')
    expect(fixtureData.tokenRequests).toBe(0)

    await oauth.startAuthorization(fixtureData.serverUrl)
    fixtureData.expectedChallenge = redirected?.searchParams.get('code_challenge') || ''
    const state = redirected?.searchParams.get('state')
    await expect(oauth.completeAuthorization(fixtureData.serverUrl, `${oauth.redirectUrl}?code=fixture-code&state=${encodeURIComponent(state || '')}`)).resolves.toBe('AUTHORIZED')
    await expect(oauth.tokens()).resolves.toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' })
  })

  it('refreshes and revokes without exposing tokens to settings or logs', async () => {
    const fixtureData = await fixture()
    let redirected: URL | undefined
    const oauth = provider(fixtureData, url => { redirected = url })
    await oauth.startAuthorization(fixtureData.serverUrl)
    fixtureData.expectedChallenge = redirected?.searchParams.get('code_challenge') || ''
    await oauth.completeAuthorization(fixtureData.serverUrl, `${oauth.redirectUrl}?code=fixture-code&state=${redirected?.searchParams.get('state')}`)
    await expect(oauth.refresh(fixtureData.serverUrl)).resolves.toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-2' })
    await expect(oauth.revoke(fixtureData.serverUrl)).resolves.toBe(true)
    expect(fixtureData.revoked).toBe(true)
    await expect(oauth.tokens()).resolves.toBeUndefined()
  })

  it('cancels pending authorization and rejects unsafe callback origins', async () => {
    const fixtureData = await fixture()
    const oauth = provider(fixtureData)
    await oauth.startAuthorization(fixtureData.serverUrl)
    await oauth.cancelAuthorization()
    expect(oauth.authorizationUrl).toBeUndefined()
    await expect(oauth.completeAuthorization(fixtureData.serverUrl, 'https://evil.example/oauth/callback?code=x&state=y')).rejects.toThrow()
  })
})
