# Working on PeckList for Obsidian

An Obsidian community plugin (TypeScript bundled by esbuild into `main.js`) that syncs tagged Tasks-format lines with a PeckList server through its Task API v1.

## Rules

- Talk to PeckList only through `/api/v1/` (and `/api/v1/cli/` for sign-in). Never `/api/sync`: it is the apps' internal protocol and changes at every schema bump, while Obsidian plugins update when the user chooses. If the plugin needs something v1 lacks, ask for it in the PeckList project.
- Keep `src/core/` and `src/sync/` free of `obsidian` imports so they run under vitest. Obsidian lives in `src/obsidian/`, `src/ui/` and `src/main.ts`.
- No Node or Electron APIs (`isDesktopOnly` is false). Use `requestUrl` for HTTP, Web Crypto for randomness, and no regex lookbehind (older iOS).
- Never write into a left-out folder. A sync must never overwrite a line that changed since it was scanned (`replaceLine` returns null).
- Follow Obsidian's plugin guidelines: sentence case in UI text, no default hotkeys, `registerEvent` and `registerInterval`, the Editor API for the open note and `Vault.process` for others, and no `innerHTML`.
- Behaviour changes come with tests in `tests/`, using the fake server and vault in `tests/fakes.ts`. Run the contract suite against a throwaway local PeckList container when the API use changes.
- Conventional Commits, signed commits, explicit `git add` paths.

## Commands

```bash
npm run build && npm run lint && npm test
PECKLIST_URL=http://localhost:18181 PECKLIST_TOKEN=pl_... npm run test:contract
```

## Releases

Bump with `npm version <x.y.z>` (updates `manifest.json` and `versions.json`). The tag has no `v` prefix. Pushing the tag to GitLab mirrors it to GitHub, where `.github/workflows/release.yml` builds and attaches `main.js`, `manifest.json` and `styles.css` to a draft release.
