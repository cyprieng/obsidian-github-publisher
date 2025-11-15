import { addMultiPathInput } from "./multi-path-input";
import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	TFile,
	TFolder,
	Notice,
	normalizePath,
} from "obsidian";
import { Octokit, RestEndpointMethodTypes } from "@octokit/rest";

// Interface for plugin settings
interface GitHubPublisherSettings {
	githubToken: string; // GitHub personal access token
	repoUrl: string; // URL of the GitHub repository
	repoFolder: string; // Relative path in the repo where notes will be placed
	repoBranch: string; // Branch to push changes to
	selectedPaths: string[]; // List of paths to sync (files or folders in the vault)
	syncInterval: number; // Sync interval in minutes
	lastSyncDate?: string; // Last sync date in ISO format
}

// Default settings for the plugin
const DEFAULT_SETTINGS: GitHubPublisherSettings = {
	githubToken: "",
	repoUrl: "",
	repoFolder: "",
	repoBranch: "main",
	selectedPaths: [],
	syncInterval: 60,
};

// Interface for local files to be published
interface LocalFile {
	vaultPath: string; // Path in the Obsidian vault
	repoPath: string; // Path in the GitHub repository
	content?: string; // Content of the file as text (if it's a text file)
	binary?: ArrayBuffer; // Binary content of the file (if it's a binary file)
	isText: boolean; // Whether the file is a text file or binary
}

// Parse the GitHub repository URL to extract owner and repo name
function parseRepoUrl(repoUrl: string) {
	const m = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/i);
	if (!m) throw new Error("Invalid GitHub repository URL");
	return { owner: m[1], repo: m[2] };
}

/**
 * Determines if the given ArrayBuffer likely contains text data.
 *
 * Samples up to `sampleSize` bytes from the buffer and counts the number of non-ASCII bytes.
 * If the proportion of non-ASCII bytes is less than 5%, the buffer is considered text.
 *
 * @param {ArrayBuffer} buffer - The buffer to analyze.
 * @param {number} [sampleSize=1024] - The maximum number of bytes to sample from the buffer.
 * @returns {boolean} True if the buffer is likely text, false otherwise.
 */
function isTextBuffer(buffer: ArrayBuffer, sampleSize = 1024): boolean {
	const bytes = new Uint8Array(buffer);
	const len = Math.min(bytes.length, sampleSize);
	let nonAscii = 0;
	for (let i = 0; i < len; i++) {
		const c = bytes[i];
		if (
			c !== 9 &&
			c !== 10 &&
			c !== 13 && // not tab, LF, CR
			!(c >= 32 && c <= 126) && // not printable ASCII
			!(c >= 128 && c <= 255) // not extended UTF-8
		) {
			nonAscii++;
		}
	}
	return nonAscii / len < 0.05;
}

// Main plugin class
export default class GitHubPublisherPlugin extends Plugin {
	settings: GitHubPublisherSettings; // Plugin settings
	octokit: Octokit; // Octokit instance for GitHub API interactions
	settingTab: GitHubPublisherSettingTab | null = null; // Settings tab instance

	private syncIntervalId: number | null = null; // ID of the sync interval

	/**
	 * Initializes the plugin by loading settings, adding the settings tab and registering the sync command.
	 *
	 * @async
	 * @returns {Promise<void>} Resolves when the plugin has finished loading.
	 */
	async onload(): Promise<void> {
		// Load settings from storage or use default values
		await this.loadSettings();

		// Load the settings tab for the plugin
		this.settingTab = new GitHubPublisherSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Add a command to the command palette for manual sync
		this.addCommand({
			id: "publish-now",
			name: "Publish to GitHub now",
			callback: () => {
				void this.publishToGitHub();
			},
		});
	}

	/**
	 * Clears the synchronization interval if it is currently set.
	 * This will stop any ongoing periodic sync operations.
	 */
	clearInterval() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	/**
	 * Sets up a periodic synchronization interval to GitHub based on the user settings.
	 * If the sync interval is not a positive number, any existing interval is cleared and no new interval is set.
	 * Otherwise, clears any existing interval and sets a new one with the specified interval in minutes.
	 *
	 * @returns {void}
	 */
	setupSyncInterval(): void {
		// Clear any existing interval before setting a new one
		this.clearInterval();

		// Check that all settings are complete
		if (
			!this.settings.githubToken ||
			!this.settings.repoUrl ||
			!this.settings.repoBranch
		) {
			return;
		}

		// If syncInterval is not a positive number abort
		const minutes = Number(this.settings.syncInterval);
		if (isNaN(minutes) || minutes <= 0) {
			return;
		}

		// Set up a new interval to sync to GitHub
		this.syncIntervalId = this.registerInterval(
			window.setInterval(
				() => {
					void this.publishToGitHub();
				},
				this.settings.syncInterval * 60 * 1000,
			),
		);
	}

