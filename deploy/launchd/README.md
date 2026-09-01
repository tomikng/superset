# launchd services for self-hosted Superset on `ms1`

Five supervised jobs that bring the whole stack back after a reboot of the
MacBook running as `ms1`:

| Label | What it runs | Listens on | Public hostname |
|---|---|---|---|
| `dev.tom-nguyen.superset.stack` | `docker compose -p superset -f deploy/docker-compose.prod.yml --env-file deploy/.env.docker up` (postgres, neon-proxy, redis, serverless-redis-http) | 127.0.0.1 only: 5432 / 4444 / 6379 / 8079 | — (internal) |
| `dev.tom-nguyen.superset.api` | `bun run start` in `apps/api` → `next start --port 3101` | 3101 | `superset-api.tom-nguyen.dev` |
| `dev.tom-nguyen.superset.web` | `bun run start` in `apps/web` → `next start` (`PORT=3100`) | 3100 | `superset-app.tom-nguyen.dev` |
| `dev.tom-nguyen.superset.relay` | `bun run start` in `apps/relay` → `bun run src/index.ts` | 3102 | `superset-relay.tom-nguyen.dev` |
| `dev.tom-nguyen.superset.releases` | `bun run deploy/releases-server.ts` serving `~/superset-releases` | 3103 | `superset-app.tom-nguyen.dev/releases/*` |

Every start command above is the `start` script from that app's
`package.json` — nothing was invented. Cloudflare Tunnel terminates TLS and
originates to `127.0.0.1` on these ports; no service binds a privileged port.

Files here:

```
dev.tom-nguyen.superset.stack.plist
dev.tom-nguyen.superset.api.plist
dev.tom-nguyen.superset.web.plist
dev.tom-nguyen.superset.relay.plist
install.sh          # substitutes __PLACEHOLDER__ paths, installs, bootstraps
README.md
```

**Which compose file.** The `stack` job runs `deploy/docker-compose.prod.yml`
with `deploy/.env.docker` as compose's `--env-file` — *not* the repo-root
`docker-compose.yml`. The repo file is the dev stack: it hardcodes
`POSTGRES_PASSWORD: postgres` and `SRH_TOKEN: local_dev_token` with no `${}`
substitution, and publishes on all interfaces. The production file takes
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `SRH_TOKEN` from
`.env.docker`, binds every port to `127.0.0.1`, and uses the named volume
`superset_db_data_prod`. Running the repo file under the same project name would
collide on container names and point Postgres at a *different, empty* volume.
`install.sh` refuses to install if `docker-compose.prod.yml` or `.env.docker` is
missing, and if `SRH_TOKEN` there disagrees with `KV_REST_API_TOKEN` in `.env`.
`smoke-test.sh` probes the same project/file/env-file triple.

The plists ship with `__SUPERSET_ROOT__`, `__DEPLOY_DIR__`, `__HOME__`,
`__BUN_BIN__`, `__BUN_DIR__` and `__DOCKER_BIN__` placeholders. They are **not** loadable as
written — `install.sh` resolves them against the real machine. That is
deliberate: a hardcoded wrong path in a launchd plist fails silently at boot,
which is the worst possible failure mode for a headless box.

---

## LaunchAgents, not LaunchDaemons — and the cost of that

**Chosen: user LaunchAgents in `~/Library/LaunchAgents`, loaded into the
`gui/<uid>` domain.**

The tempting answer for "must survive reboot with nobody at the keyboard" is
`/Library/LaunchDaemons`, which runs as root at boot before any login. It does
not work here, for one hard reason and three soft ones:

1. **Docker is the blocker.** `DEVELOPMENT.md` lists the Docker prerequisite as
   "Docker Desktop or OrbStack". Both are macOS `.app` bundles that run a Linux
   VM inside a *logged-in user's* session, and both expose the CLI socket under
   the user's home directory rather than at `/var/run/docker.sock`. A root
   LaunchDaemon has `HOME=/var/root`, no Aqua session, and no way to start or
   reach either one. `postgres`, `neon-proxy`, `redis` and
   `serverless-redis-http` all come from the compose stack
   (`deploy/docker-compose.prod.yml`), so if the daemon can't reach Docker,
   nothing else matters.
