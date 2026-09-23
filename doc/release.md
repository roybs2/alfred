# Release / packaging

Alfred is packaged as an **unsigned** macOS app with [electron-builder](https://www.electron.build/),
producing a `.dmg` and a `.zip` for both Apple Silicon (`arm64`) and Intel (`x64`). There is no
Apple Developer signing identity and no notarization — see "Gatekeeper" below for what that means
for anyone who downloads a build.

This is packaging only. Nothing here publishes anything: no GitHub Release is created or pushed by
these scripts. Per `AGENTS.md`, publishing (a GitHub Release, going public, picking a final product
name) happens only when the owner explicitly decides to.

## Build it

```sh
npm install          # also rebuilds node-pty for the installed Electron ABI (postinstall)
npm run dist:mac      # tsc --noEmit && vite build, then electron-builder --mac
```

`dist:mac` runs the normal `npm run build` first (typecheck + Vite production build into `dist/`),
then invokes `electron-builder --mac`. The `mac.target` list in `package.json`'s `build` config
requests both `arm64` and `x64` for both `dmg` and `zip`, so a single `npm run dist:mac` on Apple
Silicon builds all four artifacts — electron-builder downloads the matching Electron zip and
`node-pty` prebuild for the non-host architecture as needed. Building x64 artifacts on an Apple
Silicon host worked in testing; it depends on electron-builder/`@electron/rebuild` continuing to
have prebuilt `node-pty` binaries available for `darwin-x64`. If a future node-pty bump ever lacks
an x64 prebuild, only the arm64 artifacts will succeed and x64 packaging will need to be revisited.

Output goes to `release/` (already `.gitignore`d — never commit built artifacts):

```
release/
  Alfred-<version>-arm64.dmg
  Alfred-<version>-arm64-mac.zip
  Alfred-<version>.dmg          # x64
  Alfred-<version>-mac.zip      # x64
  mac-arm64/Alfred.app
  mac/Alfred.app
```

## electron-builder configuration

Config lives inline in `package.json` under `"build"` (no separate `electron-builder.yml`):

- `appId`: `com.roybs2.alfred`, `productName`: `Alfred`.
- `directories.output`: `release/`; `directories.buildResources`: `build/` (icon lives here).
- `files`: `desktop/**`, `dist/**`, `package.json`, and `node_modules/**` (electron-builder prunes
  `node_modules` to production `dependencies` only — `devDependencies` like `@playwright/test`,
  `electron`, `vite`, `typescript` are never bundled; verified by inspecting the packaged
  `app.asar`, which is ~13 MB).
- `asarUnpack`: `node_modules/node-pty/**`, `node_modules/@modelcontextprotocol/**`,
  `node_modules/zod/**`, and `desktop/room-mcp-bridge.mjs`. See "Why these are unpacked" below.
- `mac.identity: null` and no `mac.notarize` — explicitly unsigned, per the owner's decision.
  `hardenedRuntime: false`, `gatekeeperAssess: false`.
- `mac.target`: `dmg` and `zip`, each for `arm64` and `x64`.
- `mac.category`: `public.app-category.developer-tools`.
- `mac.icon`: `build/icon.icns`.

### Why these are unpacked

Two independent processes need files that live inside `app.asar`:

1. **`node-pty`**'s native addon (`pty.node`) and its `spawn-helper` binary. Electron cannot
   `dlopen` a native addon, or `execve` a helper binary, directly out of an asar archive — both
   need real files on disk. `node_modules/node-pty/**` is unpacked so the prebuilt/rebuilt native
   binaries and `spawn-helper` are present as normal files under `app.asar.unpacked/`. Verified in
   the packaged app: creating a real shell PTY session and reading/writing to it works (see
   "Packaged-app testing" below).

2. **The room MCP bridge** (`desktop/room-mcp-bridge.mjs`). `desktop/agent-runner.cjs` spawns this
   script directly with `bridgeExecutable = process.execPath` (the Alfred binary itself) and
   `ELECTRON_RUN_AS_NODE=1`, i.e. as a fresh Node process pointed at a `.mjs` entry file, which
   then does static ESM `import`s of `@modelcontextprotocol/sdk` and `zod`. Electron's asar support
   for the *parent* process's own module loading is broad, but a freshly spawned child process
   reading its own ESM entry point and resolving `node_modules` from inside an asar archive is
   exactly the kind of path this task flagged as a risk. It was tested directly (see below) and
   turned out to work correctly against the packaged asar path — Electron transparently resolves a
   file that matches an `asarUnpack` pattern to its `app.asar.unpacked` copy even when the path
   handed to `spawn()`/`execve` still points inside `app.asar`. `desktop/room-mcp-bridge.mjs`,
   `@modelcontextprotocol/sdk`, and `zod` are all unpacked anyway so this doesn't depend on that
   behavior continuing to hold across Electron versions — the files are real, ordinary files on
   disk either way.

`desktop/main.cjs`, `desktop/agent-engine.cjs`, `desktop/agent-runner.cjs`, and `desktop/preload.cjs`
stay inside `app.asar` — they're only ever loaded by the main Electron process itself (normal
`require()`/`app.loadFile()`), which Electron's built-in asar support handles natively.

## App icon

