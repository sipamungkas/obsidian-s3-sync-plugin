# S3 Sync — Obsidian Plugin

Sync your Obsidian vault to **any S3-compatible object storage** (AWS S3, MinIO, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi, etc.) with three-way collision detection and interactive conflict resolution.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Commands](#commands)
6. [Sync Flow & Collision Detection](#sync-flow--collision-detection)
7. [Conflict Resolution](#conflict-resolution)
8. [Metadata Store](#metadata-store)
9. [Architecture](#architecture)
10. [Development & Testing](#development--testing)
11. [Provider Configuration](#provider-configuration)

---

## Features

| Category | Details |
|----------|---------|
| **Sync modes** | Full bidirectional, push-only, pull-only |
| **Collision detection** | Three-way comparison: `localHash` vs `remoteETag` vs `lastSyncedHash` |
| **Conflict strategies** | Ask (interactive), local-wins, remote-wins, keep-both, newer-wins |
| **Auto-sync** | Configurable interval (every N seconds) |
| **Sync on save** | Debounced (2s) upload on each save |
| **File watching** | Monitors create, modify, delete, rename events |
| **Exclusion** | Glob patterns (e.g., `.obsidian/**`, `.trash/**`, `.DS_Store`) |
| **Multi-provider** | Any S3-compatible API (AWS S3, MinIO, R2, B2, DO Spaces, etc.) |
| **Versioned buckets** | Tracks S3 `VersionId` for buckets with versioning enabled |
| **Atomic writes** | Uses `If-Match` header for conditional PUT where supported |
| **Status bar** | Clickable indicator showing sync state + time since last sync |
| **Sync log** | Scrollable modal with refresh/clear |
| **Connection test** | Button in settings to verify S3 connectivity |

---

## Quick Start

```bash
# 1. Install dependencies & build
cd s3-sync
npm install
npm run build

# 2. Copy to your vault
cp main.js manifest.json styles.css \
   "<your-vault>/.obsidian/plugins/s3-sync/"

# 3. Restart Obsidian or reload plugins
# 4. Settings → Community Plugins → enable "S3 Sync"
# 5. Settings → S3 Sync → configure your S3 endpoint + credentials
```

---

## Installation

### From source

```bash
git clone <repo-url> obsidian-s3-sync
cd obsidian-s3-sync
npm install
npm run build
```

Then copy the three output files (`main.js`, `manifest.json`, `styles.css`) into your vault at `<vault>/.obsidian/plugins/s3-sync/`.

### Plugin directory structure (inside your vault)

```
.vault/
└── .obsidian/
    └── plugins/
        └── s3-sync/
            ├── main.js          # Bundled plugin (~298 KB)
            ├── manifest.json    # Plugin metadata
            └── styles.css       # UI styles
```

The plugin also creates a `sync-metadata.json` in the plugin's data directory to track per-file sync state (see [Metadata Store](#metadata-store)).

---

## Configuration

All settings are in **Settings → Community Plugins → S3 Sync** (gear icon next to the plugin name).

### Connection

| Setting | Type | Description |
|---------|------|-------------|
| **Endpoint URL** | `string` | S3-compatible endpoint. Leave empty for AWS S3. For self-hosted MinIO: `https://minio.example.com`. For Cloudflare R2: `https://<account-id>.r2.cloudflarestorage.com`. |
| **Bucket** | `string` | Your S3 bucket name. |
| **Region** | `string` | AWS region for the bucket (e.g., `us-east-1`, `eu-west-1`). For non-AWS providers this can be any value (required by the SDK). |
| **Access Key ID** | `string` | Your S3 access key. |
| **Secret Access Key** | `password` | Your S3 secret key (masked in UI). |
| **Force path-style** | `boolean` | **ON** for MinIO, R2, B2, self-hosted. **OFF** for AWS S3 (virtual-hosted style). |
| **Test Connection** | button | Verifies the plugin can list objects in the configured bucket. |

### Sync

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Path prefix** | `string` | `""` | Subfolder inside the bucket to sync (e.g., `my-vault/`). Only objects under this prefix are considered. Useful for syncing multiple vaults to one bucket. |
| **Conflict strategy** | `enum` | `ask` | How to resolve when both local and remote have changed. See [Conflict Resolution](#conflict-resolution). |
| **Auto-sync interval** | `number` | `0` | Seconds between automatic full-syncs. `0` = disabled. |
| **Sync on save** | `boolean` | `true` | Upload the file to S3 immediately after each save (debounced 2 seconds). |

### Exclude

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Exclude patterns** | `textarea` | `.obsidian/**`<br>`.trash/**`<br>`.DS_Store`<br>`**/.DS_Store` | Glob patterns, one per line. Supports `*` (match within segment), `**` (match across directories), `?` (single char). |

### Advanced

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Max log entries** | `number` | `200` | Maximum number of sync log entries kept in memory. |
| **Clear sync metadata** | button (danger) | — | Resets all sync state. The next sync treats every file as new and compares by modification time — **this may cause conflicts**. |

---

## Commands

All commands are available via the command palette (`Cmd+P` / `Ctrl+P`):

### `S3 Sync: Full sync`

Bidirectional sync with full collision detection:

1. Scan all local files (respecting exclude patterns)
2. List all remote objects under the configured prefix
3. Detect collisions on files existing on both sides
4. Apply conflict resolution strategy
5. Upload new local files
6. Download new remote files
7. Sync changed files in both directions
8. Prune stale metadata entries
9. Update `lastFullSync` timestamp

### `S3 Sync: Push local changes`

Upload-only. For each locally changed file:

1. HEAD the remote object to get its current ETag
2. Compare against stored metadata for collision
3. Upload if safe; flag as conflict if both changed

### `S3 Sync: Pull remote changes`

Download-only. For each remote object:

1. Hash the local file (if it exists)
2. Compare against stored metadata for collision
3. Download if safe; flag as conflict if both changed

### `S3 Sync: Show sync log`

Opens a scrollable modal showing recent sync activity. Each entry is color-coded:

- 🟢 Green — successful operations
- 🟠 Orange — conflicts detected
- 🔴 Red — errors
- ⚪ Grey — informational messages

Buttons: **Refresh** (re-reads the log) and **Clear Log**.

### `S3 Sync: Clear sync metadata`

Resets all stored sync state. The next sync will do a full comparison — every file that exists on both sides and differs will be treated as a push or pull (not a collision, since there's no common ancestor to compare against after the reset).

---

## Sync Flow & Collision Detection

### The Three-Way Comparison

For every file that has been synced at least once, the plugin stores three values in `sync-metadata.json`:

```
┌─────────────────────────────────────────────────┐
│  Sync Metadata for "notes/todo.md"              │
│                                                 │
│  lastSyncedHash = "a1b2c3d4..."                 │
│  remoteETag     = "x9y8z7w6..."                 │
│  lastSyncedAt   = 1718755200000                  │
└─────────────────────────────────────────────────┘
```

These represent the **common ancestor** — the state of the file at the moment of the last successful sync.

When a sync runs:

```
         ┌──────────┐
         │ Common   │
         │ Ancestor │  (lastSyncedHash == remoteETag equivalent)
         └────┬─────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
┌─────────┐       ┌─────────┐
│ LOCAL   │       │ REMOTE  │
│ current │       │ current │
│ hash    │       │ ETag    │
└────┬────┘       └────┬────┘
     │                 │
     ▼                 ▼
localChanged?    remoteChanged?
(localHash ≠     (remoteETag ≠
 lastSyncedHash)  storedETag)
```

### Decision Matrix

| Local | Remote | Decision |
|-------|--------|----------|
| Unchanged | Unchanged | **Skip** — nothing to do |
| **Changed** | Unchanged | **Push** — upload local to remote |
| Unchanged | **Changed** | **Pull** — download remote to local |
| **Changed** | **Changed** | **⚠ COLLISION** — apply conflict resolution strategy |
| New (local only) | — | **Upload** — new local file |
| — | New (remote only) | **Download** — new remote file |
| Deleted | Exists | **Pull** — restore from remote |
| Exists | Deleted | **Push** — re-upload to remote |

### Edge Cases Handled

- **First-time sync**: No metadata exists. Files existing on both sides are hashed and compared. If content differs, the **newer mtime** wins by default (no collision — no common ancestor exists).
- **Concurrent saves on same device**: Debounced (2s window). Rapid successive saves only trigger the last upload.
- **File renames**: The old path's remote object is deleted and the new path is uploaded. Metadata follows the new path.
- **File deletions**: Remote object is deleted. If the remote had changed since last sync, the delete still proceeds (local intent wins for deletions).
- **Large vaults**: Remote listing paginates at 1000 objects per request. Local scanning is recursive.

---

## Conflict Resolution

When both local and remote have diverged from the common ancestor, the plugin applies your chosen strategy:

### `ask` (default)

An interactive modal opens for **each** conflict:

```
┌──────────────────────────────────────────┐
│  Sync Conflict Detected                  │
│                                          │
│  File: notes/example.md                  │
│                                          │
│  Both the local and remote versions have │
│  changed since the last sync.            │
│                                          │
│  📄 Local:  modified 6/18/2026, 7:30 PM │
│     (hash: a1b2c3d4e5f6…)               │
│  ☁️ Remote: modified 6/18/2026, 6:45 PM │
│     (ETag: x9y8z7w6v5u…)                │
│                                          │
│  [ 📄 Use Local (overwrite remote) ]     │
│  [ ☁️ Use Remote (overwrite local) ]     │
│  [ 📋 Keep Both (save conflict copy) ]   │
│  [ ⏭️ Skip (resolve later) ]            │
└──────────────────────────────────────────┘
```

### `local-wins`

Every conflict is resolved by uploading the local version. Remote changes are overwritten. Use this when you always edit on one device.

### `remote-wins`

Every conflict is resolved by downloading the remote version. Local changes are overwritten. Use this when you treat S3 as the source of truth.

### `keep-both`

The local file stays as-is. The remote version is downloaded to a timestamped copy:

```
notes/example.md                         # ← local (unchanged)
notes/example (conflict 2026-06-18T19-30-00).md  # ← remote version
```

The local file is then uploaded to keep the remote in sync going forward. No data is lost.

### `newer-wins`

Compares `localMtime` (local modification time) against `remoteMtime` (S3 `LastModified`). The newer timestamp wins. If timestamps are equal, local wins.

> **Note on mtime accuracy**: Obsidian's vault adapter doesn't expose file modification times, so local mtime is approximated as the current time at scan. For collision resolution, `newer-wins` is most accurate when the conflict is detected during a real-time event (sync-on-save) rather than a full scan.

---

## Metadata Store

The plugin persists sync state in `sync-metadata.json` (stored in the plugin's data directory, e.g., `.obsidian/plugins/s3-sync/` inside your vault).

### Schema

```json
{
  "files": {
    "notes/welcome.md": {
      "path": "notes/welcome.md",
      "lastSyncedHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "remoteETag": "d41d8cd98f00b204e9800998ecf8427e",
      "remoteVersionId": "null",
      "lastSyncedAt": 1718755200000,
      "lastSize": 256
    }
  },
  "lastFullSync": 1718755200000
}
```

### Operations

| Operation | Description |
|-----------|-------------|
| `get(path)` | Look up metadata for one file |
| `set(path, meta)` | Store/update metadata |
| `delete(path)` | Remove metadata (file deleted) |
| `upsertBatch(entries)` | Bulk update after sync |
| `pruneStale(knownPaths)` | Remove entries for files that no longer exist |
| `clearAll()` | Reset all state (danger zone button) |

### Lifecycle

```
sync starts
  │
  ├─ load()          ← read from disk
  ├─ (during sync)   ← set/delete/upsertBatch called
  ├─ save()          ← persist to disk
  └─ sync ends
```

---

## Architecture

### Source Layout

```
s3-sync/
├── main.ts                 # Plugin entry point
│   ├── onload()            # Register commands, watchers, auto-sync timer
│   ├── onunload()          # Cleanup timers
│   ├── loadSettings()      # Load from Obsidian data.json
│   └── saveSettings()      # Persist + reconfigure S3 client
│
├── src/
│   ├── types.ts            # All TypeScript interfaces & constants
│   │   ├── S3SyncSettings  # Plugin settings shape
│   │   ├── ConflictEntry   # Collision data passed to resolver
│   │   ├── FileSyncMetadata# Per-file sync state
│   │   └── SyncResult      # Returned by all sync operations
│   │
│   ├── s3-client.ts        # S3Client class
│   │   ├── testConnection()# HEAD-like ping
│   │   ├── listAllObjects()# Paginated LIST with prefix filter
│   │   ├── headObject()    # Metadata-only fetch
│   │   ├── getObject()     # Full download → Uint8Array
│   │   ├── putObject()     # Upload with optional If-Match
│   │   ├── deleteObject()  # Remote deletion
│   │   ├── vaultPathToKey()# Path → S3 key (prefix joining)
│   │   └── keyToVaultPath()# S3 key → Path (prefix stripping)
│   │
│   ├── sync-engine.ts      # SyncEngine class
│   │   ├── fullSync()      # Bidirectional: detect → resolve → push → pull
│   │   ├── pushOnly()      # Upload-only with collision detection
│   │   ├── pullOnly()      # Download-only with collision detection
│   │   ├── uploadFile()    # Read → hash → PUT → store metadata
│   │   ├── downloadFile()  # GET → write → hash → store metadata
│   │   ├── detectCollisions() # Core 3-way comparison loop
│   │   ├── applyResolutions() # Execute resolved conflicts
│   │   └── scanLocalFiles()   # Recursive vault walk (glob-aware)
│   │
│   ├── metadata-store.ts   # MetadataStore class
│   │   ├── load() / save() # JSON file persistence
│   │   ├── get() / set() / delete()
│   │   ├── upsertBatch()   # Bulk update
│   │   ├── pruneStale()    # Remove deleted-file entries
│   │   └── clearAll()      # Full reset
│   │
│   ├── conflict-resolver.ts# Resolution engine & UI
│   │   ├── resolveConflicts()   # Dispatch by strategy
│   │   └── ConflictResolutionModal  # Per-conflict interactive dialog
│   │
│   ├── settings.ts         # S3SyncSettingTab (Obsidian SettingTab)
│   │   └── display()       # Renders connection, sync, exclude, danger sections
│   │
│   └── status-bar.ts       # SyncStatusBar
│       ├── setStatus()     # idle | syncing | synced | error
│       └── onClick()       # Click triggers full sync
│
├── styles.css              # Plugin UI styles
├── manifest.json           # Obsidian plugin manifest
├── package.json            # Dependencies & build scripts
├── esbuild.config.mjs      # Bundler config (target: es2020 for BigInt)
└── tsconfig.json           # TypeScript config
```

### Dependency Graph

```
main.ts
  ├── S3Client          (s3-client.ts)
  ├── MetadataStore     (metadata-store.ts)
  ├── SyncEngine        (sync-engine.ts)
  │     ├── S3Client
  │     ├── MetadataStore
  │     └── resolveConflicts (conflict-resolver.ts)
  ├── SyncStatusBar     (status-bar.ts)
  └── S3SyncSettingTab  (settings.ts)

External:
  └── @aws-sdk/client-s3   (bundled by esbuild)
```

### Data Flow (Full Sync)

```
┌──────────┐    ┌──────────┐    ┌───────────┐
│  Vault   │    │  Sync    │    │    S3     │
│ (local)  │    │  Engine  │    │ (remote)  │
└────┬─────┘    └────┬─────┘    └─────┬─────┘
     │               │               │
     │ scanLocalFiles│               │
     │──────────────►│               │
     │               │ listAllObjects│
     │               │──────────────►│
     │               │◄──────────────│
     │               │               │
     │               │ detectCollisions (compare hashes vs ETags vs stored metadata)
     │               │               │
     │               │ resolveConflicts (apply strategy)
     │               │               │
     │               │ uploadFile ───► (PUT)
     │               │               │
     │               │ downloadFile ◄─ (GET)
     │◄──────────────│               │
     │               │               │
     │               │ save metadata │
     │               │──────────────►│ (to vault disk)
     │               │               │
```

---

## Development & Testing

### Build

```bash
cd s3-sync
npm install          # Install dependencies
npm run dev          # Watch mode — rebuilds on file changes
npm run build        # Production build (minified)
```

### Test with the dev vault

A local dev vault is set up at:

```
obsidian-plugin/s3-sync-dev-vault/
```

It already has the plugin installed. To test:

```bash
# 1. Rebuild after changes
cd s3-sync && npm run build

# 2. Copy the build output to the dev vault
cp main.js manifest.json styles.css \
   ../s3-sync-dev-vault/.obsidian/plugins/s3-sync/

# 3. Open the dev vault in Obsidian
open "obsidian://open?path=$(cd ../s3-sync-dev-vault && pwd)"
```

Or **open Obsidian → Open folder as vault → select `s3-sync-dev-vault`**.

### Development workflow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Edit .ts   │────►│  npm run     │────►│  Copy to    │
│  source     │     │  build       │     │  dev vault  │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                                                ▼
                   ┌──────────────┐     ┌─────────────┐
                   │  Make code   │◄────│  Reload     │
                   │  changes     │     │  plugins     │
                   └──────────────┘     └─────────────┘
```

To reload the plugin in Obsidian without restarting:
- **Cmd+Shift+P** → "Reload plugins" (or use the Hot Reload plugin)
- Or close and reopen the settings window

### Debugging

The plugin logs to the Obsidian developer console:

1. **Cmd+Shift+I** (Mac) or **Ctrl+Shift+I** (Windows/Linux) opens DevTools
2. Filter for `[S3-Sync]` to see plugin logs
3. All sync operations, errors, and collision detections are logged

---

## Provider Configuration

### Amazon S3

```
Endpoint URL:     (leave empty)
Bucket:           my-obsidian-vault
Region:           us-east-1
Access Key ID:    AKIAIOSFODNN7EXAMPLE
Secret Key:       wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Force path-style: OFF
```

### Cloudflare R2

```
Endpoint URL:     https://<account-id>.r2.cloudflarestorage.com
Bucket:           my-obsidian-vault
Region:           auto
Access Key ID:    <R2 access key>
Secret Key:       <R2 secret key>
Force path-style: ON
```

### MinIO (self-hosted)

```
Endpoint URL:     https://minio.example.com
                   or http://localhost:9000
Bucket:           obsidian
Region:           us-east-1
Access Key ID:    minioadmin
Secret Key:       minioadmin
Force path-style: ON
```

### Backblaze B2

```
Endpoint URL:     https://s3.us-west-004.backblazeb2.com
Bucket:           my-obsidian-vault
Region:           us-west-004
Access Key ID:    <B2 application key ID>
Secret Key:       <B2 application key>
Force path-style: ON
```

### DigitalOcean Spaces

```
Endpoint URL:     https://nyc3.digitaloceanspaces.com
Bucket:           my-obsidian-vault
Region:           nyc3
Access Key ID:    <DO Spaces access key>
Secret Key:       <DO Spaces secret key>
Force path-style: ON
```

### Testing locally with MinIO (Docker)

```bash
# Start MinIO
docker run -d --name minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"

# Create a bucket (via MinIO console at http://localhost:9001)
# Then configure the plugin:
#   Endpoint:    http://localhost:9000
#   Bucket:      obsidian
#   Region:      us-east-1
#   Access Key:  minioadmin
#   Secret Key:  minioadmin
#   Path-style:  ON
```

---

## Privacy & Security

- **Credentials** are stored in Obsidian's `data.json` inside your vault (`.obsidian/plugins/s3-sync/data.json`). They are **not** encrypted at rest. Consider using vault encryption if this is a concern.
- **Sync metadata** (`sync-metadata.json`) contains file paths and content hashes — no actual file content.
- **Network traffic** goes exclusively to your configured S3 endpoint. HTTPS is recommended.
- **Secret key** is masked in the settings UI (`type="password"`).

---

## License

MIT
