# SSM Tunnels

A macOS menu-bar app and a command-line tool for AWS SSM port-forwarding tunnels: save your tunnels once, then connect with a click or one command instead of typing `aws ssm start-session ...` every time.

> Early version, macOS only. Unofficial: not affiliated with or endorsed by Amazon Web Services. "AWS" and "Systems Manager" belong to their owners.

**What it does**

- Saves tunnels (bastion instance, remote host and port, local port) and connects or disconnects each one with a click or `ssm-tunnels up <name>`.
- Shows what is running, including sessions you started yourself in a terminal.
- Auto-connect: chosen tunnels connect when the app starts (also at login) and reconnect when they drop.
- Tunnels that keep failing are archived after 7 days and deleted 7 days later, unless you restore them.
- One event log shared by the app and the CLI, with a Logs screen grouped by tunnel.

Under the hood every tunnel is `aws ssm start-session --document-name AWS-StartPortForwardingSessionToRemoteHost`.

---

## Install

### Requirements

- macOS on Apple silicon, Node 22.
- AWS CLI v2 (looked up at `/opt/homebrew/bin/aws`, then `/usr/local/bin/aws`, then `PATH`) and `session-manager-plugin`.
- Working AWS credentials. The app does not read your shell profile, so a variable such as `AWS_PROFILE` set only in `~/.zshrc` is not seen when the app is opened from Finder or at login. Use the default profile or `~/.aws/config` instead.

Check your setup:

```
aws --version
session-manager-plugin --version
aws sts get-caller-identity      # should print your identity, not an error
```

### Install the app

```
git clone https://github.com/kyorilys/ssm-tunnel-manager.git
cd ssm-tunnel-manager
npm install
npm run package
ditto "dist/SSM Tunnels-darwin-arm64/SSM Tunnels.app" "$HOME/Applications/SSM Tunnels.app"
open "$HOME/Applications/SSM Tunnels.app"
```

The build is unsigned. It runs on the Mac that built it; copying it to another Mac needs signing or a Gatekeeper exception. To update later, `git pull`, quit the app, and run the last three commands again.

### Install the CLI

From the project folder:

```
npm link                 # makes `ssm-tunnels` available in every terminal
ssm-tunnels --help
```

`npm unlink -g ssm-tunnel-manager` removes it again. Without linking you can run `node bin/ssm-tunnels.js <command>`.

---

## Quick start

