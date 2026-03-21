/**
 * Adds a multi-tag input component to the specified container,
 * allowing users to add/remove multiple tags for publish filtering.
 *
 * @param container - The HTML element to which the input will be appended.
 * @param selected - The array of currently selected tags (with # prefix).
 * @param onChange - Callback called whenever the selection changes.
 */
export function addMultiTagInput(
	container: HTMLElement,
	selected: string[],
	onChange: (selected: string[]) => void,
) {
	const wrapper = container.createDiv({
		cls: "github-publisher-multi-file-suggest-wrapper",
	});

	const input = wrapper.createEl("input", {
		type: "text",
		cls: "github-publisher-multi-file-suggest-input",
	});
	input.placeholder = "#note";

	const selectedDiv = wrapper.createDiv({
		cls: "github-publisher-multi-file-suggest-selected",
	});

	function renderSelected() {
		selectedDiv.empty();
		selected.forEach((tag) => {
			const chip = selectedDiv.createDiv({
				cls: "github-publisher-multi-file-chip",
			});
			const label = chip.createSpan({
				cls: "github-publisher-multi-file-chip-label",
			});
			label.setText(tag);
			const removeBtn = chip.createSpan({
				cls: "github-publisher-multi-file-chip-remove",
				text: "✕",
			});
			removeBtn.onclick = () => {
				const idx = selected.indexOf(tag);
				if (idx > -1) selected.splice(idx, 1);
				onChange([...selected]);
				renderSelected();
			};
		});
	}
	renderSelected();

	function addTag() {
		let val = input.value.trim();
		if (!val) return;
		// Ensure # prefix
		if (!val.startsWith("#")) val = "#" + val;
		if (!selected.includes(val)) {
			selected.push(val);
			onChange([...selected]);
			renderSelected();
		}
		input.value = "";
	}

	input.onkeydown = (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addTag();
		}
	};
}
