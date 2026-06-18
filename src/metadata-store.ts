/**
 * Persistent metadata store for sync state tracking.
 *
 * This is the foundation of **collision detection**.  For every synced file
 * we store three key values:
 *
 *   lastSyncedHash  — SHA-256 of the file content at the moment of the last
 *                     successful sync (the "common ancestor").
 *   remoteETag      — S3 ETag of the object after the last successful sync.
 *   lastSyncedAt    — timestamp
 *
 * When deciding whether a collision exists:
 *   - local changed?   → current-hash ≠ lastSyncedHash
 *   - remote changed?  → current-ETag  ≠ remoteETag
 *   - BOTH changed?    → COLLISION
 */

import type { FileSyncMetadata, SyncMetadataStore } from "./types";

const STORE_FILENAME = "sync-metadata.json";

export class MetadataStore {
	private store: SyncMetadataStore;
	private basePath: string;

	constructor(vaultDataDir: string) {
		this.basePath = vaultDataDir;
		this.store = { files: {}, lastFullSync: 0 };
	}

	/** Load persisted metadata from disk. Must be called after construction. */
	async load(adapter: { read: (path: string) => Promise<string>; exists: (path: string) => Promise<boolean> }): Promise<void> {
		const filePath = this.getStorePath();
		try {
			if (await adapter.exists(filePath)) {
				const raw = await adapter.read(filePath);
				const parsed = JSON.parse(raw) as SyncMetadataStore;
				// Ensure the expected shape
				this.store = {
					files: parsed.files ?? {},
					lastFullSync: parsed.lastFullSync ?? 0,
				};
			}
		} catch (err) {
			console.warn("[S3-Sync] Failed to load metadata store, starting fresh:", err);
			this.store = { files: {}, lastFullSync: 0 };
		}
	}

	/** Persist the in-memory store to disk. */
	async save(adapter: { write: (path: string, data: string) => Promise<void> }): Promise<void> {
		const filePath = this.getStorePath();
		await adapter.write(filePath, JSON.stringify(this.store, null, 2));
	}

	// ─── CRUD ────────────────────────────────────────────────────

	get(path: string): FileSyncMetadata | undefined {
		return this.store.files[path];
	}

	set(path: string, meta: FileSyncMetadata): void {
		this.store.files[path] = meta;
	}

	delete(path: string): void {
		delete this.store.files[path];
	}

	/** Remove metadata for files whose vault paths start with `prefix`. */
	deleteByPrefix(prefix: string): void {
		for (const key of Object.keys(this.store.files)) {
			if (key.startsWith(prefix)) {
				delete this.store.files[key];
			}
		}
	}

	/** Bulk-upsert after a sync completes. */
	upsertBatch(entries: FileSyncMetadata[]): void {
		for (const entry of entries) {
			this.store.files[entry.path] = entry;
		}
	}

	/** Purge metadata for vault paths NOT in the given set. */
	pruneStale(knownPaths: Set<string>): void {
		for (const key of Object.keys(this.store.files)) {
			if (!knownPaths.has(key)) {
				delete this.store.files[key];
			}
		}
	}

	// ─── Accessors ───────────────────────────────────────────────

	get allFiles(): Record<string, FileSyncMetadata> {
		return this.store.files;
	}

	get lastFullSync(): number {
		return this.store.lastFullSync;
	}

	set lastFullSync(ts: number) {
		this.store.lastFullSync = ts;
	}

	/** Number of tracked files. */
	get fileCount(): number {
		return Object.keys(this.store.files).length;
	}

	/** Clear all metadata (useful on full re-sync). */
	clearAll(): void {
		this.store.files = {};
		this.store.lastFullSync = 0;
	}

	// ─── Internal ────────────────────────────────────────────────

	private getStorePath(): string {
		return `${this.basePath}/${STORE_FILENAME}`;
	}
}
