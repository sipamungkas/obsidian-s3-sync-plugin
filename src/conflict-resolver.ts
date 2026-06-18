/**
 * Conflict resolution engine.
 *
 * Supports five strategies:
 *   `local-wins`   — overwrite remote with local
 *   `remote-wins`  — overwrite local with remote
 *   `keep-both`    — keep local as-is, save remote as "file (conflict date).ext"
 *   `newer-wins`   — compare modification timestamps
 *   `ask`          — interactive dialog (the default)
 */

import { App, Modal } from "obsidian";
import type { ConflictEntry, ConflictResolution, ConflictStrategy } from "./types";

// ─── Public API ──────────────────────────────────────────────────────

export type ConflictHandle = ConflictEntry & {
	resolve: (resolution: ConflictResolution) => void;
};

/**
 * Resolve a batch of conflicts according to the configured strategy.
 *
 * For `ask` strategy this will show a modal *per conflict* and await user
 * input.  For all other strategies it resolves synchronously.
 */
export async function resolveConflicts(
	app: App,
	conflicts: ConflictEntry[],
	strategy: ConflictStrategy
): Promise<ConflictResolution[]> {
	if (conflicts.length === 0) return [];

	switch (strategy) {
		case "local-wins":
			return conflicts.map(() => ({ action: "use-local" as const }));

		case "remote-wins":
			return conflicts.map(() => ({ action: "use-remote" as const }));

		case "keep-both":
			return conflicts.map(() => ({ action: "keep-both" as const }));

		case "newer-wins":
			return conflicts.map((c) => ({
				action:
					c.localMtime >= c.remoteMtime
						? ("use-local" as const)
						: ("use-remote" as const),
			}));

		case "ask":
			return resolveInteractively(app, conflicts);

		default:
			// Fallback: keep both
			return conflicts.map(() => ({ action: "keep-both" as const }));
	}
}

// ─── Interactive Resolution ──────────────────────────────────────────

async function resolveInteractively(
	app: App,
	conflicts: ConflictEntry[]
): Promise<ConflictResolution[]> {
	const results: ConflictResolution[] = [];

	for (const conflict of conflicts) {
		const resolution = await showConflictDialog(app, conflict);
		results.push(resolution);
	}

	return results;
}

/**
 * Show a dialog for a single conflict file, returning the user's choice.
 *
 * We build the UI programmatically with a Modal that presents:
 *   1. The file path
 *   2. Local vs remote timestamps and sizes
 *   3. Four buttons: Use Local, Use Remote, Keep Both, Skip
 */
function showConflictDialog(
	app: App,
	conflict: ConflictEntry
): Promise<ConflictResolution> {
	return new Promise((resolve) => {
		const modal = new ConflictResolutionModal(app, conflict, resolve);
		modal.open();
	});
}

// ─── Modal ───────────────────────────────────────────────────────────

class ConflictResolutionModal extends Modal {
	private conflict: ConflictEntry;
	private resolve: (r: ConflictResolution) => void;

	constructor(
		app: App,
		conflict: ConflictEntry,
		resolve: (r: ConflictResolution) => void
	) {
		super(app);
		this.conflict = conflict;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl, conflict } = this;

		contentEl.addClass("s3-sync-conflict-modal");
		contentEl.empty();

		// Header
		contentEl.createEl("h3", { text: "Sync Conflict Detected" });

		// File path
		const fileEl = contentEl.createDiv({ cls: "conflict-file" });
		fileEl.createEl("strong", { text: "File: " });
		fileEl.createEl("code", { text: conflict.path });

		// Details
		const detailEl = contentEl.createDiv({ cls: "conflict-detail" });
		detailEl.createEl("p", {
			text: "Both the local and remote versions have changed since the last sync. Choose which version to keep.",
		});

		const localTime = new Date(conflict.localMtime).toLocaleString();
		const remoteTime = new Date(conflict.remoteMtime).toLocaleString();

		detailEl.createEl("p", {
			text: `📄 Local:  modified ${localTime}  (hash: ${conflict.localHash.slice(0, 12)}…)`,
		});
		detailEl.createEl("p", {
			text: `☁️ Remote: modified ${remoteTime}  (ETag: ${conflict.remoteETag.slice(0, 12)}…)`,
		});

		// Buttons
		const buttonContainer = contentEl.createDiv({
			cls: "s3-sync-button-group",
		});
		buttonContainer.style.display = "flex";
		buttonContainer.style.flexDirection = "column";
		buttonContainer.style.gap = "8px";
		buttonContainer.style.marginTop = "16px";

		this.createButton(buttonContainer, "📄 Use Local (overwrite remote)", "use-local");
		this.createButton(buttonContainer, "☁️ Use Remote (overwrite local)", "use-remote");
		this.createButton(
			buttonContainer,
			"📋 Keep Both (save remote as conflict copy)",
			"keep-both"
		);
		this.createButton(buttonContainer, "⏭️ Skip (resolve later)", "skip");
	}

	private createButton(container: HTMLElement, label: string, action: string): void {
		const btn = container.createEl("button", {
			cls: "mod-cta",
			text: label,
		});
		btn.addEventListener("click", () => {
			const resolution: ConflictResolution =
				action === "use-local"
					? { action: "use-local" }
					: action === "use-remote"
						? { action: "use-remote" }
						: action === "keep-both"
							? { action: "keep-both" }
							: { action: "skip" };

			this.resolve(resolution);
			this.close();
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
