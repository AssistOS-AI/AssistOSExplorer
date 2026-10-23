# QA userPersistoAgent role grant: design (read-only exploration)

Source: `userPersistoAgent/` at `4b5e38ac` (origin/main). Observed: `git diff --stat 4b5e38ac HEAD -- userPersistoAgent tests/smoke` is empty, so local HEAD `f8c930d6` has identical files. All paths below are relative to `userPersistoAgent/` unless noted.

## 1. Store

Observed:
- Embedded Persisto, wrapped by `lib/durable-storage.mjs`. The folder is `PERSISTENCE_FOLDER`, default `/data/persisto` (`manifest.json:68-70`, `scripts/start.sh:4`). The manifest volume is `.data/userPersistoAgent` -> `/data` (`manifest.json:13-15`), not `/root`. The host path is `<workspace>/.data/userPersistoAgent/persisto`.
- Format: a single plaintext JSON file `.userpersisto.snapshot.json` = `{version:1, sha256, payload}`, where `payload` is the JSON string of all objects (`durable-storage.mjs:9,182-186,244`). It is not encrypted, but it is checksummed, and a bad checksum makes startup fail (`:183-185`). Saves write a 0600 temp file, fsync, `rename` over the snapshot, then fsync the directory (`:241-253`).
- Single writer: the lock is `.userpersisto.writer.json`, created with `open(...,'wx',0o600)` (`:139`). It holds pid, hostname, token and `PLOINKY_AGENT_INSTANCE_ID`/`ENABLE_GENERATION` (`:38-46`). A second process is refused with `persistence_locked` unless the old owner is proven dead (same hostname and `kill(pid,0)` gives ESRCH) or has a different instance and generation (`:80-96`). Every save re-reads the lock and aborts if it was replaced (`:236`).
- Cache: yes. The whole snapshot is loaded into the in-memory `objects` map at startup (`:179-190`). Reads are served from memory (`:211-215`). Each save writes the in-memory state back (`:240`).

Inferred:
- A second process (`podman exec`) cannot open the store while the agent runs. In the same container, the live pid is not dead, so it is refused. The refusal path does not delete the live lock (`:146-149`; `release` only unlinks a lock whose content equals its own owner, `:153`).
- Editing or replacing the snapshot file while the agent runs does not work. The agent will not see the change, and its next save overwrites it. So a restart-bracketed offline write is the only in-process-code path.

## 2. setUserRoles and role semantics

Observed (`lib/users.mjs`):
- `setUserRoles(userId, roleNames, {actorId='system', audit=true, save=true})` (`:288,323`) runs under `serialize('users')`.
- It requires an existing user id of the form `USER.<id>` (`USER_ID_RE`, `:7,71-75`). An email is rejected.
- Semantics are replace: the account ends up with exactly the given roles (`:303-317`). New links are added first, then obsolete ones are deleted. An empty array gives `roles_required` (`:294`), and an unknown name gives `unknown_role` (`:300`).
- It refuses to demote the last active admin (`:296`, `assertAnotherActiveAdmin`).
- It writes an audit event `user.roles.update` with `actorId`, target and the roles (`:318`, `lib/audit.mjs`). `actorId` is just a string. There is no actor check in `setUserRoles`; the admin check lives in the caller (`tools/registry.mjs:90-92`, `requireAdmin` at `:16-20`).
- It flushes a snapshot (`:319`).
- It does not bump `authGeneration`. Sessions stay valid, and roles are read live at each `sso-user` call (`lib/sso.mjs:96-108,144-152`). The new role should apply without re-login, subject to Router caching, which I did not inspect.
- Lookup by email: `getUserByEmail(email)` (`:62-67`) returns the user, with `.id`. Emails are stored lowercase.
- Built-in roles are `admin`, `user` and `selfRegistered` (`lib/bootstrap.mjs:6-10`).
- Capability `explorer.access` is granted to roles `admin` and `user` only, and only when the `explorer` profile env is active (`manifest.json:133-139`, `lib/product-permissions.mjs:2`). `selfRegistered` has only `selfregistered.dashboard.access` (`bootstrap.mjs:16`). Signup assigns exactly `selfRegistered` (`lib/policy.mjs:108-110`).
- Smoke: `SMOKE_USERNAME` defaults to `admin` and `SMOKE_SECONDARY_USERNAME` to `user` (`tests/smoke/lib/config.mjs:77-86`). The README says setup "verifies the configured administrator and a distinct ordinary user" (`tests/smoke/README.md:132`). Spec 30 requires two distinct configured accounts (`README.md:682`).

Unknown / not verified:
- Whether Marketplace enable needs the `admin` role. The marketplace modal passes `isAdmin: true` (`explorer/IDE-plugins/marketplace/components/marketplace-modal/marketplace-modal.js:338`), but I did not trace the server-side check.
- Whether QA actually runs the `explorer` profile. Confirm in the read-back below.

