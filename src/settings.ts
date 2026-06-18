/**
 * Settings tab for the S3 Sync plugin.
 *
 * Exposes all configuration options via Obsidian's Settings API:
 *   - S3 endpoint, bucket, region, credentials
 *   - Path prefix, path-style toggle
 *   - Conflict resolution strategy
 *   - Auto-sync interval
 *   - Sync-on-save toggle
 *   - Exclude patterns
 *   - Connection test button
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type S3SyncPlugin from "../main";
import type { ConflictStrategy, S3SyncSettings } from "./types";

export class S3SyncSettingTab extends PluginSettingTab {
	private plugin: S3SyncPlugin;

	constructor(app: App, plugin: S3SyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("s3-sync-settings");

		// ─── Header ───────────────────────────────────────────────
		containerEl.createEl("h2", { text: "S3 Sync Settings" });

		// ─── Connection ───────────────────────────────────────────
		containerEl.createEl("h3", { text: "Connection" });

		new Setting(containerEl)
			.setName("Endpoint URL")
			.setDesc(
				"S3-compatible endpoint. Leave empty for AWS S3, or set to your provider's URL " +
				"(e.g., https://minio.example.com, https://<account>.r2.cloudflarestorage.com)"
			)
			.addText((text) =>
				text
					.setPlaceholder("https://s3.amazonaws.com")
					.setValue(this.plugin.settings.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.endpoint = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bucket")
			.setDesc("The name of your S3 bucket.")
			.addText((text) =>
				text
					.setPlaceholder("my-obsidian-vault")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Region")
			.setDesc("AWS region (or any value for non-AWS providers).")
			.addText((text) =>
				text
					.setPlaceholder("us-east-1")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim() || "us-east-1";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Access Key ID")
			.setDesc("Your S3 access key ID.")
			.addText((text) =>
				text
					.setPlaceholder("AKIA...")
					.setValue(this.plugin.settings.accessKeyId)
					.onChange(async (value) => {
						this.plugin.settings.accessKeyId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Secret Access Key")
			.setDesc("Your S3 secret access key.")
			.addText((text) => {
				text
					.setPlaceholder("••••••••")
					.setValue(this.plugin.settings.secretAccessKey)
					.onChange(async (value) => {
						this.plugin.settings.secretAccessKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Force path-style")
			.setDesc(
				"Use path-style URLs (bucket in path). REQUIRED for MinIO and most self-hosted " +
				"S3-compatible servers. Disable for AWS S3 with virtual-hosted-style."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.forcePathStyle)
					.onChange(async (value) => {
						this.plugin.settings.forcePathStyle = value;
						await this.plugin.saveSettings();
					})
			);

		// ─── Connection Test ──────────────────────────────────────
		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify that the plugin can reach your S3 bucket.")
			.addButton((btn) =>
				btn
					.setButtonText("Test Connection")
					.setCta()
					.onClick(async () => {
						btn.setButtonText("Testing…");
						btn.setDisabled(true);
						try {
							const result = await this.plugin.testConnection();
							if (result.ok) {
								new Notice("✅ Connection successful!");
							} else {
								new Notice(`❌ Connection failed: ${result.error}`);
							}
						} catch (err: any) {
							new Notice(`❌ Connection failed: ${err.message}`);
						} finally {
							btn.setButtonText("Test Connection");
							btn.setDisabled(false);
						}
					})
			);

		// ─── Sync Options ─────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync" });

		new Setting(containerEl)
			.setName("Path prefix")
			.setDesc(
				"Optional prefix inside the bucket (e.g., 'my-vault/'). " +
				"Only files under this prefix will be synced."
			)
			.addText((text) =>
				text
					.setPlaceholder("vault/")
					.setValue(this.plugin.settings.prefix)
					.onChange(async (value) => {
						let v = value.trim();
						// Ensure trailing slash if non-empty
						if (v && !v.endsWith("/")) v += "/";
						this.plugin.settings.prefix = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Conflict strategy")
			.setDesc(
				"How to handle conflicts when both local and remote files have changed. " +
				"'Ask' will show a dialog for each conflict."
			)
			.addDropdown((dropdown) => {
				const strategies: Record<ConflictStrategy, string> = {
					ask: "Ask (interactive)",
					"local-wins": "Local wins",
					"remote-wins": "Remote wins",
					"keep-both": "Keep both",
					"newer-wins": "Newer wins",
				};
				for (const [value, label] of Object.entries(strategies)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy = value as ConflictStrategy;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-sync interval (seconds)")
			.setDesc("Automatically sync every N seconds. Set to 0 to disable.")
			.addText((text) => {
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						this.plugin.settings.autoSyncInterval = isNaN(num) || num < 0 ? 0 : num;
						await this.plugin.saveSettings();
						this.plugin.restartAutoSync();
					});
				text.inputEl.type = "number";
				text.inputEl.min = "0";
			});

		new Setting(containerEl)
			.setName("Sync on save")
			.setDesc("Automatically sync when a file is saved (debounced).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnSave)
					.onChange(async (value) => {
						this.plugin.settings.syncOnSave = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Perform a full bidirectional sync when Obsidian starts.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		// ─── Exclude Patterns ─────────────────────────────────────
		containerEl.createEl("h3", { text: "Exclude" });

		const excludeDesc = containerEl.createDiv({
			cls: "setting-item-description",
		});
		excludeDesc.createEl("p", {
			text: "Glob patterns for files/folders to exclude from sync. One per line. " +
				"Supports *, **, and ? wildcards.",
		});
		excludeDesc.createEl("p", {
			text: "Default: .obsidian/**, .trash/**, .DS_Store, **/.DS_Store",
			cls: "s3-sync-hint",
		});

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc("")
			.addTextArea((text) => {
				text
					.setPlaceholder(".obsidian/**\n.trash/**\n.DS_Store")
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((p) => p.trim())
							.filter((p) => p.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.style.minWidth = "300px";
				text.inputEl.style.fontFamily = "var(--font-monospace)";
			});

		// ─── Advanced ─────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Advanced" });

		new Setting(containerEl)
			.setName("Max log entries")
			.setDesc("Maximum number of sync log entries to keep in memory.")
			.addText((text) => {
				text
					.setPlaceholder("200")
					.setValue(String(this.plugin.settings.maxLogEntries))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						this.plugin.settings.maxLogEntries = isNaN(num) || num < 1 ? 200 : num;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "number";
				text.inputEl.min = "10";
			});

		// ─── Danger Zone ──────────────────────────────────────────
		containerEl.createEl("h3", { text: "Danger Zone" });

		new Setting(containerEl)
			.setName("Clear sync metadata")
			.setDesc(
				"Reset all sync state. Next sync will treat every file as new and compare " +
				"by modification time — this may cause conflicts."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clear Metadata")
					.setWarning()
					.onClick(async () => {
						this.plugin.metadata.clearAll();
						await this.plugin.metadata.save(
							this.app.vault.adapter as any
						);
						new Notice("Sync metadata cleared. Next sync will be a full comparison.");
					})
			);
	}
}
