/**
 * Core sync engine with three-way collision detection.
 *
 * ## Collision Detection Algorithm
 *
 * We track, per file, three values:
 *   lastSyncedHash  — SHA-256 of the file when it was last in sync
 *   remoteETag      — S3 ETag when it was last in sync
 *   lastSyncedAt    — timestamp of the last successful sync
 *
 * A **collision** is when BOTH conditions are true:
 *   1. currentLocalHash ≠ lastSyncedHash    (local changed)
 *   2. currentRemoteETag ≠ remoteETag       (remote changed)
 *
 * This is the classic three-way-merge ancestor check: both sides diverged
 * from the common ancestor independently.
 *
 * ## Push Safety
 *
 * Before uploading we HEAD the remote object.  If its ETag differs from
 * our stored remoteETag but the local file has also changed → collision.
 * If the local file is unchanged but remote changed → we pull instead.
 *
 * ## Pull Safety
 *
 * Before downloading we hash the local file.  If the hash differs from
 * lastSyncedHash AND the remote ETag differs from storedETag → collision.
 */

import type { App } from "obsidian";
import { S3Client } from "./s3-client";
import { MetadataStore } from "./metadata-store";
import { resolveConflicts } from "./conflict-resolver";
import type {
	S3SyncSettings,
	SyncResult,
	ConflictEntry,
	ConflictResolution,
	SyncLogEntry,
	LogLevel,
	S3ObjectInfo,
} from "./types";

// ─── Hashing ─────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of content.
 * Uses the Web Crypto API (available in Obsidian's Electron/Chromium runtime).
 */
async function sha256(data: Uint8Array | string): Promise<string> {
	let buffer: Uint8Array;
	if (typeof data === "string") {
		buffer = new Uint8Array(new TextEncoder().encode(data));
	} else {
		buffer = new Uint8Array(data);
	}
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer as BufferSource);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Glob Matching ───────────────────────────────────────────────────

function matchesAnyGlob(path: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (globToRegex(pattern).test(path)) return true;
	}
	return false;
}

function globToRegex(pattern: string): RegExp {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				// ** — match any number of directories
				regex += ".*";
				i += 2;
				if (pattern[i] === "/") i++;
			} else {
				// * — match anything except /
				regex += "[^/]*";
				i++;
			}
		} else if (ch === "?") {
			regex += "[^/]";
			i++;
		} else if (
			ch === "." || ch === "(" || ch === ")" || ch === "+" ||
			ch === "^" || ch === "$" || ch === "|" || ch === "{" ||
			ch === "}" || ch === "[" || ch === "]"
		) {
			regex += "\\" + ch;
			i++;
		} else {
			regex += ch;
			i++;
		}
	}
	return new RegExp("^" + regex + "$");
}

// ─── Content Type Detection ──────────────────────────────────────────

function getContentType(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "md": return "text/markdown";
		case "mdx": return "text/markdown";
		case "txt": return "text/plain";
		case "json": return "application/json";
		case "yaml": case "yml": return "application/yaml";
		case "css": return "text/css";
		case "js": return "application/javascript";
		case "ts": return "application/typescript";
		case "html": return "text/html";
		case "svg": return "image/svg+xml";
		case "png": return "image/png";
		case "jpg": case "jpeg": return "image/jpeg";
		case "gif": return "image/gif";
		case "webp": return "image/webp";
		case "pdf": return "application/pdf";
		case "mp3": return "audio/mpeg";
		case "mp4": return "video/mp4";
		case "canvas": return "application/json";
		default: return "application/octet-stream";
	}
}

// ─── Sync Engine ─────────────────────────────────────────────────────

export class SyncEngine {
	private app: App;
	private s3: S3Client;
	private meta: MetadataStore;
	private settings: S3SyncSettings;
	private adapter: {
		read: (path: string) => Promise<string>;
		readBinary: (path: string) => Promise<ArrayBuffer>;
		write: (path: string, data: string) => Promise<void>;
		writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
		exists: (path: string) => Promise<boolean>;
		remove: (path: string) => Promise<void>;
		list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
	};
	private logs: SyncLogEntry[] = [];
	private isRunning = false;
	private status: "idle" | "syncing" | "synced" | "error" = "idle";
	private onStatusChange?: (status: string) => void;