	/**
	 * Updates the lastSyncDate setting to the current date and time in ISO format,
	 * then saves the updated settings asynchronously.
	 */
	async updateLastSyncDate() {
		this.settings.lastSyncDate = new Date().toISOString();
		await this.saveSettings();

		if (this.settingTab && this.settingTab.active) {
			this.settingTab.display();
		}
	}

	/**
	 * Synchronizes selected local files and folders to a GitHub repository.
	 *
	 * This method performs the following steps:
	 * 1. Validates GitHub settings and selected paths.
	 * 2. Gathers local files and their contents from the vault.
	 * 3. Fetches the latest commit and tree from the target GitHub repository branch.
	 * 4. Maps remote files in the target folder and prepares a new tree with additions, updates, and deletions.
	 * 5. If there are changes, creates a new tree and commit, and updates the branch reference.
	 * 6. Updates the last sync date and notifies the user.
	 *
	 * @async
	 * @throws Will display a notice and log an error if synchronization fails.
	 * @returns {Promise<void>} Resolves when synchronization is complete or if no changes are detected.
	 */
	async publishToGitHub(): Promise<void> {
		try {
			// Check that all settings are complete
			if (
				!this.settings.githubToken ||
				!this.settings.repoUrl ||
				!this.settings.repoBranch
			) {
				new Notice("GitHub publisher: invalid settings");
				return;
			}

			// Retrieve owner and repo from the URL, branch, and folder settings
			const { owner, repo } = parseRepoUrl(this.settings.repoUrl);
			const branch = this.settings.repoBranch;
			const repoFolder = this.settings.repoFolder.replace(/^\/|\/$/g, "");
			const pathsToSync = this.settings.selectedPaths;
			const localFiles: LocalFile[] = [];

			// Gather local files (vaultPath: path in vault, repoPath: path in repo)
			for (const path of pathsToSync) {
				await this.gatherFilesRecursively(
					this.app,
					path,
					repoFolder,
					localFiles,
				);
			}

			// Get latest commit and tree
			const ref = await this.octokit.rest.git.getRef({
				owner,
				repo,
				ref: `heads/${branch}`,
			});
			const latestCommitSha = ref.data.object.sha;
			const latestCommit = await this.octokit.rest.git.getCommit({
				owner,
				repo,
				commit_sha: latestCommitSha,
			});
			const baseTreeSha = latestCommit.data.tree.sha;
			const baseTree = await this.octokit.rest.git.getTree({
				owner,
				repo,
				tree_sha: baseTreeSha,
				recursive: "true",
			});

			// Map remote files in the target folder
			const remoteFiles = new Map<string, string>(); // path -> blob Sha
			for (const obj of baseTree.data.tree) {
				if (
					obj.type === "blob" &&
					obj.path &&
					(obj.path === repoFolder ||
						obj.path.startsWith(repoFolder + "/"))
				) {
					remoteFiles.set(obj.path, obj.sha || "");
				}
			}
			const localRepoPaths = new Set(localFiles.map((f) => f.repoPath));

			// Prepare the new tree:
			type TreeItem =
				RestEndpointMethodTypes["git"]["createTree"]["parameters"]["tree"][number];
			const tree: TreeItem[] = [];

			// Add or update files (if content changed)
			for (const file of localFiles) {
				// Remote and local sha to check for changes
				const remoteSha = remoteFiles.get(file.repoPath);
				let localSha: string | undefined = undefined;

				if (file.isText && file.content !== undefined) {
					// Text file
					localSha = await this.gitBlobSha1(file.content);
					if (localSha !== remoteSha) {
						const blob = await this.octokit.rest.git.createBlob({
							owner,
							repo,
							content: file.content,
							encoding: "utf-8",
						});
						tree.push({
							path: file.repoPath,
							mode: "100644",
							type: "blob",
							sha: blob.data.sha,
						});
					}
				} else if (!file.isText && file.binary !== undefined) {
					// Binary file
					localSha = await this.gitBlobSha1(file.binary);
					if (localSha !== remoteSha) {
						const base64Content = this.arrayBufferToBase64(
							file.binary,
						);
						const blob = await this.octokit.rest.git.createBlob({
							owner,
							repo,
							content: base64Content,
							encoding: "base64",
						});
						tree.push({
							path: file.repoPath,
							mode: "100644",
							type: "blob",
							sha: blob.data.sha,
						});
					}
				}
			}

			// Delete files in the repo folder that are not in localFiles
			for (const remotePath of remoteFiles.keys()) {
				if (!localRepoPaths.has(remotePath)) {
					tree.push({
						path: remotePath,
						mode: "100644",
						type: "blob",
						sha: "", // To delete a file, set sha to an empty string
					});
				}
			}

			// If nothing to change, stop here
			if (tree.length === 0) {
				await this.updateLastSyncDate();
				return;
			}

			// Create the new tree and commit
			const newTree = await this.octokit.rest.git.createTree({
				owner,
				repo,
				base_tree: baseTreeSha,
				tree,
			});

			const commit = await this.octokit.rest.git.createCommit({
				owner,
				repo,
				message: "Publish Obsidian → GitHub",
				tree: newTree.data.sha,
				parents: [latestCommitSha],
				author: {
					name: "Obsidian GitHub Publisher",
					email: "obsidian-bot@cyprien.io",
				},
				committer: {
					name: "Obsidian GitHub Publisher",
					email: "obsidian-bot@cyprien.io",
				},
			});
			await this.octokit.rest.git.updateRef({
				owner,
				repo,
				ref: `heads/${branch}`,
				sha: commit.data.sha,
			});

			await this.updateLastSyncDate();
		} catch (e) {
			console.error("GitHub Publisher: error during publish", e);
			const errorMessage = e instanceof Error ? e.message : String(e);
			new Notice(
				"GitHub Publisher: error during publish : " + errorMessage,
			);
		}
	}

