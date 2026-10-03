import { defineConfig } from 'vitest/config'
import { workspaceSourceAliases } from './scripts/workspace-packages.mjs'
export default defineConfig({ resolve: { alias: workspaceSourceAliases() }, test: { maxWorkers: 2, testTimeout: process.platform === 'win32' ? 15000 : 5000, setupFiles: ['./vitest.setup.ts'], include: ['packages/*/src/**/*.{test,spec}.{ts,tsx}'] } })
