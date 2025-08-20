import { App, TFile, TFolder } from "obsidian";

/**
 * Adds a multi-path input component to the specified container, allowing users to select multiple files or folders from the vault.
 *
 * @param {HTMLElement} container - The HTML element to which the input will be appended.
 * @param {App} app - The Obsidian app instance, used to access the vault and files.
 * @param {string[]} selected - The array of currently selected file or folder paths.
 * @param {(selected: string[]) => void} onChange - Callback function called whenever the selection changes.
 */
export function addMultiPathInput(
	container: HTMLElement,
	app: App,
	selected: string[],
	onChange: (selected: string[]) => void,
) {
	// Wrapper containing the input and suggestions
	const wrapper = container.createDiv({
		cls: "github-publisher-multi-file-suggest-wrapper",
	});

	// Create all the elements in the desired order
	const input = wrapper.createEl("input", {
		type: "text",
		cls: "github-publisher-multi-file-suggest-input",
	});
	input.placeholder = "Start typing a note or folder name...";

	const selectedDiv = wrapper.createDiv({
		cls: "github-publisher-multi-file-suggest-selected",
	});
	const suggestDiv = wrapper.createDiv({
		cls: "github-publisher-multi-file-suggest-dropdown",
	});

	// Show selected paths as chips
	function renderSelected() {
		selectedDiv.empty();
		selected.forEach((path) => {
			const chip = selectedDiv.createDiv({
				cls: "github-publisher-multi-file-chip",
			});
			const label = chip.createSpan({
				cls: "github-publisher-multi-file-chip-label",
			});
			label.setText(path);
			const removeBtn = chip.createSpan({
				cls: "github-publisher-multi-file-chip-remove",
				text: "✕",
			});
			removeBtn.onclick = () => {
				const idx = selected.indexOf(path);
				if (idx > -1) selected.splice(idx, 1);
				onChange([...selected]);
				renderSelected();
			};
		});
	}
	renderSelected();

	// Debounce
	let inputTimeout: number | undefined;
	function debounce(fn: () => void, delay: number) {
		if (inputTimeout) window.clearTimeout(inputTimeout);
		inputTimeout = window.setTimeout(fn, delay);
	}

	// Search function: Walks the vault only as needed
	function searchVault(query: string, limit = 10): string[] {
		const results: string[] = [];
		const lowerQuery = query.toLowerCase();

		// Early exit if empty
		if (!lowerQuery) return results;

		function walk(folder: TFolder) {
			for (const child of folder.children) {
				if (results.length >= limit) return;
				const path = child.path;
				if (
					(child instanceof TFile || child instanceof TFolder) &&
					path.toLowerCase().includes(lowerQuery) &&
					!selected.includes(path)
				) {
					results.push(path);
				}
				if (child instanceof TFolder) {
					walk(child);
				}
			}
		}

		walk(app.vault.getRoot());
		return results;
	}

	// Suggest paths dynamically based on input, without pre-scanning the full vault
	function handleInput() {
		suggestDiv.empty();
		const val = input.value.trim().toLowerCase();
		if (!val) return;
		const results = searchVault(val, 10);
		let count = 0;
		for (const path of results) {
			const opt = suggestDiv.createDiv({
				cls: "github-publisher-multi-file-suggest-option",
			});
			opt.setText(path);
			opt.onclick = () => {
				selected.push(path);
				onChange([...selected]);
				input.value = "";
				suggestDiv.empty();
				renderSelected();
			};
			count++;
		}
		if (count === 0) {
			const noResult = suggestDiv.createDiv({
				cls: "github-publisher-multi-file-suggest-no-result",
			});
			noResult.setText("No results");
		}
	}

	// Debounced input handler
	input.oninput = () => debounce(handleInput, 100);

	// Handle Enter key to select first suggestion
	input.onkeydown = (e) => {
		if (e.key === "Enter" && suggestDiv.firstElementChild) {
			(suggestDiv.firstElementChild as HTMLElement).click();
			e.preventDefault();
		}
	};

	// Close suggestions when clicking outside or on blur
	input.onblur = () => setTimeout(() => suggestDiv.empty(), 150);
}
