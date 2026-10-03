import { describe, expect, it } from 'vitest'
import { createFluxAgentRequestHeaders, getFluxAgentClientIdentity } from './clientIdentity'

describe('FluxAgentCore client identity', () => {
  it('identifies CLI requests with product, version and request id', () => {
    const headers = createFluxAgentRequestHeaders({}, 'request-123')

    expect(headers['User-Agent']).toMatch(/^fluxagent-cli\/\d+\.\d+\.\d+ \(.+; .+\)$/)
    expect(headers['x-app']).toBe('fluxagent-cli')
    expect(headers['x-client-app']).toBe('fluxagent-cli')
    expect(headers.originator).toBe('fluxagent_cli')
    expect(headers['x-client-request-id']).toBe('request-123')
  })

  it('supports a future desktop surface without another header implementation', () => {
    const identity = getFluxAgentClientIdentity({ TURBOFLUX_CLIENT_SURFACE: 'desktop' })

    expect(identity.product).toBe('fluxagent-desktop')
    expect(identity.originator).toBe('fluxagent_desktop')
    expect(identity.userAgent).toContain('fluxagent-desktop/')
  })

  it('lets explicit provider headers override defaults', () => {
    const headers = createFluxAgentRequestHeaders({ 'x-app': 'gateway-required-value' }, 'request-456')

    expect(headers['x-app']).toBe('gateway-required-value')
  })
})