	/**
	 * Recursively gathers files from the vault, reading their contents as text or binary.
	 * This modify the `localFiles` array with metadata and contents of each file.
	 *
	 * @param app - The Obsidian App instance.
	 * @param basePath - The base path in the vault to start gathering files from.
	 * @param repoFolder - The repository folder path to prepend to each file's path.
	 * @param localFiles - The array to collect file metadata and contents.
	 * @returns {Promise<void>} Resolves when all files have been gathered.
	 */
	async gatherFilesRecursively(
		app: App,
		basePath: string,
		repoFolder: string,
		localFiles: LocalFile[],
	): Promise<void> {
		const fileOrFolder = app.vault.getAbstractFileByPath(
			normalizePath(basePath),
		);
		if (!fileOrFolder) return;
		if (fileOrFolder instanceof TFile) {
			const binary = await app.vault.readBinary(fileOrFolder);
			const isText = isTextBuffer(binary);
			localFiles.push({
				vaultPath: fileOrFolder.path,
				repoPath: repoFolder
					? `${repoFolder}/${fileOrFolder.path}`
					: fileOrFolder.path,
				content: isText
					? new TextDecoder("utf-8").decode(binary)
					: undefined,
				binary: !isText ? binary : undefined,
				isText,
			});
		} else if (fileOrFolder instanceof TFolder) {
			for (const child of fileOrFolder.children) {
				await this.gatherFilesRecursively(
					app,
					child.path,
					repoFolder,
					localFiles,
				);
			}
		}
	}

