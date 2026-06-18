/**
 * S3 Sync — Obsidian Plugin
 *
 * Fully automatic bidirectional sync to S3-compatible object storage.
 *
 * Automatic sync triggers:
 *   - File created  → smartSyncFile (push new file)
 *   - File modified → smartSyncFile (push if local changed)
 *   - File deleted  → deleteRemoteFile
 *   - File renamed  → upload new + delete old
 *   - On startup    → full sync (after 3s delay)
 *   - On interval   → full sync (every N seconds, default 60)
 *
 * Every per-file sync uses three-way collision detection:
 *   localHash vs remoteETag vs lastSyncedHash
 */

import { App, Modal, Plugin, Notice, type TAbstractFile } from "obsidian";
import { S3Client } from "./src/s3-client";
import { MetadataStore } from "./src/metadata-store";
import { SyncEngine } from "./src/sync-engine";
import { SyncStatusBar } from "./src/status-bar";
import { S3SyncSettingTab } from "./src/settings";
import { type S3SyncSettings, DEFAULT_SETTINGS } from "./src/types";

export default class S3SyncPlugin extends Plugin {
	settings!: S3SyncSettings;
	s3Client!: S3Client;
	metadata!: MetadataStore;
	syncEngine!: SyncEngine;
	statusBar!: SyncStatusBar;

	private autoSyncIntervalId: ReturnType<typeof setInterval> | null = null;
	private dirtyFiles = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly SAVE_DEBOUNCE_MS = 2000;
	private startupSyncDone = false;

	// ─── Lifecycle ──────────────────────────────────────────────────

