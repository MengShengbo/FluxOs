# FluxOs

FluxOs is the open-source Agent infrastructure powering FluxAgent. It is an independent npm workspace, with no Desktop application, workbench assembly, DOM renderer, remote-control product or private product Git history.

## Quick start

Node.js 22.12+, npm and ripgrep are required.

```sh
git clone https://github.com/MengShengbo/FluxOs.git
cd FluxOs
npm ci
npm run verify
npm run build
npm run type-check
npm test
npm run pack:core
```

Consumers import declared `@fluxos/*` entrypoints, such as `@fluxos/agent-runtime`. Inject browser, computer and terminal adapters through the core interfaces.

## Product boundary

| Open-source FluxOs | Private FluxAgent product |
| --- | --- |
| contracts, platform, models, tools, extensions, agent-runtime | Electron application and native browser/computer/terminal adapters |
| conversations, profiles, automations, presentation | workbench assembly, DOM renderer, remote protocol, desktop UI and product services |

All ten core packages are MIT licensed, publishable, independently built and tested. The workspace root is private to npm so consumers use the domain package APIs. FluxAgent is maintained in a separate private repository and depends on these packages; this repository does not depend on FluxAgent.

## Compatibility

Runtime configuration uses `FLUXAGENT_*` and `.fluxagent` only. Before launch, code and development data move directly to the current format, without old aliases, fallback readers or runtime migration layers. The assistant identifies itself as FluxAgent; FluxOs is its execution kernel.

Profile archives exported by the product use `.fluxagent-profile`; the core container reader accepts both `.fluxagent-profile` and historical `.fluxagent-profile` files. The encrypted container format is unchanged.

Runtime response mode begins as chat and promotes to task when actual tools are dispatched. No extra model classification round is required.

## License and contribution

[MIT](LICENSE). Existing notices and author attribution are preserved. See [contribution policy](CONTRIBUTING.md). Product integration tests remain in the private FluxAgent repository. [Migration origin](docs/migration-origin.json) records the source baseline used to create this independent repository.