	/**
	 * Converts an ArrayBuffer to a Base64-encoded string.
	 *
	 * @param buffer - The ArrayBuffer to convert.
	 * @returns The Base64-encoded string representation of the buffer.
	 */
	arrayBufferToBase64(buffer: ArrayBuffer): string {
		let binary = "";
		const bytes = new Uint8Array(buffer);
		const len = bytes.byteLength;
		for (let i = 0; i < len; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	/**
	 * Computes the Git blob SHA-1 hash for the given content.
	 *
	 * The function constructs a Git blob object from the input content, prepends the appropriate header,
	 * and then calculates the SHA-1 hash as used by Git for blob objects.
	 *
	 * @param content - The content to hash. Can be a string, ArrayBuffer, or Uint8Array.
	 * @returns A promise that resolves to the SHA-1 hash as a hexadecimal string.
	 */
	async gitBlobSha1(
		content: string | ArrayBuffer | Uint8Array,
	): Promise<string> {
		let contentBytes: Uint8Array;
		if (typeof content === "string") {
			contentBytes = new TextEncoder().encode(content);
		} else if (content instanceof ArrayBuffer) {
			contentBytes = new Uint8Array(content);
		} else {
			contentBytes = content;
		}
		const header = `blob ${contentBytes.length}\0`;
		const headerBytes = new TextEncoder().encode(header);

		const blob = new Uint8Array(headerBytes.length + contentBytes.length);
		blob.set(headerBytes, 0);
		blob.set(contentBytes, headerBytes.length);

		const hashBuffer = await window.crypto.subtle.digest("SHA-1", blob);

		return Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/**
	 * Handles changes to the settings.
	 *
	 * Sets up Octokit with the GitHub token from the settings and configures the sync interval.
	 * This method should be called whenever the settings are updated to ensure the latest configuration is used.
	 */
	onSettingsChange() {
		// Set up Octokit with the GitHub token
		this.octokit = new Octokit({ auth: this.settings.githubToken });

		// Set up the sync interval based on the configured settings
		this.setupSyncInterval();
	}

	/**
	 * Loads the plugin settings from storage or uses default values.
	 * Initializes the Octokit instance with the GitHub token from settings.
	 * Sets up the synchronization interval based on the loaded settings.
	 *
	 * @returns {Promise<void>} A promise that resolves when settings are loaded and setup is complete.
	 */
	async loadSettings(): Promise<void> {
		// Load settings from storage or use default values
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<GitHubPublisherSettings>,
		);

		// Trigger the settings change handler
		this.onSettingsChange();
	}

	/**
	 * Saves the current settings to storage, triggers the settings change handler,
	 * and refreshes the settings tab if it is active.
	 *
	 * @returns {Promise<void>} A promise that resolves when the settings have been saved and UI updated.
	 */
	async saveSettings(): Promise<void> {
		// Save settings to storage
		await this.saveData(this.settings);

		// Trigger the settings change handler
		this.onSettingsChange();
	}
}

// Settings tab class for the GitHub Publisher plugin
class GitHubPublisherSettingTab extends PluginSettingTab {
	plugin: GitHubPublisherPlugin; // Plugin instance
	active = false; // Whether the settings tab is currently active

	/**
	 * Creates an instance of the class.
	 * @param app - The application instance.
	 * @param plugin - The GitHubPublisherPlugin instance.
	 */
	constructor(app: App, plugin: GitHubPublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Displays the settings UI for the plugin.
	 *
	 * This method populates the container element with various settings fields:
	 * - GitHub Token (password input)
	 * - Repository URL
	 * - Target folder in the repository
	 * - Multi-select for notes/folders to export
	 * - Sync interval (in minutes)
	 * - Button to trigger immediate synchronization
	 *
	 * If a last sync date exists, it displays the last synchronization time.
	 *
	 * @returns {void}
	 */
	display(): void {
		this.active = true;
		const { containerEl } = this;
		containerEl.empty();

		// GitHub token input
		new Setting(containerEl)
			.setName("GitHub token")
			.setDesc("Personal token with write access to the repo.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.githubToken).onChange(
					async (value) => {
						this.plugin.settings.githubToken = value;
						await this.plugin.saveSettings();
					},
				);
			});

		// GitHub repository URL input
		new Setting(containerEl)
			.setName("Repository URL")
			.setDesc("Ex: https://github.com/yourusername/yourrepo")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.repoUrl)
					.onChange(async (value) => {
						this.plugin.settings.repoUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		// Target folder in the repository input
		new Setting(containerEl)
			.setName("Target folder in the repo")
			.setDesc(
				"Relative path in the repo where to place the notes (empty for root folder).",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.repoFolder)
					.onChange(async (value) => {
						this.plugin.settings.repoFolder = value;
						await this.plugin.saveSettings();
					}),
			);

		// Files/folders to publish from the vault
		new Setting(containerEl)
			.setName("Notes/folders to export")
			.setDesc(
				"Start typing and select from the suggestions. You can add multiple items.",
			)
			.then((setting) => {
				addMultiPathInput(
					setting.controlEl,
					this.app,
					this.plugin.settings.selectedPaths,
					(selected) => {
						this.plugin.settings.selectedPaths = selected;
						void this.plugin.saveSettings();
					},
				);
				return setting;
			});

		// Sync interval input
		new Setting(containerEl)
			.setName("Push interval (min)")
			.setDesc("Push every X minutes (0 to disable periodic push)")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.syncInterval))
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = Number(value);
						await this.plugin.saveSettings();
					}),
			);

		// Force sync button
		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Synchronize now")
				.setCta()
				.onClick(async () => {
					await this.plugin.publishToGitHub();
				}),
		);

		// Last sync date info
		if (this.plugin.settings.lastSyncDate) {
			const info = containerEl.createDiv({
				cls: "github-publisher-last-sync",
			});
			info.textContent =
				"Last synchronization: " +
				new Date(this.plugin.settings.lastSyncDate).toLocaleString();
		}
	}

	/**
	 * Hides the current object by setting its active state to false.
	 */
	hide(): void {
		this.active = false;
	}
}