2. **Bun is a per-user install.** The official installer puts it at
   `~/.bun/bin/bun`. Root's launchd job would need it copied or symlinked into a
   system path.
3. **The `.env` is the entire secret store** — `BETTER_AUTH_SECRET`,
   `SECRETS_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`. Keeping it
   `chmod 600` in the deploy user's home and running the services as that user
   is least-privilege. Root buys nothing.
4. **No privileged ports.** 3100, 3101 and 3102 are all above 1024. The one
   classic reason to need a LaunchDaemon does not apply.

**The cost, stated plainly: user agents do not run before login.** For a
headless server that means three machine-level settings that are *not* in this
repo and must be done by hand on `ms1`:

```bash
# 1. Automatic login for the deploy user.
#    System Settings -> Users & Groups -> Automatically log in as: <deploy user>

# 2. FileVault must be OFF. FileVault blocks automatic login outright: the disk
#    is locked until a human types a password at the pre-boot screen, and no
#    launchd job of any kind runs before that. Accept this trade knowingly —
#    it is the price of an auto-recovering Mac server.
sudo fdesetup status      # expect: FileVault is Off

# 3. Come back by itself after a power cut, and never sleep.
sudo pmset -a autorestart 1
sudo pmset -a sleep 0 disksleep 0
sudo pmset -a womp 1
```

Rejected alternative: LaunchDaemons for the three Bun services plus a
LaunchAgent for compose. That gives a split-brain boot order — the daemons come
up minutes before the agent's Docker VM exists, run as root, write root-owned
logs, and read the deploy user's secret file. It is strictly worse than
accepting auto-login.

---

## Finding the bun binary (the classic failure)

launchd starts every job with

```
PATH=/usr/bin:/bin:/usr/sbin:/sbin
```

and **nothing else**. It does not source `~/.zshrc`, `~/.zprofile`,
`/etc/paths.d`, or anything else an interactive shell reads. `~/.bun/bin` is
therefore not on PATH, and a plist whose `ProgramArguments` starts with the bare
string `bun` dies instantly with `Operation not permitted` or exit code 127 —
usually with no output at all, because the job never got far enough to open its
log files.

Two consequences, both handled by these plists:

- `ProgramArguments` uses an **absolute** path to `bun`.
- `EnvironmentVariables` still sets a full `PATH`, because Bun and Next spawn
  child processes that resolve tools by name.

Resolve the path on `ms1`, in an interactive shell:

```bash
command -v bun
# ~/.bun/bin/bun          official installer (most likely)
# /opt/homebrew/bin/bun   Homebrew, Apple Silicon
# /usr/local/bin/bun      Homebrew, Intel

# Follow symlinks and version-manager shims (mise / asdf / fnm) to the real file:
python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v bun)"

# Must match .bun-version, which pins 1.3.14:
bun --version
cat /path/to/superset/.bun-version
```

If `bun` turns out to be a shim script, bake the **resolved** binary into the
plist, not the shim — the shim will try to read a version-manager config that
launchd's environment cannot find.

Prove the path works the way launchd will see it, with an empty environment:

```bash
env -i /Users/<deploy-user>/.bun/bin/bun --version
```

Same procedure for `docker`, which is equally likely to live under
`~/.orbstack/bin/docker` or `/usr/local/bin/docker`.

---

## How the `.env` is loaded, and why not via `EnvironmentVariables`

`EnvironmentVariables` in a plist is a **static dictionary**. launchd cannot
read a file into it. There are only two real options:

1. Copy every variable into every plist — three duplicated copies of the secret
   store, kept in sync by hand, in world-readable `~/Library/LaunchAgents` files.
2. Have `ProgramArguments` run a shell that sources the `.env` and then `exec`s
   the real command.

These plists use **(2)**:

```
/bin/bash -c 'set -a; . <root>/.env; set +a; ... ; exec <bun> run start'
```

