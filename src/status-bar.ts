/**
 * Status bar indicator for S3 Sync.
 *
 * Displays the current sync state as a clickable element in the
 * Obsidian status bar:
 *   ☁️ Synced      — last sync was successful
 *   ☁️ Syncing…   — sync in progress
 *   ☁️ Error      — last sync failed
 *   ☁️ Idle       — no sync has been performed yet
 *
 * Click to trigger a full sync.
 */

import type { Notice } from "obsidian";

export class SyncStatusBar {
	private element: HTMLElement;
	private status: string = "idle";
	private lastSyncTime: number = 0;
	private onClickCallback: (() => void) | null = null;

	constructor(statusBarEl: HTMLElement) {
		this.element = statusBarEl.createEl("span", {
			cls: "s3-sync-status",
			text: "☁️ S3 Sync",
		});

		this.element.addEventListener("click", () => {
			if (this.onClickCallback) {
				this.onClickCallback();
			}
		});

		this.setStatus("idle");
	}

	/** Register a callback for when the status bar is clicked. */
	onClick(callback: () => void): void {
		this.onClickCallback = callback;
	}

	/** Update the displayed status. */
	setStatus(status: string): void {
		this.status = status;

		this.element.removeClass("syncing", "synced", "error", "idle");

		switch (status) {
			case "syncing":
				this.element.setText("☁️ Syncing…");
				this.element.addClass("syncing");
				break;
			case "synced":
				this.lastSyncTime = Date.now();
				this.element.setText(this.formatLabel("☁️ Synced"));
				this.element.addClass("synced");
				break;
			case "error":
				this.element.setText("☁️ Sync Error");
				this.element.addClass("error");
				break;
			case "idle":
			default:
				this.element.setText("☁️ S3 Sync");
				this.element.addClass("idle");
				break;
		}
	}

	private formatLabel(base: string): string {
		if (this.lastSyncTime) {
			const ago = this.timeAgo(this.lastSyncTime);
			return `${base} (${ago})`;
		}
		return base;
	}

	private timeAgo(ts: number): string {
		const seconds = Math.floor((Date.now() - ts) / 1000);
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	/** Remove the status bar element. */
	remove(): void {
		this.element.remove();
	}
}