	constructor(
		app: App,
		s3Client: S3Client,
		metadataStore: MetadataStore,
		settings: S3SyncSettings
	) {
		this.app = app;
		this.s3 = s3Client;
		this.meta = metadataStore;
		this.settings = settings;
		this.adapter = app.vault.adapter as any;
	}

	setOnStatusChange(cb: (status: string) => void): void {
		this.onStatusChange = cb;
	}

	getStatus(): string {
		return this.status;
	}

	getLogs(): SyncLogEntry[] {
		return this.logs;
	}

	// ─── Public API ───────────────────────────────────────────────

	/** Full bidirectional sync with collision detection. */
	async fullSync(): Promise<SyncResult> {
		if (this.isRunning) {
			this.addLog("info", "Sync already in progress, skipping.");
			return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], errors: [] };
		}

		this.isRunning = true;
		this.setStatus("syncing");
		const startTime = Date.now();

		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
		};

		try {
			// 1. Discover local files
			const localFiles = await this.scanLocalFiles();
			const localMap = new Map(localFiles.map((f) => [f.path, f]));

			// 2. Discover remote objects
			const remoteObjects = await this.s3.listAllObjects();
			const remoteMap = new Map(
				remoteObjects.map((o) => [this.s3.keyToVaultPath(o.key), o])
			);

			// 3. Detect collisions before any mutation
			const conflicts = await this.detectCollisions(localMap, remoteMap);
			result.conflicts = conflicts;

			// 4. Resolve conflicts
			if (conflicts.length > 0) {
				this.addLog("conflict", `${conflicts.length} conflict(s) detected.`);
				const resolutions = await resolveConflicts(
					this.app,
					conflicts,
					this.settings.conflictStrategy
				);
				await this.applyResolutions(resolutions, conflicts, result);
			}

			// 5. Push local-new files (exists locally, not remotely)
			const toUpload = localFiles.filter(
				(f) => !remoteMap.has(f.path) && !isConflictPath(conflicts, f.path)
			);
			for (const file of toUpload) {
				try {
					await this.uploadFile(file.path);
					result.uploaded++;
					this.addLog("success", `Uploaded (new): ${file.path}`, file.path);
				} catch (err: any) {
					result.errors.push(`Upload failed: ${file.path} — ${err.message}`);
					this.addLog("error", `Upload failed: ${file.path}`, file.path);
				}
			}

			// 6. Pull remote-new objects (exists remotely, not locally)
			const toDownload = remoteObjects
				.map((o) => this.s3.keyToVaultPath(o.key))
				.filter(
					(vaultPath) =>
						!localMap.has(vaultPath) &&
						!isConflictPath(conflicts, vaultPath)
				);
			for (const vaultPath of toDownload) {
				try {
					await this.downloadFile(vaultPath);
					result.downloaded++;
					this.addLog("success", `Downloaded (new): ${vaultPath}`, vaultPath);
				} catch (err: any) {
					result.errors.push(`Download failed: ${vaultPath} — ${err.message}`);
					this.addLog("error", `Download failed: ${vaultPath}`, vaultPath);
				}
			}

			// 7. Sync existing files (both sides, no conflict)
			const allPaths = new Set([...localMap.keys(), ...remoteMap.keys()]);
			for (const path of allPaths) {
				const local = localMap.get(path);
				const remote = remoteMap.get(path);
				if (!local || !remote) continue;
				if (isConflictPath(conflicts, path)) continue;

				const localHash = await this.hashLocalFile(path);
				const stored = this.meta.get(path);

				if (localHash !== stored?.lastSyncedHash) {
					try {
						await this.uploadFile(path);
						result.uploaded++;
						this.addLog("success", `Pushed: ${path}`, path);
					} catch (err: any) {
						result.errors.push(`Push failed: ${path} — ${err.message}`);
					}
				} else if (remote.etag !== stored?.remoteETag) {
					try {
						await this.downloadFile(path);
						result.downloaded++;
						this.addLog("success", `Pulled: ${path}`, path);
					} catch (err: any) {
						result.errors.push(`Pull failed: ${path} — ${err.message}`);
					}
				}
			}

			// 8. Prune stale metadata
			const knownPaths = new Set(localFiles.map((f) => f.path));
			this.meta.pruneStale(knownPaths);

			// 9. Save metadata
			this.meta.lastFullSync = Date.now();
			await this.meta.save(this.app.vault.adapter as any);

			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			this.addLog(
				"info",
				`Sync complete in ${elapsed}s — ↑${result.uploaded} ↓${result.downloaded} ✕${result.deleted} ⚠${result.conflicts.length}`
			);

			this.setStatus("synced");
		} catch (err: any) {
			this.addLog("error", `Sync failed: ${err.message}`);
			this.setStatus("error");
			result.errors.push(`Sync failed: ${err.message}`);
		} finally {
			this.isRunning = false;
		}

		return result;
	}

	/** Push-only: upload local changes without pulling. */
	async pushOnly(): Promise<SyncResult> {
		const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], errors: [] };
		this.setStatus("syncing");

		try {
			const localFiles = await this.scanLocalFiles();
			for (const file of localFiles) {
				const localHash = await this.hashLocalFile(file.path);
				const stored = this.meta.get(file.path);
				const head = await this.s3.headObject(file.path);
				const remoteETag = head ? (head.ETag ?? "").replace(/^"|"$/g, "") : "";

				if (
					stored &&
					localHash !== stored.lastSyncedHash &&
					remoteETag &&
					remoteETag !== stored.remoteETag
				) {
					const conflict: ConflictEntry = {
						path: file.path,
						s3Key: this.s3.vaultPathToKey(file.path),
						localMtime: file.mtime,
						remoteMtime: head?.LastModified?.getTime() ?? 0,
						localHash,
						remoteETag,
						lastSyncedHash: stored.lastSyncedHash,
					};
					result.conflicts.push(conflict);
					continue;
				}

				if (!stored || localHash !== stored.lastSyncedHash) {
					await this.uploadFile(file.path);
					result.uploaded++;
				}
			}

			this.setStatus("synced");
		} catch (err: any) {
			result.errors.push(err.message);
			this.setStatus("error");
		}

		return result;
	}

	/** Pull-only: download remote changes without pushing. */
	async pullOnly(): Promise<SyncResult> {
		const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], errors: [] };
		this.setStatus("syncing");

		try {
			const localMap = new Map(
				(await this.scanLocalFiles()).map((f) => [f.path, f])
			);
			const remoteObjects = await this.s3.listAllObjects();

			for (const obj of remoteObjects) {
				const vaultPath = this.s3.keyToVaultPath(obj.key);
				const localFile = localMap.get(vaultPath);
				const localHash = localFile ? await this.hashLocalFile(vaultPath) : "";
				const stored = this.meta.get(vaultPath);

				if (
					stored &&
					localHash &&
					localHash !== stored.lastSyncedHash &&
					obj.etag !== stored.remoteETag
				) {
					const conflict: ConflictEntry = {
						path: vaultPath,
						s3Key: obj.key,
						localMtime: localFile?.mtime ?? 0,
						remoteMtime: obj.lastModified.getTime(),
						localHash,
						remoteETag: obj.etag,
						lastSyncedHash: stored.lastSyncedHash,
					};
					result.conflicts.push(conflict);
					continue;
				}

				if (!stored || obj.etag !== stored.remoteETag) {
					await this.downloadFile(vaultPath);
					result.downloaded++;
				}
			}

			this.setStatus("synced");
		} catch (err: any) {
			result.errors.push(err.message);
			this.setStatus("error");
		}

		return result;
	}

	// ─── Core File Operations ─────────────────────────────────────

	/** Upload a single file to S3 and update metadata. */
	async uploadFile(vaultPath: string): Promise<void> {
		const fileData = await this.adapter.readBinary(vaultPath);
		const body = new Uint8Array(fileData);
		const hash = await sha256(body);
		const contentType = getContentType(vaultPath);

		const result = await this.s3.putObject(vaultPath, body, contentType);

		this.meta.set(vaultPath, {
			path: vaultPath,
			lastSyncedHash: hash,
			remoteETag: result.etag,
			remoteVersionId: result.versionId,
			lastSyncedAt: Date.now(),
			lastSize: body.byteLength,
		});

		await this.meta.save(this.app.vault.adapter as any);
	}

	/** Download a single file from S3 and update metadata. */
	async downloadFile(vaultPath: string): Promise<void> {
		const result = await this.s3.getObject(vaultPath);
		if (!result) return;

		// Ensure parent directory exists
		const parts = vaultPath.split("/");
		if (parts.length > 1) {
			await this.ensureDir(parts.slice(0, -1).join("/"));
		}

		await this.adapter.writeBinary(vaultPath, result.body.buffer as ArrayBuffer);
		const hash = await sha256(result.body);

		this.meta.set(vaultPath, {
			path: vaultPath,
			lastSyncedHash: hash,
			remoteETag: result.etag,
			remoteVersionId: result.versionId,
			lastSyncedAt: Date.now(),
			lastSize: result.body.byteLength,
		});

		await this.meta.save(this.app.vault.adapter as any);
	}

	/** Delete a local file (called when syncing a remote deletion). */
	async deleteLocalFile(vaultPath: string): Promise<void> {
		if (await this.adapter.exists(vaultPath)) {
			await this.adapter.remove(vaultPath);
		}
		this.meta.delete(vaultPath);
		await this.meta.save(this.app.vault.adapter as any);
	}

	/** Delete a remote object (called when syncing a local deletion). */
	async deleteRemoteFile(vaultPath: string): Promise<void> {
		try {
			await this.s3.deleteObject(vaultPath);
		} catch (err: any) {
			if (err.name !== "NoSuchKey" && err.name !== "NotFound") {
				throw err;
			}
		}
		this.meta.delete(vaultPath);
		await this.meta.save(this.app.vault.adapter as any);
	}

	/**
	 * Smart per-file bidirectional sync.
	 *
	 * Called automatically whenever a file is created or modified.
	 * Performs a three-way comparison for this single file:
	 *   1. Hash the local file
	 *   2. HEAD the remote object for its ETag
	 *   3. Compare both against stored metadata
	 *   4. Push, pull, or detect collision
	 *
	 * This is the core of "automatic sync" — no manual trigger needed.
	 *
	 * Returns what action was taken.
	 */
	async smartSyncFile(vaultPath: string): Promise<{
		action: "push" | "pull" | "conflict" | "skip" | "new-upload" | "error";
		detail?: string;
	}> {
		// Skip excluded files
		if (matchesAnyGlob(vaultPath, this.settings.excludePatterns)) {
			return { action: "skip", detail: "excluded" };
		}

		// Check local exists
		const localExists = await this.adapter.exists(vaultPath);
		if (!localExists) {
			return { action: "skip", detail: "local file missing" };
		}

		try {
			const localHash = await this.hashLocalFile(vaultPath);
			const stored = this.meta.get(vaultPath);

			// HEAD remote for current ETag
			const head = await this.s3.headObject(vaultPath);
			const remoteETag = head ? (head.ETag ?? "").replace(/^"|"$/g, "") : "";

			// Case 1: New file (never synced) → upload
			if (!stored) {
				await this.uploadFile(vaultPath);
				this.addLog("success", `Auto-uploaded (new): ${vaultPath}`, vaultPath);
				return { action: "new-upload" };
			}

			const localChanged = localHash !== stored.lastSyncedHash;
			const remoteChanged = remoteETag !== "" && remoteETag !== stored.remoteETag;

			// Case 2: Neither changed → nothing to do
			if (!localChanged && !remoteChanged) {
				return { action: "skip", detail: "both unchanged" };
			}

			// Case 3: Only local changed → push
			if (localChanged && !remoteChanged) {
				await this.uploadFile(vaultPath);
				this.addLog("success", `Auto-pushed: ${vaultPath}`, vaultPath);
				return { action: "push" };
			}

			// Case 4: Only remote changed → pull
			if (!localChanged && remoteChanged) {
				await this.downloadFile(vaultPath);
				this.addLog("success", `Auto-pulled: ${vaultPath}`, vaultPath);
				return { action: "pull" };
			}

			// Case 5: Both changed → collision
			if (localChanged && remoteChanged) {
				const conflict: ConflictEntry = {
					path: vaultPath,
					s3Key: this.s3.vaultPathToKey(vaultPath),
					localMtime: Date.now(),
					remoteMtime: head?.LastModified?.getTime() ?? 0,
					localHash,
					remoteETag,
					lastSyncedHash: stored.lastSyncedHash,
				};

				this.addLog("conflict",
					`Auto-sync collision: ${vaultPath} (local: ${localHash.slice(0, 8)}…, remote: ${remoteETag.slice(0, 8)}…)`,
					vaultPath
				);

				// Apply the configured strategy for this single conflict
				const resolutions = await resolveConflicts(
					this.app,
					[conflict],
					this.settings.conflictStrategy
				);

				const resolution = resolutions[0];
				if (resolution) {
					switch (resolution.action) {
						case "use-local":
							await this.uploadFile(vaultPath);
							this.addLog("success", `Conflict resolved (local): ${vaultPath}`, vaultPath);
							break;
						case "use-remote":
							await this.downloadFile(vaultPath);
							this.addLog("success", `Conflict resolved (remote): ${vaultPath}`, vaultPath);
							break;
						case "keep-both": {
							const conflictPath = getConflictCopyPath(vaultPath);
							const remoteData = await this.s3.getObject(vaultPath);
							if (remoteData) {
								await this.ensureDir(conflictPath.split("/").slice(0, -1).join("/"));
								await this.adapter.writeBinary(conflictPath, remoteData.body.buffer as ArrayBuffer);
								this.addLog("success", `Conflict copy saved: ${conflictPath}`, conflictPath);
							}
							await this.uploadFile(vaultPath);
							break;
						}
						// "skip" — do nothing
					}
				}

				return { action: "conflict", detail: resolutions[0]?.action ?? "unresolved" };
			}

			return { action: "skip", detail: "unchanged" };
		} catch (err: any) {
			this.addLog("error", `Auto-sync error for ${vaultPath}: ${err.message}`, vaultPath);
			return { action: "error", detail: err.message };
		}
	}

	// ─── Collision Detection ──────────────────────────────────────

	/**
	 * Detect collisions between local and remote state.
	 *
	 * Collision = BOTH local AND remote changed since last sync.
	 * Files that exist on only one side are NOT collisions (new files).
	 */
	private async detectCollisions(
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, S3ObjectInfo>
	): Promise<ConflictEntry[]> {
		const conflicts: ConflictEntry[] = [];

		for (const [path, localFile] of localMap) {
			const remote = remoteMap.get(path);
			if (!remote) continue;

			const stored = this.meta.get(path);
			if (!stored) continue;

			const localHash = await this.hashLocalFile(path);
			const localChanged = localHash !== stored.lastSyncedHash;
			const remoteChanged = remote.etag !== stored.remoteETag;

			if (localChanged && remoteChanged) {
				conflicts.push({
					path,
					s3Key: remote.key,
					localMtime: localFile.mtime,
					remoteMtime: remote.lastModified.getTime(),
					localHash,
					remoteETag: remote.etag,
					lastSyncedHash: stored.lastSyncedHash,
				});
				this.addLog(
					"conflict",
					`Collision: ${path} (local: ${localHash.slice(0, 8)}…, remote: ${remote.etag.slice(0, 8)}…)`,
					path
				);
			}
		}

		return conflicts;
	}

	// ─── Resolution Application ───────────────────────────────────

	private async applyResolutions(
		resolutions: ConflictResolution[],
		conflicts: ConflictEntry[],
		result: SyncResult
	): Promise<void> {
		for (let i = 0; i < conflicts.length; i++) {
			const conflict = conflicts[i];
			const resolution = resolutions[i];
			if (!resolution) continue;

			try {
				switch (resolution.action) {
					case "use-local": {
						await this.uploadFile(conflict.path);
						result.uploaded++;
						this.addLog("success", `Resolved (local): ${conflict.path}`, conflict.path);
						break;
					}
					case "use-remote": {
						await this.downloadFile(conflict.path);
						result.downloaded++;
						this.addLog("success", `Resolved (remote): ${conflict.path}`, conflict.path);
						break;
					}
					case "keep-both": {
						const conflictPath = getConflictCopyPath(conflict.path);
						const remoteData = await this.s3.getObject(conflict.path);
						if (remoteData) {
							await this.ensureDir(conflictPath.split("/").slice(0, -1).join("/"));
							await this.adapter.writeBinary(conflictPath, remoteData.body.buffer as ArrayBuffer);
							this.addLog("success", `Conflict copy saved: ${conflictPath}`, conflictPath);
						}
						await this.uploadFile(conflict.path);
						result.uploaded++;
						break;
					}
					case "skip": {
						this.addLog("info", `Skipped: ${conflict.path}`, conflict.path);
						break;
					}
				}
			} catch (err: any) {
				result.errors.push(`Resolution failed for ${conflict.path}: ${err.message}`);
			}
		}
	}

	// ─── Local File Scanning ──────────────────────────────────────

	async scanLocalFiles(): Promise<LocalFileEntry[]> {
		const files: LocalFileEntry[] = [];
		await this.walkDir("", files);
		return files;
	}

	private async walkDir(dir: string, acc: LocalFileEntry[]): Promise<void> {
		const listing = await this.adapter.list(dir);
		for (const file of listing.files) {
			const fullPath = dir ? `${dir}/${file}` : file;
			if (matchesAnyGlob(fullPath, this.settings.excludePatterns)) continue;
			try {
				const stat = await this.adapter.read(fullPath);
				acc.push({
					path: fullPath,
					mtime: Date.now(),
					size: stat.length,
				});
			} catch {
				// Skip unreadable files
			}
		}
		for (const folder of listing.folders) {
			const fullPath = dir ? `${dir}/${folder}` : folder;
			if (matchesAnyGlob(fullPath + "/", this.settings.excludePatterns)) continue;
			await this.walkDir(fullPath, acc);
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────

	private async hashLocalFile(vaultPath: string): Promise<string> {
		try {
			const exists = await this.adapter.exists(vaultPath);
			if (!exists) return "";
			const data = await this.adapter.readBinary(vaultPath);
			return sha256(new Uint8Array(data as ArrayBuffer));
		} catch {
			return "";
		}
	}

	private async ensureDir(dirPath: string): Promise<void> {
		if (!dirPath) return;
		const segments = dirPath.split("/");
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			const exists = await this.adapter.exists(current);
			if (!exists) {
				try {
					await this.adapter.write(`${current}/.dir`, "");
					await this.adapter.remove(`${current}/.dir`);
				} catch {
					// Directory will be created implicitly on file write
				}
			}
		}
	}

	// ─── Status & Logging ─────────────────────────────────────────

	private setStatus(status: "idle" | "syncing" | "synced" | "error"): void {
		this.status = status;
		if (this.onStatusChange) this.onStatusChange(status);
	}

	addLog(level: LogLevel, message: string, path?: string): void {
		this.logs.unshift({ timestamp: Date.now(), level, message, path });
		const max = this.settings.maxLogEntries || 200;
		if (this.logs.length > max) {
			this.logs = this.logs.slice(0, max);
		}
	}

	clearLogs(): void {
		this.logs = [];
	}
}

// ─── Internal Helpers ────────────────────────────────────────────────

interface LocalFileEntry {
	path: string;
	mtime: number;
	size: number;
}

function isConflictPath(conflicts: ConflictEntry[], path: string): boolean {
	return conflicts.some((c) => c.path === path);
}

function getConflictCopyPath(originalPath: string): string {
	const dotIdx = originalPath.lastIndexOf(".");
	const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	if (dotIdx > 0) {
		const base = originalPath.slice(0, dotIdx);
		const ext = originalPath.slice(dotIdx);
		return `${base} (conflict ${dateStr})${ext}`;
	}
	return `${originalPath} (conflict ${dateStr})`;
}
