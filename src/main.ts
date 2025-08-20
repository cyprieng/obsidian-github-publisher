import { addMultiPathInput } from "./multi-path-input";
import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	TFile,
	TFolder,
	Notice,
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

// Parse the GitHub repository URL to extract owner and repo name
function parseRepoUrl(repoUrl: string) {
	const m = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/i);
	if (!m) throw new Error("URL de repo GitHub invalide");
	return { owner: m[1], repo: m[2] };
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
			id: "github-publisher-now",
			name: "Publish to GitHub now",
			callback: () => this.publishToGitHub(),
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
				() => this.publishToGitHub(),
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
				new Notice("GitHub Publisher: invalid settings");
				return;
			}

			// Retrieve owner and repo from the URL, branch, and folder settings
			const { owner, repo } = parseRepoUrl(this.settings.repoUrl);
			const branch = this.settings.repoBranch;
			const repoFolder = this.settings.repoFolder.replace(/^\/|\/$/g, "");
			const pathsToSync = this.settings.selectedPaths;
			const localFiles: {
				vaultPath: string;
				repoPath: string;
				content: string;
			}[] = [];

			// Gather local files (vaultPath: path in vault, repoPath: path in repo)
			for (const path of pathsToSync) {
				const fileOrFolder = this.app.vault.getAbstractFileByPath(path);
				if (fileOrFolder instanceof TFile) {
					const content = await this.app.vault.read(fileOrFolder);
					localFiles.push({
						vaultPath: fileOrFolder.path,
						repoPath: repoFolder
							? `${repoFolder}/${fileOrFolder.path}`
							: fileOrFolder.path,
						content,
					});
				} else if (fileOrFolder instanceof TFolder) {
					const files = this.getAllFilesInFolder(fileOrFolder);
					for (const f of files) {
						const content = await this.app.vault.read(f);
						localFiles.push({
							vaultPath: f.path,
							repoPath: repoFolder
								? `${repoFolder}/${f.path}`
								: f.path,
							content,
						});
					}
				}
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
				const remoteSha = remoteFiles.get(file.repoPath);
				const localSha = await this.gitBlobSha1(file.content);

				if (localSha !== remoteSha) {
					tree.push({
						path: file.repoPath,
						mode: "100644",
						type: "blob",
						content: file.content,
					});
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
			new Notice("GitHub Publisher: error during publish : " + e.message);
		}
	}

	/**
	 * Computes the Git blob SHA-1 hash for the given content string.
	 *
	 * This method encodes the content as UTF-8, constructs the Git blob header,
	 * concatenates the header and content, and then computes the SHA-1 hash
	 * according to the Git object format.
	 *
	 * @param content - The content to hash as a Git blob.
	 * @returns A promise that resolves to the SHA-1 hash as a hexadecimal string.
	 */
	async gitBlobSha1(content: string): Promise<string> {
		// Convert to UTF-8 bytes
		const encoder = new TextEncoder();
		const contentBytes = encoder.encode(content);
		const header = `blob ${contentBytes.length}\0`;
		const headerBytes = encoder.encode(header);

		// Concatenate header + content
		const blob = new Uint8Array(headerBytes.length + contentBytes.length);
		blob.set(headerBytes, 0);
		blob.set(contentBytes, headerBytes.length);

		// SHA1 hash
		const hashBuffer = await window.crypto.subtle.digest("SHA-1", blob);

		// Convert hash to hex string
		return Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/**
	 * Recursively retrieves all files within a given folder and its subfolders.
	 * @param folder - The folder to search for files.
	 * @returns An array of TFile objects found within the folder and its subfolders.
	 */
	getAllFilesInFolder(folder: TFolder): TFile[] {
		let files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile) files.push(child);
			else if (child instanceof TFolder)
				files = files.concat(this.getAllFilesInFolder(child));
		}
		return files;
	}

	async onSettingsChange() {
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
			await this.loadData(),
		);

		// Trigger the settings change handler
		await this.onSettingsChange();
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
		await this.onSettingsChange();

		// Refresh the settings tab if it is active (to have the date updated)
		if (this.settingTab && this.settingTab.active) {
			this.settingTab.display();
		}
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
			.setName("GitHub Token")
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
					async (selected) => {
						this.plugin.settings.selectedPaths = selected;
						await this.plugin.saveSettings();
					},
				);
				return setting;
			});

		// Sync interval input
		new Setting(containerEl)
			.setName("Sync interval (min)")
			.setDesc("Every X minutes (0 to disable periodic sync)")
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
			const info = containerEl.createEl("div");
			info.style.textAlign = "right";
			info.style.opacity = "0.7";
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