`build/icon.svg` is an original bow-tie mark (dark background, lavender gradient matching
`src/styles.css`'s `--lav`/`--lav2` tokens) — no trademarked imagery. `build/icon.icns` was
generated from it with `rsvg-convert` (all required iconset sizes, 16–1024px, including `@2x`
variants) and macOS's `iconutil`:

```sh
rsvg-convert -w <size> -h <size> build/icon.svg -o icon.iconset/icon_<size>x<size>.png   # per size
iconutil -c icns icon.iconset -o build/icon.icns
```

Only `build/icon.svg` (source) and `build/icon.icns` (electron-builder input) are committed;
the intermediate `.iconset` directory is not.

## Packaged-app testing

Built and tested on the host Mac (Apple Silicon, `arm64`). Both `arm64` and `x64` artifacts were
produced by the same `npm run dist:mac` run; only the `arm64` build was actually launched and
exercised (no Intel Mac / Rosetta test performed here).

What was verified against `release/mac-arm64/Alfred.app`:

- **App launches and the window loads** — using `AGENT_ROOMS_TEST_MODE=1` /
  `AGENT_ROOMS_TEST_DATA=<tmpdir>` (same mechanism `tests/smoke.cjs` uses) with Playwright's
  `_electron.launch({ executablePath: '.../Alfred.app/Contents/MacOS/Alfred' })` instead of
  `electron .`. `window.rooms` becomes available and `detectAgents()` returns the real shell.
- **Native PTY works** — created a real `shell` session through the packaged app, wrote to it, and
  read back its output (confirms `node-pty`'s native addon loads correctly from
  `app.asar.unpacked`).
- **Provider allowlist still enforced** — `createSession` with an arbitrary (non-allowlisted)
  provider id rejects, same as the existing smoke test.
- **Room MCP bridge starts from the packaged app** — spawned
  `Alfred.app/Contents/MacOS/Alfred` directly with `ELECTRON_RUN_AS_NODE=1` and the in-asar path
  to `desktop/room-mcp-bridge.mjs` (exactly how `agent-runner.cjs`'s `cliRunner` invokes it), using
  a real `@modelcontextprotocol/sdk` stdio `Client` to call `listTools()`. It returned both
  `room_send` and `room_spawn`. No model/provider process was launched — this only exercises the
  bridge's own MCP server startup and tool registration.
- **DMG mounts** — both the `arm64` and `x64` `.dmg` files mount via `hdiutil attach` and contain
  `Alfred.app` plus the usual `Applications` symlink.

These checks used scratch scripts outside the repo (not committed): a packaged-app variant of
`tests/smoke.cjs` and a small MCP stdio-client script that lists the bridge's tools. They are not
part of `npm test` / `npm run test:smoke` — those still run against the dev build via `electron .`,
unchanged.

### Artifact sizes (this build)

| Artifact | Size |
|---|---|
| `Alfred-0.1.0-arm64.dmg` | ~127 MB |
| `Alfred-0.1.0-arm64-mac.zip` | ~127 MB |
| `Alfred-0.1.0.dmg` (x64) | ~130 MB |
| `Alfred-0.1.0-mac.zip` (x64) | ~131 MB |
| `mac-arm64/Alfred.app` (unpacked) | ~309 MB |
| `mac/Alfred.app` (unpacked, x64) | ~312 MB |

Most of that is the bundled Electron/Chromium runtime, which is normal for an Electron app; the
app's own code is small (`app.asar` ~13 MB + `app.asar.unpacked` ~7.6 MB, covering `desktop/`,
`dist/`, and the unpacked native/MCP dependencies above).

## Gatekeeper (unsigned app) — instructions for users

Because this build has no Apple Developer ID signature and is not notarized, macOS Gatekeeper will
block a plain double-click the first time, usually with a message like *"Alfred can't be opened
because Apple cannot check it for malicious software"* or *"...is damaged and can't be opened"*
(the latter is Gatekeeper's confusing wording for "unsigned/quarantined," not actual corruption).

To open it anyway:

1. **Right-click (or Control-click) `Alfred.app` → Open**, then click **Open** in the dialog that
   appears. This only needs to be done once per machine.
2. If that dialog doesn't offer an "Open" button, go to **System Settings → Privacy & Security**,
   scroll down, and click **Open Anyway** next to the Alfred entry, then confirm.
3. **Advanced / scripted option** — remove the quarantine attribute macOS attaches to anything
   downloaded from the internet:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Alfred.app
   ```
   Only do this for a build you trust the source of; it bypasses the Gatekeeper prompt entirely
   rather than walking through it.

## Known limitations

- **Unsigned, not notarized** — expect the Gatekeeper friction above on every machine the app is
  copied to, and no automatic-update signature checks are possible.
- **x64 build is untested on real Intel/Rosetta hardware** — it packages successfully and its
  `node-pty` native dependency was rebuilt for `darwin-x64`, but only the `arm64` artifact was
  actually launched and exercised in this pass.
- **No auto-update wiring** — `electron-builder`'s `latest-mac.yml`/blockmap files are emitted as a
  build byproduct but nothing in the app consumes them; there is no update server or `autoUpdater`
  integration.
- **No GitHub Release / publish step** — `dist:mac` only builds local artifacts in `release/`. Per
  the owner's standing instruction, publishing a GitHub Release requires an explicit go-ahead and
  is not part of this build script.
- **Large app size (~300+ MB per architecture)** is inherent to bundling Electron/Chromium and is
  not specific to this packaging config.

## Native module note

Building the x64 target rebuilds `node_modules/node-pty` for x86_64, which breaks local `npm run dev` / `npm run test:smoke` on Apple Silicon (`posix_spawnp failed`). `npm run dist:mac` therefore runs `postdist:mac` (`electron-rebuild -f -w node-pty`) to restore the host build. If you invoke `electron-builder` directly, run that command afterwards.
