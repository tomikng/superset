---
name: desktop-release-local
description: Build, Developer-ID sign, notarize and publish the self-hosted Superset desktop app (macOS arm64) from THIS machine, without GitHub Actions. Use for any release of the ms1 self-host build.
---

# Local signed + notarized desktop release

The GitHub `release-desktop.yml` workflow can't run for the private mirror
(`tomikng/superset`) — it has no signing secrets and builds on 7 GB runners. So
self-host releases are built here and published by copying the artifacts to
`ms1:~/superset-releases/` (the `/releases` update feed). This mirrors the
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
export DESKTOP_UPDATE_FEED_URL=https://superset-app.tom-nguyen.dev/releases   # never the upstream feed
bun run install:deps && bun run clean:dev && bun run generate:icons && bun run compile:app \
  && bun run copy:native-modules && bun run validate:native-runtime
export CSC_NAME="<Developer ID name> (Q89XY3A42H)"   # no "Developer ID Application:" prefix — electron-builder rejects it
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

The feed is the static `releases` launchd job on ms1 serving
`~/superset-releases` at `https://superset-app.tom-nguyen.dev/releases/`
(deploy/launchd/README.md "Desktop update feed"). GitHub Releases can't be the
feed: the mirror is private, so assets 404 for the anonymous updater. Publishing
is four files over scp (`ms1` is an ssh alias):

```bash
cd apps/desktop/release
ssh ms1 'mkdir -p ~/superset-releases'
scp Superset-<ver>-arm64-mac.zip Superset-<ver>-arm64-mac.zip.blockmap \
    Superset-<ver>-arm64.dmg ms1:~/superset-releases/
ssh ms1 'cp ~/superset-releases/Superset-<ver>-arm64.dmg ~/superset-releases/Superset-arm64.dmg'
scp latest-mac.yml ms1:~/superset-releases/          # last: this is what flips the feed
```

Order matters: the yml names the zip by filename and sha512, so copy the zip
(and blockmap) before the yml or an app checking in between gets a 404.
`Superset-arm64.dmg` is the stable name the web "Download for Mac" button
links to (`NEXT_PUBLIC_DOWNLOAD_URL_MAC_ARM64`); the versioned dmg next to it is
just for the record.

Verify from outside:

```bash
curl -s  https://superset-app.tom-nguyen.dev/releases/latest-mac.yml          # version: <ver>, path: Superset-<ver>-arm64-mac.zip
curl -sI https://superset-app.tom-nguyen.dev/releases/Superset-<ver>-arm64-mac.zip | head -1   # 200
curl -sI https://superset-app.tom-nguyen.dev/releases/Superset-arm64.dmg | head -1             # 200
```

The GitHub release is now archive + changelog only — nothing reads it:

```bash
gh release create v<ver>-selfhost.<n> release/Superset-<ver>-arm64.dmg \
  release/Superset-<ver>-arm64-mac.zip release/latest-mac.yml \
  --title "Superset <ver> — ms1 self-host (arm64)" --notes-file notes.md
```

Tag pattern `v<ver>-selfhost.<n>` on purpose: `desktop-v*` / `cli-v*` would trigger
the upstream release workflows.

**Re-cuts are invisible to installed apps.** electron-updater compares the yml's
`version` with the running app's `package.json` version, and only offers a
strictly newer one. A `-selfhost.3` re-cut of the same `1.25.0` replaces the
feed for *new* downloads but is never offered to anyone already on `1.25.0`.
If existing installs must pick it up, the version has to move — and per
non-negotiable 2 that means bumping desktop, host-service and cli together.

## Verify before announcing

- `spctl` checks above; `xcrun stapler validate` on both app and DMG.
- Mount the DMG, launch the app from it once (no right-click → Open needed) and
  sign in against the ms1 backend.

## Known gotchas (seen on 1.25.1 / 1.25.2, 2026-08-27)

- **The `hive-notary` keychain item can vanish after electron-builder's app
  notarization.** Twice in a row it worked for the `.app` inside `bun run
  package` and was gone (`No Keychain password item found`) by the time the
  DMG was submitted minutes later; nothing in the repo or `@electron/notarize`
  deletes it. Until the cause is known: run the DMG `notarytool submit`
  *immediately* after packaging, and if it fails, re-store the profile
  (`xcrun notarytool store-credentials hive-notary --apple-id <apple-id>
  --team-id Q89XY3A42H`, fresh app-specific password) and retry.
- **Do not call the auth API with `fetch` from the main process.** Electron's
  main-process fetch is undici and sends `Sec-Fetch-Mode: cors`; Better Auth
  then force-validates the (absent) Origin → "Missing or null Origin". Use a
  bare `node:https` request (see `auth.signInWithPassword`).
