---
name: desktop-release-local
description: Build, Developer-ID sign, notarize and publish the self-hosted Superset desktop app (macOS arm64) from THIS machine, without GitHub Actions. Use for any release of the ms1 self-host build.
---

# Local signed + notarized desktop release

The GitHub `release-desktop.yml` workflow can't run for the private mirror
(`tomikng/superset`) — it has no signing secrets and builds on 7 GB runners. So
self-host releases are built here and uploaded with `gh`. This mirrors the
`hive-build` skill in `Agentic-Editor` (same Apple identity, same notary profile).

## Non-negotiables

1. **Bun 1.3.14** — `.bun-version`. The `bun` on PATH is Homebrew/nvm 1.2.17 and
   can't read `bun.lock` `configVersion: 1`. Always `export PATH="$HOME/.bun/bin:$PATH"`
   (install: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"`).
2. **Build from a worktree of `origin/selfhost`**, never from the `main` checkout:
   `git worktree add ../superset-release origin/selfhost`. `selfhost` = `main` +
   invitation-only auth + `deploy/` configs. Don't bump `apps/desktop/package.json`
   version — `bun run check:versions` requires desktop == host-service == cli.
3. **Disk**: `df -h /` needs ≥ 8 GB free (node_modules ~4 GB, `release/` ~2 GB).
   Safe reclaim: `~/.bun/install/cache` (11 GB, regenerable), `apps/desktop/release`.
4. **Detach long steps** (`nohup … & disown`, log to a file) — install ~2 min,
   compile ~5 min, package + notarize ~10-15 min. The harness kills foreground jobs.
5. **Backend URLs are compiled in** (renderer + CSP). They come from
   `deploy/env.production.template`; a build only talks to the instance it was
   built for.

## Identity / notary

- `Developer ID Application: <Developer ID name> (Q89XY3A42H)` — in the login keychain
  (`security find-identity -v -p codesigning`).
- Notary creds: keychain profile **`hive-notary`** (same Apple team; verify with
  `xcrun notarytool history --keychain-profile hive-notary`). If it's dead, ask the
  user for a fresh app-specific password and `xcrun notarytool store-credentials` —
  never echo it.
- electron-builder does sign + notarize + staple the `.app` itself when
  `APPLE_KEYCHAIN_PROFILE` is set (`mac.notarize: true`, `hardenedRuntime: true`,
  entitlements in `apps/desktop/resources/build/entitlements.mac*.plist`).
  It does **not** sign/notarize the DMG — do that by hand (below).

## The build (`scripts` below were used for v1.25.0-selfhost.2)

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd ../superset-release && bun install --frozen
cd apps/desktop
export NODE_ENV=production TARGET_ARCH=arm64 SUPERSET_WORKSPACE_NAME=superset
export NEXT_PUBLIC_API_URL=https://superset-api.tom-nguyen.dev
export NEXT_PUBLIC_WEB_URL=https://superset-app.tom-nguyen.dev
export NEXT_PUBLIC_DOCS_URL=https://superset-app.tom-nguyen.dev
export NEXT_PUBLIC_MARKETING_URL=https://superset-app.tom-nguyen.dev
export RELAY_URL=https://superset-relay.tom-nguyen.dev
export NEXT_PUBLIC_POSTHOG_KEY=phc_unused_selfhosted NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
bun run install:deps && bun run clean:dev && bun run generate:icons && bun run compile:app \
  && bun run copy:native-modules && bun run validate:native-runtime
export CSC_NAME="Developer ID Application: <Developer ID name> (Q89XY3A42H)"
export APPLE_KEYCHAIN_PROFILE=hive-notary APPLE_TEAM_ID=Q89XY3A42H
bun run package -- --publish never --config electron-builder.ts --arm64
```

Output in `apps/desktop/release/`: `Superset-<ver>-arm64.dmg`,
`Superset-<ver>-arm64-mac.zip`, `latest-mac.yml`, `mac-arm64/Superset.app`.

## DMG: sign, notarize, staple, verify

```bash
cd apps/desktop/release
codesign --force -s Q89XY3A42H Superset-<ver>-arm64.dmg
xcrun notarytool submit Superset-<ver>-arm64.dmg --keychain-profile hive-notary --wait
xcrun stapler staple Superset-<ver>-arm64.dmg
spctl -a -t open --context context:primary-signature -v Superset-<ver>-arm64.dmg   # "accepted source=Notarized Developer ID"
spctl -a -t exec -vv mac-arm64/Superset.app                                      # "accepted source=Notarized Developer ID"
```

Signing the DMG after `latest-mac.yml` was generated doesn't matter — the
updater downloads the **zip**, and the yml's sha512 refers to the zip.

## Publish

```bash
gh release create v<ver>-selfhost.<n> release/Superset-<ver>-arm64.dmg \
  release/Superset-<ver>-arm64-mac.zip release/latest-mac.yml \
  --title "Superset <ver> — ms1 self-host (arm64)" --notes-file notes.md
```

Tag pattern `v<ver>-selfhost.<n>` on purpose: `desktop-v*` / `cli-v*` would trigger
the upstream release workflows. The desktop updater reads
`releases/latest/download/latest-mac.yml`, so the newest self-host release must be
the repo's "latest".

## Verify before announcing

- `spctl` checks above; `xcrun stapler validate` on both app and DMG.
- Mount the DMG, launch the app from it once (no right-click → Open needed) and
  sign in against the ms1 backend.