`EnvironmentVariables` is used only for what must exist *before* the file is
read, or must not be overridable by it: `HOME`, `PATH`, `NODE_ENV=production`,
and the relay's `FLY_*` identity values. `SKIP_ENV_VALIDATION` is deliberately
**not** among them — `deploy/env.production.template` gives every key required by
`apps/api/src/env.ts`, `apps/web/src/env.ts` and `packages/trpc/src/env.ts` a
value (the unused integrations get non-empty placeholders, which is what those
schemas ask for), so t3-env validation passes and remains a loud boot-time check
instead of a silenced one. The api plist carries a comment with the one
unverified case (`apps/web/src/env.ts` extends the `vercel()` preset, which could
not be inspected without `node_modules`) that would justify adding it back. The `exec`
matters: it replaces the shell, so launchd supervises and signals the actual
server process rather than a `bash` parent that would swallow SIGTERM.

**This wrapper is not optional.** Both `apps/api/next.config.ts` and
`apps/web/next.config.ts` load `../../.env` *only* when
`NODE_ENV !== "production"`:

```ts
if (process.env.NODE_ENV !== "production") {
  dotenvConfig({ path: join(process.cwd(), "../../.env"), override: true, quiet: true });
}
```

`next start` sets `NODE_ENV=production`, so in production those apps inherit
nothing from the repo-root `.env` on their own. `apps/relay`'s `start` script is
plain `bun run src/index.ts` — only its `dev` script passes
`--env-file=../../.env`. `packages/db/src/env.ts` does call `dotenv.config()` on
a path relative to `__dirname`, but `dotenv` never overwrites variables that are
already set and `__dirname` inside a bundled Next production server is not
`packages/db/src`, so that is not a mechanism to rely on.

### Two `.env` landmines the wrappers defuse

- **`PORT`.** `apps/web/package.json`'s `start` is a bare `next start` with no
  `--port`, so it takes the port from `$PORT` (default 3100). But
  `.superset/setup.local.sh` writes a bare `PORT` into the repo-root `.env`
  holding the **streams** port. If a dev `.env` were ever copied to `ms1`,
  sourcing it would move the web server off 3100 and the tunnel would point at
  nothing. The web wrapper therefore re-exports `PORT=3100` *after* sourcing.
  `apps/api` is immune — its `start` carries `--port 3101` explicitly.
- **`SUPERSET_ALLOW_SIGNUP`.** `packages/auth/src/server.ts` gates signup on
  `disableSignUp: process.env.SUPERSET_ALLOW_SIGNUP !== "true"`. That variable
  is meant to be set for exactly one run of `bun run db:seed-teams` and never
  again — it is the whole invitation-only model. Every wrapper `unset`s it after
  sourcing, so a stale line left in `.env` cannot quietly open public
  registration on an instance shared by three organizations.

### `.env` file syntax

`set -a; . file` sources the `.env` as **shell**, so it must be shell-safe:
`KEY=value`, no spaces around `=`, values with spaces or `#` quoted, and no
multi-line values. In this deployment `GH_APP_PRIVATE_KEY` is a placeholder, so
the usual multi-line-PEM problem does not arise — but if a real key is ever put
there, it must be a single line with `\n` escapes or this sourcing will break.

An alternative that avoids shell parsing entirely: the repo already depends on
`dotenv-cli` 11.0.0 at the root, and it is what the `dev` scripts use
(`dotenv -e ../../.env --`). After `bun install` you can swap the wrapper for
`exec <root>/node_modules/.bin/dotenv -e <root>/.env -- <bun> run start`.
I have not verified the exact on-disk location of that binary under
`bunfig.toml`'s `linker = "isolated"` install layout — check before switching.

---

## Before you load anything

launchd only supervises; it does not build. Do this once, as the deploy user:

```bash
cd /Users/<deploy-user>/superset          # clone root; deploy/ lives inside it

# 1a. Compose credentials. deploy/.env.docker is the ONLY place the Postgres
#     user/password/db and the SRH token are generated.
cd deploy
cp .env.docker.example .env.docker
chmod 600 .env.docker                     # then fill in: openssl rand -hex 32
cd ..

# 1b. Application .env — build it from deploy/env.production.template (NOT from
#     .env.example, and not from .env.local.example). Copy the same
#     user/password/db from .env.docker into DATABASE_URL and
#     DATABASE_URL_UNPOOLED, and the same SRH_TOKEN into KV_REST_API_TOKEN.
cp deploy/env.production.template .env
chmod 600 .env

bun install --frozen-lockfile

# 2. Bring the backing services up once by hand, so the DB exists.
docker compose -p superset -f deploy/docker-compose.prod.yml \
  --env-file deploy/.env.docker up -d
set -a; . ./.env; set +a                  # db:migrate needs DATABASE_URL_UNPOOLED
bun run db:migrate

# 3. BUILD — with the environment EXPORTED and turbo in loose env mode.
#    Two independent traps, both silent:
#      a) `next build` forces NODE_ENV=production, so apps/{api,web}/next.config.ts
#         skip their dotenv load of ../../.env. Nothing loads the file for you.
#      b) turbo 2.10.9 defaults to STRICT env mode and turbo.jsonc sets no
#         `envMode`; its globalEnv list does NOT include RELAY_URL,
#         NEXT_PUBLIC_RELAY_URL, NEXT_PUBLIC_COOKIE_DOMAIN or BETTER_AUTH_SECRET,
#         so a plain `turbo build` strips them out of the build environment.
#         Losing RELAY_URL makes apps/web/next.config.ts fall back to a CSP
#         containing wss://relay.superset.sh — curl still shows a clean 101 on
#         the relay, but every browser blocks the terminal WebSocket.
#    The root `build` script is `turbo build --filter=@superset/desktop` and does
#    NOT build api or web. Be explicit:
set -a; . ./.env; set +a
bunx turbo build --filter=@superset/api --filter=@superset/web --env-mode=loose

# 4. Seed the accounts. See the header comment in
#    packages/auth/src/seed-teams.ts for the signup-guard prerequisite.
#    NODE_ENV=development is REQUIRED, not cosmetic: signUpEmail creates a
#    personal org through auth.api.createOrganization, and
#    packages/auth/src/server.ts afterCreateOrganization calls
#    stripeClient.customers.create() un-caught whenever NODE_ENV != development
#    — with the placeholder Stripe key that throws and the seed dies part-way.
SUPERSET_ALLOW_SIGNUP=true SEED_TEAMS_CONFIRM=yes NODE_ENV=development \
  bun run db:seed-teams
#    ...then make sure SUPERSET_ALLOW_SIGNUP is nowhere in .env.
#    The script prints each generated password exactly once — save them.

# 5. Stop the hand-started compose stack; launchd owns it from here.
docker compose -p superset -f deploy/docker-compose.prod.yml \
  --env-file deploy/.env.docker down
```

Any time you `git pull`, repeat steps 2–3 and then restart the services.

---

## Install

```bash
cd /path/to/deploy/launchd
chmod +x install.sh
./install.sh /Users/<deploy-user>/superset
# optional second argument: the directory holding docker-compose.prod.yml and
# .env.docker. Defaults to the parent of install.sh (i.e. deploy/), which is
# conventionally <clone>/deploy — the path pg-backup.sh and smoke-test.sh assume.
```

`install.sh` resolves `bun` and `docker`, warns if `bun --version` disagrees
with `.bun-version`, creates `~/Library/Logs/superset`, `plutil -lint`s each
generated plist, and bootstraps all four jobs in order (`stack`, then `api`,
`web`, `relay`).

`mkdir -p ~/Library/Logs/superset` is load-bearing: **launchd does not create
log directories**, and a job whose `StandardOutPath` directory is missing fails
to spawn with no diagnostic in any obvious place.

To do it by hand instead:

```bash
mkdir -p ~/Library/Logs/superset ~/Library/LaunchAgents
sed -e 's|__SUPERSET_ROOT__|/Users/me/superset|g' \
    -e 's|__DEPLOY_DIR__|/Users/me/superset/deploy|g' \
    -e 's|__HOME__|/Users/me|g' \
    -e 's|__BUN_BIN__|/Users/me/.bun/bin/bun|g' \
    -e 's|__BUN_DIR__|/Users/me/.bun/bin|g' \
    -e 's|__DOCKER_BIN__|/usr/local/bin/docker|g' \
    dev.tom-nguyen.superset.api.plist \
    > ~/Library/LaunchAgents/dev.tom-nguyen.superset.api.plist
plutil -lint ~/Library/LaunchAgents/dev.tom-nguyen.superset.api.plist
```

---

## Load, unload, restart, inspect

