# ms1 backing-services operating notes

Companion to `docker-compose.prod.yml`. Three topics: Postgres backup, why
Redis has no volume, and the Docker Desktop setting the stack depends on to
return after a reboot.

---

## 1. Postgres backup

The named volume `superset_db_data_prod` is the **only** copy of every account,
organization and workspace record. On macOS this volume does not live on the Mac
filesystem at all — Docker Desktop keeps it inside its Linux VM disk image
(`~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw`). Time
Machine backs that file up only as an opaque multi-gigabyte blob, and "Reset to
factory defaults" or a Docker Desktop reinstall destroys it outright. A logical
`pg_dump` is what actually makes this recoverable.

Run the dump **inside** the container, so `pg_dump` is always the same major
version as the server (`postgres:17`) and no host libpq is involved:

```bash
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" superset-postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges \
  > /Users/USERNAME/superset/backups/superset-$(date +%Y%m%d-%H%M%S).dump
```

`pg-backup.sh` in this directory wraps that with the parts that matter in
practice: it sources `.env.docker` for the credentials, writes to a `.partial`
name and only renames on a clean exit (so a dump truncated by a mid-run reboot
is never mistaken for a good backup), `chmod 600`s the result, and prunes dumps
older than 14 days.

Install it — it resolves `.env.docker` and the backup directory relative to its own
location (`<clone>/deploy`), so normally there is nothing to edit; export
`ENV_FILE` / `BACKUP_DIR` if the layout differs:

```bash
chmod +x /Users/USERNAME/superset/deploy/pg-backup.sh
crontab -e
```

```cron
# Superset Postgres dump, nightly at 03:20 local time.
20 3 * * * /Users/USERNAME/superset/deploy/pg-backup.sh >> /Users/USERNAME/superset/backups/backup.log 2>&1
```

Restore into an empty database:

```bash
docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" superset-postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  < /Users/USERNAME/superset/backups/superset-YYYYMMDD-HHMMSS.dump
```

Three macOS-specific caveats:

- **cron does not run while the Mac is asleep, and missed jobs are not
  replayed.** In System Settings → Battery / Energy Saver, enable "Prevent
  automatic sleeping when the display is off" (and keep the lid open or the Mac
  on power with clamshell handled). Otherwise you will discover the gap only
  when you need a restore.
- **Full Disk Access.** `cron` on modern macOS is sandboxed by TCC. Add
  `/usr/sbin/cron` under System Settings → Privacy & Security → Full Disk
  Access, or the job fails writing into the backup directory. Verify by reading
  `backup.log` the morning after you install it — do not assume it ran.
- **Get a copy off the machine.** These dumps sit on the same disk as the
  database. Sync `~/superset/backups` to another host or object store; three
  organizations depend on this single MacBook.

---

## 2. Redis deliberately has no volume

This is intentional and should not be "fixed" during a later hardening pass.

Redis backs the API only: `packages/auth` rate limiting, the `/mcp`,
automation-webhook and support-lookup routes, and the
`/api/hosts/jobs/sync-presence` job (which reads an always-empty directory now
and skips itself). **The relay no longer touches Redis.** Until 2026-09-01 the
relay kept its host directory there (`relay:tunnel-owner`, `relay:tunnel-meta`,
`relay:tunnel-ttl` from the old `apps/relay/src/directory.ts`) — TTL-scoped
presence data, a live view of open WebSocket connections. That module is gone:
the relay now speaks tunnel v2 with an in-memory `HostRegistry` as the single
presence authority (`apps/relay/README.md`), which is why a single-instance
self-host never needed a shared directory in the first place.

Persisting Redis would still be pointless for what remains (rate-limit
counters, short-lived webhook state), so the prod file keeps the repo's "no
volume" decision and goes one step further with
`command: ["redis-server", "--save", "", "--appendonly", "no"]`, disabling RDB
snapshots and AOF so Redis does not write persistence files into the
container's writable layer either.

