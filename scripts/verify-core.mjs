import { verifyReleaseBoundary } from './release-boundary.mjs'
import { verifyArchitecture } from './verify-architecture.mjs'
import { existsSync } from 'node:fs'
const failures = [...verifyReleaseBoundary(), ...verifyArchitecture().failures]
if (existsSync(new URL('../apps', import.meta.url))) failures.push('FluxOs must not contain apps')
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log('FluxOs release boundary and architecture passed.')