Use the modern `launchctl` subcommands. `launchctl load`/`unload` are deprecated
and report success on jobs that never started.

```bash
D="gui/$(id -u)"

# Load (and start, because RunAtLoad is true)
launchctl bootstrap "$D" ~/Library/LaunchAgents/dev.tom-nguyen.superset.api.plist

# Unload / stop
launchctl bootout "$D/dev.tom-nguyen.superset.api"

# Restart in place (SIGTERM then respawn) — the everyday command after a deploy
launchctl kickstart -k "$D/dev.tom-nguyen.superset.api"

# Full status: PID, last exit status, resolved environment, throttle state
launchctl print "$D/dev.tom-nguyen.superset.api"

# One-line listing of all four
launchctl list | grep superset

# Persistently disable a job across reboots (survives bootout)
launchctl disable "$D/dev.tom-nguyen.superset.web"
launchctl enable  "$D/dev.tom-nguyen.superset.web"
```

Restart everything after a `git pull` + rebuild:

```bash
D="gui/$(id -u)"
for s in stack api web relay; do
  launchctl kickstart -k "$D/dev.tom-nguyen.superset.$s"
done
```

`launchctl disable` state is sticky and outlives `bootout` — a job that refuses
to start after you re-bootstrap it is almost always still disabled. Check the
`state` line in `launchctl print`.

---

## Logs

Everything goes to `~/Library/Logs/superset/`, one pair per service:

```bash
tail -F ~/Library/Logs/superset/*.log            # everything at once
tail -F ~/Library/Logs/superset/relay.err.log    # one service
tail -F ~/Library/Logs/superset/stack.out.log    # container output
```

Files: `stack`, `api`, `web`, `relay` × `.out.log` / `.err.log`.

launchd's own complaints about a job (spawn failures, throttling, bad plist) do
**not** land in those files. They go to the unified log:

```bash
log stream --predicate 'subsystem == "com.apple.xpc.launchd"' --info \
  | grep superset

# after the fact:
log show --last 30m --predicate 'eventMessage CONTAINS "superset"' --info
```

Nothing rotates these by default. Add `/etc/newsyslog.d/superset.conf`:

```
# logfilename                                       [owner:group]  mode count size when  flags
/Users/<deploy-user>/Library/Logs/superset/*.log    <deploy-user>:staff  644  7  10240  *     GN
```

`G` (glob) and `N` (do not signal the process) matter — the servers hold their
log fds open and are not going to reopen them on a HUP.

---

## KeepAlive and the throttle

Every job is `RunAtLoad=true` + `KeepAlive=true` (unconditional restart, which
is what you want for a server: restart whether it exited 0 or crashed).

`ThrottleInterval` is the minimum seconds between respawns. launchd's default is
10; these use:

- **30s for `stack`** — after a cold boot the Docker/OrbStack VM can take 30–60
  seconds to answer `docker info`. A tight throttle just burns respawns.
- **20s for `api`, `web`, `relay`** — long enough that a boot-order crash loop
  settles quietly, short enough to recover from a real crash fast.

When you see this in the unified log, it is the throttle doing its job, not an
error:

```
Service only ran for 0 seconds. Pushing respawn out by 20 seconds.
```

A job that logs that *repeatedly* is crash-looping — read its `.err.log`.

### Boot ordering

launchd has no dependency graph; all four jobs are bootstrapped at once. Two
things cover the ordering:

1. Each app wrapper polls with `/usr/bin/nc -z` for up to ~3 minutes (60 × 3s)
   before exec'ing — `api` waits on the neon-proxy port
   (`${LOCAL_NEON_PROXY_PORT:-4444}`) and `web` waits on the api on 3101; the
   `relay` no longer waits on anything (it stopped using Redis when it moved to
   tunnel v2, see `apps/relay/README.md`). The window is
   3 minutes, not 30s, because on a cold boot the `stack` job first has to wait
   for the Docker VM (`until docker info`) before any container port exists.
   This is the same dependency order `smoke-test.sh` asserts: containers, then
   local ports, then the public hostnames.
2. If the wait times out and the process exits, `KeepAlive` + `ThrottleInterval`
   retry every 20s until the stack is up. The loop is a nicety for readable
   logs; the throttle is the actual correctness guarantee.

