/**
 * Status bar indicator for S3 Sync.
 *
 * Displays sync state as a clickable element:
 *   ⏸️ Sync Paused  — automatic sync is paused (manual commands still work)
 *   ☁️ Syncing…    — sync in progress
 *   ☁️ Synced      — last sync was successful (with relative time)
 *   ☁️ Sync Error  — last sync failed
 *   ☁️ S3 Sync     — idle (no sync yet)
 *
 * Click to pause or resume automatic sync.
 */

export class SyncStatusBar {
	private element: HTMLElement;
	private status: string = "idle";
	private paused: boolean = false;
	private lastSyncTime: number = 0;
	private onClickCallback: (() => void) | null = null;

	constructor(statusBarEl: HTMLElement, paused: boolean = false) {
		this.element = statusBarEl.createEl("span", {
			cls: "s3-sync-status",
		});
		this.paused = paused;
		this.element.addEventListener("click", () => {
			if (this.onClickCallback) this.onClickCallback();
		});
		this.render();
	}

	/** Register a callback for when the status bar is clicked. */
	onClick(callback: () => void): void {
		this.onClickCallback = callback;
	}

	/** Update whether sync is paused (changes the visual). */
	setPaused(paused: boolean): void {
		this.paused = paused;
		this.render();
	}

	isPaused(): boolean {
		return this.paused;
	}

	/** Update the sync status. */
	setStatus(status: string): void {
		this.status = status;
		this.render();
	}

	private render(): void {
		this.element.removeClass("syncing", "synced", "error", "idle", "paused");

		if (this.paused) {
			this.element.setText("⏸️ Sync Paused");
			this.element.addClass("paused");
			this.element.setAttr("aria-label", "Click to resume automatic sync");
			return;
		}

		switch (this.status) {
			case "syncing":
				this.element.setText("☁️ Syncing…");
				this.element.addClass("syncing");
				this.element.setAttr("aria-label", "Sync in progress — click to pause");
				break;
			case "synced":
				this.lastSyncTime = Date.now();
				this.element.setText(this.formatLabel("☁️ Synced"));
				this.element.addClass("synced");
				this.element.setAttr("aria-label", "Click to pause automatic sync");
				break;
			case "error":
				this.element.setText("☁️ Sync Error");
				this.element.addClass("error");
				this.element.setAttr("aria-label", "Click to pause automatic sync");
				break;
			case "idle":
			default:
				this.element.setText("☁️ S3 Sync");
				this.element.addClass("idle");
				this.element.setAttr("aria-label", "Click to pause automatic sync");
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
