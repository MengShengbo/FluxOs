import { readWorkspaces, repositoryRoot } from './workspace-packages.mjs'

// An explicit allowlist: new packages are private until deliberately reviewed.
export const corePackageIds = Object.freeze([
  'contracts', 'platform', 'models', 'tools', 'extensions', 'agent-runtime',
  'conversations', 'profiles', 'automations', 'presentation',
])
export const productPackageIds = Object.freeze(['agent-core', 'workbench', 'renderer', 'remote-protocol'])
export const productIntegrationTests = new Set([
  'packages/agent-runtime/src/coreOwnership.test.ts',
  'packages/conversations/src/conversations/conversationRuntimeRepositoryV2.test.ts',
])

export function verifyReleaseBoundary(root = repositoryRoot, scope = '@fluxagentcore/') {
  const failures = []
  const workspaces = readWorkspaces(root)
  const publicNames = new Set(corePackageIds.map(id => scope + id))
  for (const id of corePackageIds) {
    const entry = workspaces.find(item => item.manifest.name === scope + id)
    if (!entry) { failures.push(`Missing FluxAgentCore package: ${id}`); continue }
    const manifest = entry.manifest
    if (manifest.private === true || manifest.license !== 'MIT') failures.push(`${manifest.name}: core must remain publishable with its MIT license`)
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
      if (name.startsWith('@fluxagent/') || name.startsWith(scope) && !publicNames.has(name)) failures.push(`${manifest.name}: public core depends on private product ${name}`)
      if (['electron', 'electron-builder', 'react', 'react-dom', '@xterm/xterm', 'node-pty'].includes(name)) failures.push(`${manifest.name}: desktop dependency ${name} is not part of the core`)
    }
  }
  for (const { manifest, kind } of workspaces) {
    if (!publicNames.has(manifest.name)) failures.push(`${manifest.name}: ${kind} outside FluxAgentCore must be private`)
  }
  return failures
}