### Other plist keys, and why

- `ProcessType=Interactive` — keeps macOS from applying background CPU/IO
  throttling and App Nap to long-lived servers. The default (`Standard`) is
  acceptable; `Background` would be actively harmful.
- `SoftResourceLimits.NumberOfFiles` — launchd agents inherit a **256** open-file
  limit. The relay is the WebSocket terminator for every host-service tunnel and
  `apps/relay/fly.toml` sets an http soft connection limit of 2000, so it gets
  16384/32768; the Next servers get 8192/16384.
- `ExitTimeOut=30` on the relay — `apps/relay/src/index.ts` handles SIGINT and
  SIGTERM by closing the listener and every host control socket (1001) so
  host-services reconnect within seconds instead of waiting on their 75s
  watchdog after a TCP RST. launchd's default `ExitTimeOut` is 20s, raised to
  30 so a SIGKILL never truncates the drain.
- `ExitTimeOut=60` on the stack — four containers, including a Postgres that
  deserves a clean shutdown.
- `FLY_REGION` on the relay — a Fly-era label that `apps/relay/src/env.ts`
  defaults to `"local"`; set to `ms1` so `/health` and `/_whoowns` identify this
  box. Since the tunnel v2 port there is no host directory keyed on it, so it is
  purely cosmetic (`FLY_MACHINE_ID` / `FLY_APP_NAME` are no longer read).

---

## Verifying after a reboot

```bash
sudo shutdown -r now
# wait for auto-login, then:

launchctl list | grep superset          # four labels, PID present, status 0
curl -s localhost:3102/health           # {"ok":true,"region":"ms1"}
curl -sI localhost:3100                 # web
curl -sI localhost:3101                 # api
docker compose -p superset -f deploy/docker-compose.prod.yml \
  --env-file deploy/.env.docker ps      # 4 containers up

curl -sI https://superset-app.tom-nguyen.dev
curl -sI https://superset-api.tom-nguyen.dev
```

`GET /health` on the relay is defined at `apps/relay/src/index.ts:99`. **I found
no equivalent dedicated health endpoint under `apps/api/src/app/`** — use a
plain `curl -sI localhost:3101` for liveness there, or pick a real route.

The Cloudflare Tunnel itself is not covered by these plists — see
`deploy/cloudflared/README.md`, which is authoritative for it. Note that it
deliberately does **not** use `sudo cloudflared service install`: that command
hardcodes the label `com.cloudflare.cloudflared` and would clobber the existing
rc-hub tunnel already installed on `ms1`. It installs a hand-written LaunchDaemon
labelled `com.cloudflare.cloudflared.ms1` running
`cloudflared --config ~/.cloudflared/ms1.yml tunnel run`, pointing at
`http://127.0.0.1:3101` (api), `:3100` (web) and `:3102` (relay) — the same three
ports these plists bind.

---

## Things stated here that I could not verify from the repo

- The deploy user name, the clone path on `ms1`, and the absolute paths to `bun`
  and `docker` on `ms1`. Hence the placeholders and `install.sh`.
- Which container runtime `ms1` uses. `DEVELOPMENT.md` says "Docker Desktop or
  OrbStack"; the exact CLI path and socket location differ between them.
- Whether `deploy/` is placed at `<clone>/deploy` on `ms1`. That is the
  convention every artifact here now assumes (`pg-backup.sh`, `smoke-test.sh`,
  the `stack` plist via `__DEPLOY_DIR__`); `install.sh` takes an override
  argument if it lands elsewhere.
- The compose project name `-p superset` is my choice.
  `.superset/setup.local.sh` uses a per-worktree `$LOCAL_DB_PROJECT`, which is a
  dev-workspace concern and does not apply to a single production deployment.
- `ProcessType`, `NumberOfFiles`, `ThrottleInterval` and `ExitTimeOut` values are
  operational judgement, informed by `apps/relay/fly.toml`, not values found in
  the repo.
- Whether `next start` for `apps/web` will be reached at all depends on a prior
  successful `next build` — the repo has no production build/deploy script for
  `apps/api` / `apps/web` (the root `build` script targets `@superset/desktop`,
  and `apps/relay/scripts/deploy.sh` targets Fly).
