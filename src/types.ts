/**
 * Core type definitions for the S3 Sync plugin.
 */

// ─── Plugin Settings ───────────────────────────────────────────────

export interface S3SyncSettings {
	/** S3-compatible endpoint URL (e.g., https://s3.amazonaws.com, https://minio.example.com) */
	endpoint: string;
	/** S3 bucket name */
	bucket: string;
	/** AWS region (ignored by some S3-compatible providers but required by AWS SDK) */
	region: string;
	/** Access key ID */
	accessKeyId: string;
	/** Secret access key */
	secretAccessKey: string;
	/** Path prefix inside the bucket (e.g., "my-vault/" — sync only this subtree) */
	prefix: string;
	/** Use path-style addressing (true for MinIO, R2 without custom domain; false for AWS S3) */
	forcePathStyle: boolean;
	/** Conflict resolution strategy */
	conflictStrategy: ConflictStrategy;
	/** Auto-sync interval in seconds (0 = disabled) */
	autoSyncInterval: number;
	/** Whether to sync immediately on file save */
	syncOnSave: boolean;
	/** Whether to perform a full sync when the plugin starts */
	syncOnStartup: boolean;
	/** Glob patterns to exclude from sync */
	excludePatterns: string[];
	/** Maximum number of sync log entries to retain */
	maxLogEntries: number;
}

export const DEFAULT_SETTINGS: S3SyncSettings = {
	endpoint: "",
	bucket: "",
	region: "us-east-1",
	accessKeyId: "",
	secretAccessKey: "",
	prefix: "",
	forcePathStyle: true,
	conflictStrategy: "ask",
	autoSyncInterval: 60,
	syncOnSave: true,
	/** Whether to perform a full sync when the plugin starts */
	syncOnStartup: true,
	excludePatterns: [
		".obsidian/**",
		".trash/**",
		".DS_Store",
		"**/.DS_Store",
	],
	maxLogEntries: 200,
};

// ─── Conflict Resolution ───────────────────────────────────────────

/**
 * Strategies for resolving sync conflicts:
 * - `ask`: Show a dialog and let the user decide per-conflict
 * - `local-wins`: Always overwrite remote with local version
 * - `remote-wins`: Always overwrite local with remote version
 * - `keep-both`: Keep local file, save remote as "filename (conflict date).ext"
 * - `newer-wins`: Use modification time — whichever is newer wins
 */
export type ConflictStrategy = "ask" | "local-wins" | "remote-wins" | "keep-both" | "newer-wins";

export interface ConflictEntry {
	/** Path relative to vault root */
	path: string;
	/** S3 key (includes prefix) */
	s3Key: string;
	/** Local modification timestamp */
	localMtime: number;
	/** Remote last-modified timestamp */
	remoteMtime: number;
	/** Local content hash (SHA-256 hex) */
	localHash: string;
	/** Remote ETag */
	remoteETag: string;
	/** The hash that was common to both at last sync (the "ancestor") */
	lastSyncedHash: string;
}

export type ConflictResolution =
	| { action: "use-local" }
	| { action: "use-remote" }
	| { action: "keep-both" }
	| { action: "skip" };

// ─── Sync Metadata (persisted per-file state) ──────────────────────

export interface FileSyncMetadata {
	/** Vault-relative path */
	path: string;
	/** SHA-256 hash of the file content at the time of last successful sync */
	lastSyncedHash: string;
	/** S3 ETag after last successful sync */
	remoteETag: string;
	/** S3 VersionId after last successful sync (only if bucket versioning is enabled) */
	remoteVersionId?: string;
	/** Timestamp (ms) of last successful sync for this file */
	lastSyncedAt: number;
	/** File size in bytes at last sync */
	lastSize: number;
}

export interface SyncMetadataStore {
	/** Map of vault-relative path → sync metadata */
	files: Record<string, FileSyncMetadata>;
	/** Timestamp of last full sync (ms) */
	lastFullSync: number;
}

// ─── Sync Status ────────────────────────────────────────────────────

export type SyncStatus = "idle" | "syncing" | "synced" | "error";

export type LogLevel = "info" | "success" | "error" | "conflict";

export interface SyncLogEntry {
	timestamp: number;
	level: LogLevel;
	message: string;
	path?: string;
}

// ─── Sync Result ────────────────────────────────────────────────────

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: ConflictEntry[];
	errors: string[];
}

// ─── S3 Object Info ─────────────────────────────────────────────────

export interface S3ObjectInfo {
	key: string;
	etag: string;
	versionId?: string;
	lastModified: Date;
	size: number;
}