Restarting Redis no longer affects host presence — the relay does not consult
it. It only resets the API's rate-limit counters. `serverless-redis-http` sits
in front of it and depends on it, so restart the pair together.

---

## 3. Docker Desktop must start at login

`restart: unless-stopped` only means "the Docker daemon will restart these
containers when it comes up." On macOS there is no system-level Docker service —
the daemon runs inside a Linux VM that only exists while **Docker Desktop.app**
is running. If Docker Desktop is not launched, nothing restarts and the tunnel
serves 502s.

Enable it: Docker Desktop → Settings (gear) → General → check **"Start Docker
Desktop when you sign in to your computer"** → Apply & restart.

The gotcha, and it is the important one for a headless MacBook: that setting is
a **login item**, not a boot service. It fires when a user account signs in, not
when the machine powers on. After an unattended reboot — power cut, macOS
update, kernel panic — ms1 will sit at the login window with Docker, and
therefore the entire stack, down until somebody physically logs in.

To make an unattended reboot actually recover, you need all three:

1. **FileVault off.** With FileVault on, the disk cannot unlock without someone
   typing a password at the pre-boot screen, so automatic login is impossible.
   This is a real security trade-off on a machine serving three organizations —
   the disk is unencrypted at rest. Accept it deliberately or plan on manual
   recovery after reboots.
2. **Automatic login on.** System Settings → Users & Groups → Automatically log
   in as → the service account. Only selectable once FileVault is off.
3. **Docker Desktop's start-at-login checkbox**, above.

Also set System Settings → Energy Saver → **"Start up automatically after a
power failure"** so the Mac powers itself back on at all.

Two smaller notes:

- `unless-stopped` respects an explicit stop. If you `docker compose stop` a
  service, it stays down across reboots until you `start` it again. That is the
  intended semantics, but it does mean a container you stopped for debugging
  three weeks ago will not quietly come back.
- The apps (`apps/api`, `apps/web`, `apps/relay`) run natively under Bun and are
  **not** covered by any of this. Docker Desktop's setting only brings back the
  four backing services. The apps — and the compose stack itself — are supervised
  by the launchd agents in `deploy/launchd/`, which is also where the auto-login /
  FileVault / `pmset autorestart 1` requirements above are set up.
- **Who owns the stack once launchd is installed.** The agent
  `dev.tom-nguyen.superset.stack` runs
  `docker compose -p superset -f deploy/docker-compose.prod.yml --env-file deploy/.env.docker up`
  *attached* (no `-d`) with `KeepAlive=true`. So `docker compose stop` no longer
  keeps a service down: launchd's compose process notices, exits, and is
  respawned, bringing it back. To stop the stack for debugging, boot the agent
  out first — `launchctl bootout gui/$(id -u)/dev.tom-nguyen.superset.stack` —
  then use compose directly.

---

## Verifying the stack after a reboot

The two HTTP shims have no container healthcheck — I could not confirm those
images ship `curl`/`wget`, which any in-container probe would need — so probe
them from the host. These are the same probes `.superset/setup.local.sh` uses:

```bash
docker compose -p superset -f docker-compose.prod.yml --env-file .env.docker ps

# neon-proxy serving SQL (expects a JSON body containing "command")
curl -s -X POST "http://127.0.0.1:4444/sql" \
  -H "Neon-Connection-String: postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db.localtest.me:4444/main" \
  -H "Content-Type: application/json" \
  -d '{"query":"select 1","params":[]}'

# SRH answering commands (expects PONG). The Content-Type header is required —
# SRH rejects the request without it.
curl -s -X POST "http://127.0.0.1:8079/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SRH_TOKEN" \
  -d '["PING"]'
```

Confirm nothing is exposed beyond loopback — every line should show
`127.0.0.1`, never `0.0.0.0` or `*`:

```bash
docker compose -p superset -f docker-compose.prod.yml --env-file .env.docker ps --format '{{.Name}}\t{{.Ports}}'
```