- The exact path of `node_modules/.bin/dotenv` under `bunfig.toml`'s
  `linker = "isolated"` layout, mentioned as an alternative to shell-sourcing.
- `apps/api` health endpoint: none found.

---

## Auto-deploy (push to selfhost)

`.github/workflows/deploy-selfhost.yml` runs on every push to `selfhost` (and
on `workflow_dispatch`), gated on `github.repository == 'tomikng/superset'`. It
does **not** run on a GitHub-hosted runner: `runs-on: [self-hosted, macOS, ms1]`
means the job executes on `ms1` itself, as the deploy user, so it can touch the
live clone and the `gui/<uid>` launchd domain. There is no `actions/checkout`
step — the runner's scratch workspace is irrelevant; the target is
`~/Code/superset`, the clone the plists point at.

Two steps, both `cd`'d into that clone:

1. **Advance.** Refuse if the tree is dirty, record `prev=$(git rev-parse HEAD)`,
   `git fetch fork selfhost`, `git merge --ff-only <pushed sha>`. Fast-forward
   only: if someone committed on `ms1` directly, the deploy fails instead of
   producing a merge commit that exists nowhere else.
2. **Deploy.** `deploy/deploy.sh <prev-sha>`, appended to
   `~/Library/Logs/superset/deploy.log`.

What `deploy/deploy.sh` does, and deliberately does not:

- **Never fetches or merges.** The caller advances the tree; the script only
  realises whatever `HEAD` is. That is what makes it safe to run by hand.
- **Refuses a dirty tree** (`git status --porcelain` must be empty). A stray
  edit on `ms1` would otherwise get baked into a build nobody can reproduce.
- **One at a time.** `mkdir .deploy.lock` in the clone root is the lock; a lock
  older than 30 minutes is treated as a crashed run and cleared. The workflow's
  `concurrency: deploy-selfhost` queues pushes on the GitHub side too.
- **Diff-driven.** `git diff --name-only <prev> HEAD` decides everything:
  `bun.lock` moved → `bun install --frozen`; `packages/db/drizzle/` moved →
  `bun run db:migrate`; `apps/api`, `apps/web` or anything shared
  (`packages/`, root `package.json`, `turbo.json`, `.bun-version`, `tsconfig*`)
  → `turbo build` for that app and `launchctl kickstart -k` of only that
  service; `apps/relay` → restart only (it runs from source). A commit that
  touches none of those exits 0 with "nothing to do". Without a `<prev-sha>`
  argument, or with one that isn't in the clone, it rebuilds and restarts
  everything.
- **Builds with `--env-mode=loose`.** Turbo's strict mode strips `RELAY_URL` &
  co. from the build environment and the web CSP silently falls back to
  `relay.superset.sh`. Same `.env` sourcing rules as step 3 of "Before you load
  anything"; `SUPERSET_ALLOW_SIGNUP` is unset.
- **Health-checks** each restarted service on its local port (api
  `/api/auth/ok` → 200, web `/sign-in` → 200/307, relay `/` → any 2xx–4xx),
  30 tries × 3 s, and fails the run otherwise.
- **Discord.** Posts start/failure/success to `DISCORD_WEBHOOK_URL` from
  `~/.superset-selfhost.env` (untracked, `chmod 600`). No file, no webhook, no
  error.

Run one by hand (after you have advanced the clone yourself):

```bash
cd ~/Code/superset
prev=$(git rev-parse HEAD)
git fetch fork selfhost && git merge --ff-only fork/selfhost
deploy/deploy.sh "$prev"       # omit the sha to force a full rebuild/restart
```

### Installing the runner

`deploy/runner/install-runner.sh` does the whole thing: downloads
`actions-runner` for macOS arm64 into `~/actions-runner`, registers it against
the mirror with a short-lived token, applies the `ms1` label, and installs it as
a launchd service through the runner's own `./svc.sh install` / `./svc.sh start`.
The token is minted with `gh` (authenticated as a repo admin) and expires in an
hour, so there is nothing to store:

```bash
gh api -X POST repos/tomikng/superset/actions/runners/registration-token -q .token
```

