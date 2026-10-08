import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const originalDir = process.env.FLUXAGENT_CONFIG_DIR
const originalKey = process.env.FLUXAGENT_API_KEY
const directories: string[] = []
afterEach(() => {
  if (originalDir === undefined) delete process.env.FLUXAGENT_CONFIG_DIR
  else process.env.FLUXAGENT_CONFIG_DIR = originalDir
  if (originalKey === undefined) delete process.env.FLUXAGENT_API_KEY
  else process.env.FLUXAGENT_API_KEY = originalKey
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  vi.resetModules()
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'fluxagent-plain-config-'))
  directories.push(directory)
  process.env.FLUXAGENT_CONFIG_DIR = directory
  delete process.env.FLUXAGENT_API_KEY
  vi.resetModules()
  return directory
}
const config = { provider: 'openai' as const, apiKey: 'test-persisted-key', baseUrl: 'https://example.invalid/v1', model: 'test-model', contextWindow: 128000, maxTokens: 4096 }
it('keeps API key, endpoint and model in one editable config and reloads manual edits', async () => {
  const root = setup()
  const { saveConfig, loadConfig } = await import('./config')
  saveConfig(config)
  const path = join(root, 'config.json')
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  expect(stored.apiKey).toBe(config.apiKey)
  expect(stored).not.toHaveProperty('apiConfigs')
  expect(stored).not.toHaveProperty('modelCapabilities')
  expect(stored).not.toHaveProperty('approvalPolicy')
  expect(stored.baseUrl).toBe(config.baseUrl)
  expect(existsSync(join(root, 'credentials.json'))).toBe(false)
  stored.apiKey = 'test-edited-key'
  writeFileSync(path, JSON.stringify(stored))
  expect((await loadConfig()).apiKey).toBe('test-edited-key')
})
it('uses environment overrides without writing them over file configuration', async () => {
  const root = setup()
  const { saveConfig, loadConfig } = await import('./config')
  saveConfig(config)
  process.env.FLUXAGENT_API_KEY = 'test-environment-key'
  const loaded = await loadConfig()
  expect(loaded.apiKey).toBe('test-environment-key')
  saveConfig({ ...loaded, approvalPolicy: 'agent' })
  const saved = readFileSync(join(root, 'config.json'), 'utf8')
  expect(saved).toContain(config.apiKey)
  expect(saved).not.toContain('test-environment-key')
})
it('keeps keys belonging to each connection when switching configurations', async () => {
  const root = setup()
  const { saveConfig, loadConfig } = await import('./config')
  const first = saveConfig(config)
  const profile = first.apiConfigs![0]!
  saveConfig({ ...first, activeApiConfigId: 'second', apiConfigs: [profile, { ...profile, id: 'second', name: 'Second', apiKey: 'test-second-key' }] })
  expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).apiKey).toBe('test-second-key')
  expect(JSON.parse(readFileSync(join(root, 'connections', `${profile.id}.json`), 'utf8')).apiKey).toBe(config.apiKey)
  expect(existsSync(join(root, 'connections', 'second.json'))).toBe(false)
  const loaded = await loadConfig()
  expect(loaded.apiConfigs?.find(item => item.id === profile.id)?.apiKey).toBe(config.apiKey)
  expect(loaded.apiConfigs?.find(item => item.id === 'second')?.apiKey).toBe('test-second-key')
})
it('switches back without duplicating the active key and removes deleted connection files', async () => {
  const root = setup()
  const { saveConfig, loadConfig, saveApiConfigProfile, switchActiveApiConfig, deleteApiConfigProfile } = await import('./config')
  let value = saveConfig(config)
  const firstId = value.activeApiConfigId!
  const first = value.apiConfigs![0]!
  value = saveConfig(saveApiConfigProfile(value, { ...first, id: 'second', name: 'Second', apiKey: 'test-second-key' }, true))
  value = saveConfig(switchActiveApiConfig(value, firstId))
  expect((await loadConfig()).apiKey).toBe(config.apiKey)
  expect(existsSync(join(root, 'connections', `${firstId}.json`))).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'connections', 'second.json'), 'utf8')).apiKey).toBe('test-second-key')
  saveConfig(deleteApiConfigProfile(value, 'second'))
  expect(existsSync(join(root, 'connections', 'second.json'))).toBe(false)
})
it('recovers an interrupted multi-file connection switch before loading configuration', async () => {
  const root = setup()
  const { loadConfig } = await import('./config')
  writeFileSync(join(root, '.connection-transaction.json'), JSON.stringify({
    current: config,
    state: { activeConnection: { id: 'main', name: 'Main' }, connectionOrder: ['main', 'other'] },
    connections: [{ ...config, id: 'other', name: 'Other', apiKey: 'other-key' }],
  }))
  const loaded = await loadConfig()
  expect(loaded.apiKey).toBe(config.apiKey)
  expect(loaded.apiConfigs).toHaveLength(2)
  expect(existsSync(join(root, '.connection-transaction.json'))).toBe(false)
})