1. **Open the app.** On first run it offers to import tunnels from an `ssm-connect`-style script (see [Data](#data)). Otherwise click **+** (New Tunnel).
2. **Connect** with the switch on a tunnel's row. When it turns green the tunnel is up.
3. **Use it**: click the port on the left of the row to copy `localhost:<port>`, then point your database client or `redis-cli` at it.
4. **Make it automatic**: click **Auto** on the row. It now connects whenever the app starts, including at login, and reconnects when it drops.

Closing the window keeps the app running in the menu bar. Quit with ⌘Q or the tray icon's right-click menu. A closed window is released from memory (about 100 MB) and rebuilt when you open it again, so it starts fresh; the menu bar popover stays loaded so it opens instantly. Tunnels are not affected either way.

---

## Using the app

### Main window

| Area | What it shows or does |
|---|---|
| **Sidebar** | Views: All Tunnels, Connected, Needs Attention; filters by Environment (Production, Staging, Other) and by Bastion; Activity > Logs. At the bottom: Archived (N) and Settings. |
| **Toolbar** | Search (name, host, port); **Connect All…** connects the idle tunnels in the current view and lists any it skips because the local port is taken; **Disconnect All** stops every SSM port-forward session you own, including ones started in a terminal; **+** adds a tunnel. |
| **Production banner** | Appears while any production tunnel is connected, with Show and Disconnect Production. It is informational: production tunnels connect like any other. |

### A tunnel row

- **Port** on the left: click to copy `localhost:<port>`.
- **Name**, a PROD badge for production, and the type (PostgreSQL, Redis, Valkey, ...).
- **State**: connecting, connected (with PID and uptime), retrying (countdown and attempt number), stopped after 5 attempts (with Retry), failed (with the AWS error), or a **Terminal** badge when the session was started outside the app.
- **Auto** button and the on/off **switch**.
- **⋯ menu**: Connect/Disconnect, Auto-connect, copy `localhost:<port>`, copy the equivalent command, Edit…, Duplicate…, Delete.

Sessions found in `ps` that match no saved tunnel are listed as "Running in Terminal, not saved", with **Save as Tunnel** and **Stop**.

### Add or edit a tunnel

Click **+**, or Edit… in a row's menu. Fields: Name, Environment, Description, AWS profile, Bastion instance (Region and Instance ID), Remote host, Remote port, and Local port. The form shows **Command the app will run**, warns when the local port is already used by another tunnel, and suggests a free one. The environment is guessed from the name (`-stg` is Staging, `-prod` is Production) and can be changed. **AWS profile** is "Default profile" unless you pick one; a tunnel with its own profile shows it as a small chip on the row.

### AWS sign-in

The app uses the same credentials as the `aws` command (`~/.aws/config` and `~/.aws/credentials`). Open **AWS Profiles** from the AWS line at the bottom of the sidebar or from Settings.

- **Each profile** shows its type (SSO or access keys), region, how many tunnels use it, and whether it works: "Signed in as …" with the account number shortened to its last four digits, or what is wrong. **Test** checks it again.
- **When an SSO login expires**, the tunnels that use it pause ("Waiting for sign-in", no retries used up, not counted toward archiving) and a blue banner appears. Click **Sign In**, approve in the browser window that opens, and the paused tunnels reconnect on their own. Profiles on the same SSO session share one sign-in.
- **SSO Profile…** adds an SSO profile (start URL, SSO region, account ID, role, default region) and shows exactly what will be written to `~/.aws/config`. Nothing secret is stored for SSO.
- **Access Keys…** adds an IAM user's key ID and secret to `~/.aws/credentials`, readable only by you. The secret is never logged and never shown again. Prefer SSO when your organisation offers it.
- **Edit** saves over the same profile; **Remove** warns you about the tunnels that use it and never switches them to another profile.
- Before any change, the app keeps a dated copy of the file it edits (`~/.aws/config.ssm-tunnels-backup-…`, the newest five).
- With no credentials at all, the app offers **Set up AWS access** with both options.

### Auto-connect, retries and archiving

- **Auto tunnels** connect at launch and are retried when they drop: up to 5 times, after 2, 4, 8, 16 and 32 seconds. After that they show "Stopped after 5 attempts" and wait for you to click Retry. Waking the Mac retries tunnels that are still retrying.
- **Non-Auto tunnels** are never retried; a failure shows the error on the row.
- **Archiving**: a tunnel that keeps failing for 7 days is archived (hidden, never auto-connected) and deleted permanently 7 days later. Restore it from **Archived** before then to keep it. Time does not count when every tunnel is failing or the error points at expired credentials or no network, so a week away does not wipe your list.

### Logs screen

Activity > **Logs** in the sidebar. Entries are grouped by tunnel (General for app-wide events), with search and filters for level, source (app or CLI) and time range. **Live** refreshes every 2 seconds; **Open Log File** shows it in Finder; **Copy Visible** copies what is on screen.

### Menu bar

- **Click the tray icon** (or press ⌃⌥T anywhere) for a popover with your tunnels, Disconnect, Disconnect All and Open SSM Tunnels.
- **Right-click** for Open SSM Tunnels, Settings… and Quit.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| Open at login | on | Start the app when you log in (packaged app only). |
| Auto-archive tunnels that keep failing | 7 days | 0 means never. |
| Delete archived after | 7 days | Permanent; 0 means never. |
| Disconnect tunnels when quitting | on | Off leaves the app's tunnels running after quit; the next launch picks them up. |

### Keyboard shortcuts

| Action | Keys |
|---|---|
| New tunnel | ⌘N |
| Search | ⌘F |
| Select previous / next | ↑ ↓ |
| Connect / disconnect selected | Space |
| Toggle Auto-connect | ⌥⌘A |
| Retry now | ⌘R |
| Edit selected | ⌘I or ↩ |
| Duplicate | ⌘D |
| Copy `localhost:port` | ⌘C |
| Delete (undo in the toast) | ⌘⌫ |
| Connect All… / Disconnect All | ⇧⌘K / ⌥⇧⌘K |
| Settings | ⌘, |
| Menu bar popover (anywhere) | ⌃⌥T |
| Close sheet or popover | Esc |

---

## Using the CLI

`ssm-tunnels` works on the same saved tunnels and the same log as the app. You can use it with or without the app running.

### Everyday use

```
ssm-tunnels list                     # saved tunnels: env, ports, Auto, active/idle
ssm-tunnels status                   # what is running now, saved or not
ssm-tunnels up glacier-stg-redis         # start one (several names, --auto, or all also work)
ssm-tunnels down glacier-stg-redis       # stop it
ssm-tunnels logs -n 20               # recent events from the app and the CLI
```

`up` starts `aws` in the background and returns. It skips tunnels that are already running, refuses archived ones, and stops with an error if the local port is taken. Run `status` a moment later to confirm.

### Manage saved tunnels

```
ssm-tunnels add onyx-db --region us-west-2 --target i-0357e26df0d26b2ae \
  --host onyx-db.c1500bcaaf2.us-west-2.rds.amazonaws.com --port 5432 --local 15002 \
  --desc "Onyx DB" --env production
ssm-tunnels edit onyx-db --local 15010 --auto     # change fields; --no-auto turns Auto off
ssm-tunnels edit onyx-db --name onyx-db-2       # rename
ssm-tunnels edit onyx-db --profile prod-sso       # use an AWS profile for this tunnel
ssm-tunnels edit onyx-db --default-profile        # back to the default profile
ssm-tunnels remove onyx-db
ssm-tunnels archived                                # archived tunnels and days until deletion
ssm-tunnels restore onyx-db
ssm-tunnels import ~/bin/ssm-connect                # one-time import from a bash script
```

`add` and `edit` use the same rules as the app: valid name, region and instance ID, a host made of letters, digits and `. _ : -`, a free name, and a warning when the local port is used by another tunnel.

### Logs

```
ssm-tunnels logs --tunnel onyx-db       # one tunnel
ssm-tunnels logs --level error --since 24h
ssm-tunnels logs --source cli             # only what the CLI did
ssm-tunnels logs -f                       # follow live; Ctrl-C to stop
```

### How the CLI and the app work together

- Changes made with the CLI appear in an open app within a few seconds; no restart needed.
- A tunnel started with `up` shows in the app with the **Terminal** badge.
- `down` and `kill` record the stop, so a running app does not reconnect or take over the tunnel.
- Removing or renaming a tunnel that the app is running stops that session, as deleting it in the app does.
- Tunnels added with the CLI are not connected automatically until you connect them or turn on Auto.
- The CLI never reconnects anything itself. Only the app retries dropped Auto tunnels, and only while it is running.

### Be careful with

- `ssm-tunnels kill` stops **every** SSM port-forward session you own, production included.
- `ssm-tunnels down all` stops every saved tunnel that is running, production included.

### Scripting

`list`, `status`, `archived` and `logs` accept `--json`. Exit codes: 0 success, 1 operation failed, 2 bad usage. Colour is used only on a terminal and is off when `NO_COLOR` is set.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| Tunnel fails right away | The error on the row or in Logs. `aws sts get-caller-identity` shows whether your AWS login works. |
| Works in a terminal, fails in the app | Credentials or profile set only in your shell (see Requirements). |
| Every tunnel is failing | Usually expired AWS login or no network. This time does not count toward auto-archive. |
| Tunnels show "Waiting for sign-in" | The SSO login for their profile expired. Click **Sign In** in the banner (or run `aws sso login --profile <name>`); they reconnect on their own. |
| A profile shows "Invalid" | The access key was deactivated or rotated. Open AWS Profiles, Edit the profile and enter the new key. |
| "Port … already in use" | Another tunnel or app holds the local port. `ssm-tunnels status` shows SSM sessions; change the tunnel's local port if it is another app. |
| Log mentions an outdated SessionManagerPlugin | AWS prints this at the start of each session when the plugin is old. It is not the cause of a failure; upgrade the plugin to silence it. |
| App does not start at login | System Settings > General > Login Items should list SSM Tunnels. Only the packaged app registers. |

---

## Reference

### Data

Everything is stored in `~/Library/Application Support/SSM Tunnels/connections.json` (set `SSM_TUNNELS_DATA` to use another file):

```json
{
  "version": 1,
  "settings": {
    "openAtLogin": true, "archiveDays": 7, "purgeDays": 7,
    "stopOnQuit": true, "importedFrom": null
  },
  "tunnels": [{
    "name": "example-db", "region": "eu-west-1", "target": "i-0357e26df0d26b2ae",
    "host": "db.internal", "port": 5432, "local": 5432, "desc": "",
    "env": "staging", "auto": false, "archived": false,
    "profile": "", "failingMs": 0, "archivedAt": null, "lastError": null, "stopRequestedAt": null
  }]
}
```

- Writes are atomic (temp file, then rename). An unreadable file is renamed to `connections.json.corrupt-<timestamp>` and the app starts empty.
- On load, a row that breaks the add/edit rules (bad port, unsafe host, invalid or duplicate name) is set aside: hidden and never connected, but kept in the file.
- The app checks the file for outside changes every few seconds and before each of its own edits, and never overwrites a change made by the CLI.
- First-run import reads the script named by `SSM_CONNECT_PATH`, or an `ssm-connect` found on `PATH` when the app is launched from a terminal. That file is only read.
- Duplicate local ports (for example two SSH tunnels on :443) are allowed with a warning; only one of them can run at a time.
- `stopRequestedAt` is written by `ssm-tunnels down`/`kill` so a running app treats the stop as intended.
- The name `all` is reserved for the CLI.

### Behaviour details

- At launch the app scans `ps` first and skips Auto tunnels that are already running.
- A session that stays up 10 seconds resets the retry count and the failure clock.
- Only sessions owned by the current macOS user are listed, matched or stopped.
- Stopping kills the `aws` process together with its `session-manager-plugin` child; killing only `aws` would leave the plugin holding the port.
- Quitting with "Disconnect tunnels when quitting" sends SIGTERM to each tunnel the app started, waits up to 3 seconds, then SIGKILL. Terminal sessions are never touched. `kill <pid>` or Ctrl-C on the app quits the same way as ⌘Q.
- Each tunnel's stderr goes to `~/Library/Application Support/SSM Tunnels/sessions/<name>.stderr`, so a session left running after quit is not affected by the app exiting.
- Open at login works only in the packaged app; under `npm start` the setting is saved but not registered.

### Event log

`~/Library/Logs/SSM Tunnels/events.log` (set `SSM_TUNNELS_LOG` to use another file):

- One JSON object per line: `t` (ISO 8601), `source` (`app` or `cli`), `level`, `tunnel` (name or `null`), `event`, `message`, plus fields such as `pid`, `attempt`, `delayMs`, `local`.
- State changes only (connect, session ended, reconnect scheduled, gave up, disconnect, archive/purge, add/edit/remove/restore/import, settings, app start/quit), not every poll.
- Rotates at 1 MiB, keeping `events.log.1` to `.5`.
- Never contains `aws` command lines, plugin arguments, session tokens or access keys; messages are redacted and capped at 500 characters. Logging failures never affect the app or the CLI.

### Limitations

- macOS on Apple silicon only; the process scan and kill rely on `ps` and process groups.
- "Connected" is shown as soon as the `aws` process starts; there is no readiness check. A failing session flips to retrying within seconds.
- A local port held by a non-SSM app is detected, but the app does not show which process holds it.
- ⌘C copies `localhost:port` only when no text is selected and no field is focused.
- Tested against real AWS: CLI `up`/`down` with a database reachable through the tunnel, connect/disconnect from the UI, auto-connect and auto-reconnect, quitting with no leftover plugin, and the packaged app registering as a login item. Not yet tested: an actual log-out/log-in launch.

---

## Development

```
npm install
npm start                          # run from source
npm test                           # unit tests, no AWS calls
npm run package                    # build the .app into dist/
node scripts/make-tray-icons.js    # regenerate tray icons
```

Quit the installed app before `npm start`: both use the same data folder and only one instance runs at a time.

| Path | Purpose |
|---|---|
| `main.js` | Electron main process: tray, window, global shortcut, login item |
| `preload.js` | Context bridge between renderer and main |
| `lib/controller.js` | Ties store, manager, scan and archive together; polling, hourly tick, settings |
| `lib/tunnelManager.js` | Spawns `aws`, retry/backoff, wake handling, shutdown |
| `lib/archive.js` | Failure clocks, auto-archive and purge |
| `lib/store.js` | `connections.json` load/save, import |
| `lib/validate.js` | Field rules and environment guess; shared constants used by app, CLI and renderer |
| `lib/scan.js` | `ps` parsing, session matching, port check, killing sessions |
| `lib/cli.js`, `bin/ssm-tunnels.js` | Command-line tool |
| `lib/logger.js` | Shared event log, rotation and redaction |
| `lib/awsProfiles.js`, `lib/awsAuth.js` | Read and edit `~/.aws` profiles (with backups); login status and SSO sign-in through the `aws` CLI |
| `lib/ipc.js`, `lib/env.js` | IPC handlers; `PATH`, `aws` lookup, spawning, tool versions |
| `renderer/` | Window and popover UI |
| `test/` | Unit tests (`node --test`) |
| `design/` | Mockups, reference only |

## License

MIT. See [LICENSE](LICENSE).