	async onload(): Promise<void> {
		console.log("[S3-Sync] Loading plugin");

		// 1. Load settings
		await this.loadSettings();

		// 2. Initialise services
		this.s3Client = new S3Client(this.settings);
		this.metadata = new MetadataStore(
			this.manifest.dir ?? ".obsidian/plugins/s3-sync"
		);
		await this.metadata.load(this.app.vault.adapter as any);

		this.syncEngine = new SyncEngine(
			this.app,
			this.s3Client,
			this.metadata,
			this.settings
		);

		// 3. Status bar (click triggers full sync)
		this.statusBar = new SyncStatusBar(this.addStatusBarItem());
		this.statusBar.onClick(() => this.runFullSync());
		this.syncEngine.setOnStatusChange((status) =>
			this.statusBar.setStatus(status)
		);

		// 4. Settings tab
		this.addSettingTab(new S3SyncSettingTab(this.app, this));

		// 5. Commands (kept for manual overrides and visibility)
		this.addCommand({
			id: "s3-sync-full",
			name: "Full sync now",
			callback: () => this.runFullSync(),
		});

		this.addCommand({
			id: "s3-sync-push",
			name: "Push all local changes",
			callback: async () => {
				const result = await this.syncEngine.pushOnly();
				this.showSyncNotice(result);
			},
		});

		this.addCommand({
			id: "s3-sync-pull",
			name: "Pull all remote changes",
			callback: async () => {
				const result = await this.syncEngine.pullOnly();
				this.showSyncNotice(result);
			},
		});

		this.addCommand({
			id: "s3-sync-show-log",
			name: "Show sync log",
			callback: () => this.showSyncLog(),
		});

		this.addCommand({
			id: "s3-sync-clear-metadata",
			name: "Clear sync metadata (full re-sync)",
			callback: async () => {
				this.metadata.clearAll();
				await this.metadata.save(this.app.vault.adapter as any);
				new Notice(
					"Sync metadata cleared. Next sync will do a full comparison."
				);
			},
		});

		// 6. Auto-sync interval (periodic full sync to catch remote changes)
		this.restartAutoSync();

		// 7. File watchers — ALWAYS active, sync automatically on every change
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.onFileModified(file))
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => this.onFileCreated(file))
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.onFileDeleted(file))
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.onFileRenamed(file, oldPath)
			)
		);

		// 8. Startup sync — full bidirectional after a short delay
		if (this.settings.syncOnStartup) {
			this.scheduleStartupSync();
		}
	}

	onunload(): void {
		console.log("[S3-Sync] Unloading plugin");
		this.stopAutoSync();
		// Clear all pending debounce timers
		for (const timer of this.dirtyFiles.values()) {
			clearTimeout(timer);
		}
		this.dirtyFiles.clear();
		if (this.s3Client) {
			this.s3Client = null as any;
		}
	}

	// ─── Settings ────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.s3Client) {
			this.s3Client.reconfigure(this.settings);
		}
	}

	// ─── Connection Test ─────────────────────────────────────────────

	async testConnection(): Promise<
		{ ok: true } | { ok: false; error: string }
	> {
		const client = new S3Client(this.settings);
		return client.testConnection();
	}

	// ─── Startup Sync ─────────────────────────────────────────────────

	private scheduleStartupSync(): void {
		// Wait 3 seconds for Obsidian to fully initialise, then do a full sync
		setTimeout(() => {
			if (this.startupSyncDone) return;
			console.log("[S3-Sync] Running startup sync…");
			this.runFullSync().then(() => {
				this.startupSyncDone = true;
				console.log("[S3-Sync] Startup sync complete");
			});
		}, 3000);
	}

	// ─── Auto-Sync Interval ───────────────────────────────────────────

	restartAutoSync(): void {
		this.stopAutoSync();
		const interval = this.settings.autoSyncInterval;
		if (interval > 0) {
			this.autoSyncIntervalId = setInterval(() => {
				console.log("[S3-Sync] Interval sync triggered");
				this.syncEngine.fullSync().then((result) => {
					if (
						result.errors.length > 0 ||
						result.conflicts.length > 0
					) {
						console.log(
							"[S3-Sync] Interval sync completed with issues:",
							result
						);
					}
				});
			}, interval * 1000);
			console.log(
				`[S3-Sync] Auto-sync interval: every ${interval}s`
			);
		}
	}

	private stopAutoSync(): void {
		if (this.autoSyncIntervalId !== null) {
			clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	// ─── File Watchers (always active) ────────────────────────────────

	/**
	 * File modified — debounce per-file, then smartSyncFile.
	 *
	 * Debounce is per-file (not global): typing rapidly in file A won't
	 * block file B from syncing.
	 */
	private onFileModified(file: TAbstractFile): void {
		const path = file.path;

		// Clear existing timer for this specific file
		const existing = this.dirtyFiles.get(path);
		if (existing) clearTimeout(existing);

		// Set a new debounced timer for this file
		this.dirtyFiles.set(
			path,
			setTimeout(() => {
				this.dirtyFiles.delete(path);
				console.log(`[S3-Sync] Auto-syncing modified file: ${path}`);
				this.syncEngine.smartSyncFile(path).catch((err) => {
					console.error(
						`[S3-Sync] Auto-sync failed for ${path}:`,
						err
					);
				});
			}, this.SAVE_DEBOUNCE_MS)
		);
	}

	/**
	 * File created — immediate sync (no debounce for new files).
	 */
	private onFileCreated(file: TAbstractFile): void {
		const path = file.path;
		// Skip directory markers and internal files
		if (path.endsWith("/") || path.endsWith(".dir")) return;

		console.log(`[S3-Sync] Auto-syncing new file: ${path}`);
		this.syncEngine.smartSyncFile(path).catch((err) => {
			console.error(
				`[S3-Sync] Auto-sync failed for new file ${path}:`,
				err
			);
		});
	}

	/**
	 * File deleted locally — delete from remote immediately.
	 */
	private onFileDeleted(file: TAbstractFile): void {
		const path = file.path;
		// Cancel any pending sync for this file
		const timer = this.dirtyFiles.get(path);
		if (timer) {
			clearTimeout(timer);
			this.dirtyFiles.delete(path);
		}

		console.log(`[S3-Sync] Auto-deleting remote: ${path}`);
		this.syncEngine.deleteRemoteFile(path).catch((err) => {
			console.error(
				`[S3-Sync] Auto-delete failed for ${path}:`,
				err
			);
		});
	}

	/**
	 * File renamed — upload to new path, delete old path.
	 */
	private onFileRenamed(file: TAbstractFile, oldPath: string): void {
		const newPath = file.path;

		console.log(
			`[S3-Sync] Auto-syncing rename: ${oldPath} → ${newPath}`
		);

		// Upload the renamed file to the new key
		this.syncEngine.smartSyncFile(newPath).catch((err) => {
			console.error(
				`[S3-Sync] Rename upload failed for ${newPath}:`,
				err
			);
		});

		// Delete the old key from remote
		this.syncEngine.deleteRemoteFile(oldPath).catch((err) => {
			console.error(
				`[S3-Sync] Rename delete-old failed for ${oldPath}:`,
				err
			);
		});
	}

	// ─── Full Sync ────────────────────────────────────────────────────

	private async runFullSync(): Promise<void> {
		const result = await this.syncEngine.fullSync();
		this.showSyncNotice(result);
	}

	// ─── UI Helpers ──────────────────────────────────────────────────

	private showSyncNotice(result: {
		uploaded: number;
		downloaded: number;
		deleted: number;
		conflicts: Array<unknown>;
		errors: string[];
	}): void {
		const parts: string[] = [];
		if (result.uploaded > 0) parts.push(`↑${result.uploaded}`);
		if (result.downloaded > 0) parts.push(`↓${result.downloaded}`);
		if (result.deleted > 0) parts.push(`✕${result.deleted}`);

		const conflicts = result.conflicts.length;
		const errors = result.errors.length;

		let summary = parts.length > 0 ? parts.join(" ") : "No changes";
		if (conflicts > 0) summary += ` ⚠${conflicts} conflict(s)`;
		if (errors > 0) summary += ` ❌${errors} error(s)`;

		if (conflicts > 0 || errors > 0) {
			new Notice(`[S3 Sync] ${summary}`, errors > 0 ? 8000 : 4000);
		}
		// Don't show a notice for "No changes" — silent is better for auto-sync
	}

	private showSyncLog(): void {
		const logs = this.syncEngine.getLogs();
		if (logs.length === 0) {
			new Notice("No sync log entries yet.");
			return;
		}

		const engine = this.syncEngine;

		class SyncLogModal extends Modal {
			constructor(app: App) {
				super(app);
			}
			onOpen(): void {
				const { contentEl } = this;
				contentEl.empty();
				contentEl.createEl("h2", { text: "S3 Sync Log" });

				const logContainer = contentEl.createDiv({
					cls: "s3-sync-log-container",
				});
				logContainer.style.maxHeight = "60vh";
				logContainer.style.overflow = "auto";

				const renderLogs = (entries: typeof logs) => {
					logContainer.empty();
					if (entries.length === 0) {
						logContainer.createEl("p", {
							text: "No entries.",
							cls: "s3-sync-log-entry info",
						});
						return;
					}
					for (const entry of entries) {
						const time = new Date(
							entry.timestamp
						).toLocaleString();
						const line = logContainer.createDiv({
							cls: `s3-sync-log-entry ${entry.level}`,
						});
						line.createEl("span", {
							text: time.slice(-8),
							cls: "s3-sync-log-time",
						});
						line.createEl("span", {
							text: ` ${entry.message}`,
						});
					}
				};

				renderLogs(logs);

				const btnContainer = contentEl.createDiv({
					cls: "s3-sync-log-actions",
				});
				btnContainer.style.marginTop = "12px";
				btnContainer.style.display = "flex";
				btnContainer.style.gap = "8px";

				const refreshBtn = btnContainer.createEl("button", {
					text: "Refresh",
				});
				refreshBtn.addEventListener("click", () =>
					renderLogs(engine.getLogs())
				);

				const clearBtn = btnContainer.createEl("button", {
					text: "Clear Log",
					cls: "mod-warning",
				});
				clearBtn.addEventListener("click", () => {
					engine.clearLogs();
					renderLogs([]);
				});
			}
			onClose(): void {
				this.contentEl.empty();
			}
		}

		new SyncLogModal(this.app).open();
	}
}