Inference: for spec 30, give both accounts `['user']`. Give an account `['admin']` only if the Marketplace test must run as that account. `admin` also carries `explorer.access`. `['user']` replaces `selfRegistered` and drops its dashboard capability; use `['selfRegistered','user']` to keep it.

## 3. Recommended procedure (offline, via the agent's own modules)

Preferred, no server work: the existing QA admin edits roles in the My Account Users dashboard, which calls the same `setUserRoles` (`service/index.mjs:221-224`). Use the steps below only if that is not possible.

Pitfalls: a live `podman exec` run fails with `persistence_locked`. `ploinky stop` stops all agents and the router (`ploinky/docs/ploinky-overview.md:28`). I found no documented per-agent stop; `ploinky restart AGENT` exists (`:25`). Verify each step on the host first; these are not tested.

Step 0, discover (read-only), on the host as admin:
```
cd /home/admin/explorerQaWorkspace && ploinky status
podman ps --format '{{.Names}}'            # run inside the Box
podman inspect <ctr> --format '{{json .Mounts}} {{.HostConfig.UsernsMode}} {{json .Config.Env}}' | head
ls -la .data/userPersistoAgent/persisto
```
Confirm that the volume maps to `/data`, that the folder holds `.userpersisto.snapshot.json`, and whether the owner is a subuid. If it is not readable by `admin`, run the commands below through `podman unshare`, or inside the Box or container, so ownership is preserved.

Step 1, backup (agent may be running; the snapshot is replaced atomically, so a copy is a consistent file):
```
TS=$(date -u +%Y%m%dT%H%M%SZ); B=/home/admin/.qa-deployment-backups/userpersisto-$TS
mkdir -p "$B" && chmod 700 "$B"
cp -a /home/admin/explorerQaWorkspace/.data/userPersistoAgent/persisto "$B/persisto"   # use `podman unshare cp -a` if owners are subuids
( cd "$B/persisto" && sha256sum .userpersisto.snapshot.json > ../SHA256SUMS && cat ../SHA256SUMS )
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(require("crypto").createHash("sha256").update(s.payload).digest("hex")===s.sha256)' "$B/persisto/.userpersisto.snapshot.json"   # expect true
```
Keep the backup outside the persisto folder (a legacy-store scan reads that folder if the snapshot is missing, `durable-storage.mjs:195`). Do not copy the writer lock into a restore.

Step 2, stop the agent. Use `ploinky stop` only if stopping the whole QA workspace is acceptable. Otherwise stop only the userPersisto container (`podman stop <ctr>`) and confirm the lock file is gone (clean shutdown unlinks it, `:153,268`). Expect the watchdog or Ploinky to restart it, so verify that the container stays stopped. If it restarts, stop here and use the dashboard path.

Step 3, run the script in a one-off container with the same image, same `/data` mount, same code mount at `/code`, and the same uid mapping as the agent. Set `PERSISTENCE_FOLDER=/data/persisto`, and keep the Ploinky instance env, or the lock logic cannot recognise a prior owner (`:86-95`). Save the script as `/tmp/grant.mjs` (host side, not in the data dir):
```js
import { getUserByEmail, getUserRoles, setUserRoles } from '/code/lib/users.mjs';
import { getUserCapabilities } from '/code/lib/authorization.mjs';
import { flush } from '/code/lib/store.mjs';
const grants = JSON.parse(process.env.GRANTS); // {"a@qa.test":["user"],"b@qa.test":["user"]}
for (const [email, roles] of Object.entries(grants)) {
    const user = await getUserByEmail(email);
    if (!user) throw new Error(`no user ${email}`);
    console.log(email, user.id, 'before', await getUserRoles(user.id));
    await setUserRoles(user.id, roles, { actorId: 'system:qa-role-grant-2026-10-19' });
    console.log(email, 'after', await getUserRoles(user.id), 'caps', await getUserCapabilities(user.id));
}
await flush();
process.exit(0);
```
Run it with `PERSISTENCE_FOLDER=/data/persisto GRANTS='{...}' node /tmp/grant.mjs`. The first store use opens the folder, takes the lock, and writes the snapshot. The `exit` handler releases the lock (`:166`).

Step 4, start with `ploinky restart userPersistoAgent` (or start the container). Then read back through a fresh process: the agent's logs, and the dashboard Users page or an `sso-user` check. Expect `roles:["user"]` and `explorer.access` in the capabilities.

Rollback: stop the agent, then `cp -a "$B/persisto/.userpersisto.snapshot.json"` over the live snapshot, remove a stale `.userpersisto.writer.json` only if the agent is stopped, verify the checksum, and start. This also drops any sign-ups made after the backup. The lower-impact logical rollback is `setUserRoles(id, ['selfRegistered'])` via the same script, which is audited.