**The gotcha is the same one as every other job in this README.** `svc.sh`
installs a *user* LaunchAgent (`actions.runner.tomikng-superset.ms1.plist` in
`~/Library/LaunchAgents`). It runs only while the deploy user has a GUI session,
which is exactly what we want — it must reach the deploy user's `bun`, `docker`
and `gui/<uid>` launchd domain — but it means the auto-login / FileVault-off /
`pmset` settings under "LaunchAgents, not LaunchDaemons" apply to the runner
too. If the runner shows *Offline* in GitHub → Settings → Actions → Runners after
a reboot, the machine is sitting at the login screen. Do not "fix" it by
installing the runner as a root LaunchDaemon: it would then be unable to
kickstart the user-domain services and the deploy would fail at the restart
step, after the build.

Runner logs: `~/actions-runner/_diag/`; the launchd wrapper logs to
`~/Library/Logs/actions.runner.*.log`. `~/actions-runner/svc.sh status` tells
you whether launchd thinks it is running.

---

## Desktop update feed (`/releases`)

The desktop app checks for updates with electron-updater, which fetches
`latest-mac.yml` from a base URL and then the zip that file names. Two feeds
are unavailable to the self-host build, for different reasons:

- **GitHub Releases on the mirror.** `tomikng/superset` is private. Release
  assets on a private repo 404 for an anonymous `GET` — and the updater is
  anonymous. Fine for humans with `gh`; useless as a feed.
- **The upstream feed** (`superset-sh/superset/releases/latest/download`). It
  is public and the updater would happily follow it — straight into a build
  with `api.superset.sh` compiled in. The self-host build therefore sets
  `DESKTOP_UPDATE_FEED_URL` at compile time
  (`apps/desktop/src/main/lib/auto-updater.ts`) to
  `https://superset-app.tom-nguyen.dev/releases`, and that URL must exist.

So the feed is a fifth launchd job, `dev.tom-nguyen.superset.releases`: Bun
running `deploy/releases-server.ts`, bound to `127.0.0.1:3103`, serving
`~/superset-releases` under the `/releases/` prefix (GET/HEAD only, no directory
listing, no path escape). It reads no `.env`. `install.sh` installs it with the
others. `deploy/cloudflared/config.yml` has a path rule for it on the web
hostname:

```yaml
- hostname: superset-app.tom-nguyen.dev
  path: ^/releases/
  service: http://127.0.0.1:3103
- hostname: superset-app.tom-nguyen.dev      # catch-all, must come AFTER
  service: http://127.0.0.1:3100
```

cloudflared takes the first matching ingress rule, so the order is
load-bearing: put the path rule below the catch-all and `/releases/*` quietly
becomes a Next.js 404.

Directory layout of `~/superset-releases` (populated by the release runbook,
`.agents/skills/desktop-release-local/SKILL.md`):

```
latest-mac.yml                       # the feed: version, zip name, sha512, releaseDate
Superset-<ver>-arm64-mac.zip         # what the updater downloads (sha512 in the yml)
Superset-<ver>-arm64-mac.zip.blockmap# differential-download map; optional but keep it
Superset-arm64.dmg                   # stable-named copy of Superset-<ver>-arm64.dmg
                                     # for the web "Download for Mac" button
```

Older zips can stay (the yml only points at one), but the `.dmg` stable name
is overwritten on every cut. The updater compares the yml's `version` against
the running app's — same `package.json` version, no update offered, however
many times you re-cut.

The web download button reads its URL at **build** time from
`packages/shared/src/constants.ts`:

```
NEXT_PUBLIC_DOWNLOAD_URL_MAC_ARM64=https://superset-app.tom-nguyen.dev/releases/Superset-arm64.dmg
```

It is in `deploy/env.production.template`; adding it to a live `.env` does
nothing until `apps/web` is rebuilt (`deploy/deploy.sh` with no argument, or
push any change under `apps/web/`).

Verify:

```bash
launchctl list | grep superset.releases
curl -sI http://127.0.0.1:3103/releases/latest-mac.yml          # 200
curl -s  https://superset-app.tom-nguyen.dev/releases/latest-mac.yml
curl -sI https://superset-app.tom-nguyen.dev/releases/Superset-arm64.dmg   # 200, content-length ≈ 200 MB
```
