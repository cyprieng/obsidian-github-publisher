import { App, TAbstractFile, TFile, TFolder } from "obsidian";

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
	const wrapper = container.createDiv({ cls: "multi-file-suggest-wrapper" });

	// Create all the elements in the desired order
	const input = wrapper.createEl("input", {
		type: "text",
		cls: "multi-file-suggest-input",
	});
	input.placeholder = "Start typing a note or folder name...";

	const selectedDiv = wrapper.createDiv({
		cls: "multi-file-suggest-selected",
	});
	const suggestDiv = wrapper.createDiv({
		cls: "multi-file-suggest-dropdown",
	});

	// List all files and folders in the vault
	const filesAndFolders = [] as string[];
	app.vault.getAllLoadedFiles().forEach((f: TAbstractFile) => {
		if (f.path !== "" && (f instanceof TFile || f instanceof TFolder)) {
			filesAndFolders.push(f.path);
		}
	});

	// Show selected paths as chips
	function renderSelected() {
		selectedDiv.empty();
		selected.forEach((path) => {
			const chip = selectedDiv.createDiv({ cls: "multi-file-chip" });
			const label = chip.createSpan({ cls: "multi-file-chip-label" });
			label.setText(path);
			const removeBtn = chip.createSpan({
				cls: "multi-file-chip-remove",
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

	// Suggest paths dynamically based on input
	input.oninput = () => {
		suggestDiv.empty();
		const val = input.value.trim().toLowerCase();
		if (!val) return;
		let count = 0;
		for (const path of filesAndFolders) {
			if (selected.includes(path)) continue;
			if (path.toLowerCase().includes(val)) {
				const opt = suggestDiv.createDiv({
					cls: "multi-file-suggest-option",
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
				if (count >= 10) break; // Limit to 10 suggestions
			}
		}

		// No suggestions found
		if (count === 0) {
			const nores = suggestDiv.createDiv({
				cls: "multi-file-suggest-nores",
			});
			nores.setText("No results");
		}
	};

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
