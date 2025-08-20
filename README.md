# Obsidian GitHub Publisher

**Obsidian GitHub Publisher** is a plugin for [Obsidian](https://obsidian.md/) that lets you automatically or manually **publish** selected notes and folders from your vault to a folder in a GitHub repository.

This plugin is ideal for publishing notes for use with a static site generator, or backing up part of your vault to GitHub.

## Features

- **Selective publishing:** Choose specific notes and folders to export.
- **Configurable destination:** Publish to any folder in any branch of your repository.
- **Manual and automatic publishing:** Trigger export manually or on an interval.
- **Overwrites remote folder:** The target folder in your repository will always match your selected local notes/folders.
- **No external servers:** All operations happen directly from your device to GitHub.

## Configuration

Open the plugin settings from `Settings` → `GitHub Publisher`. Configure the following:

- **GitHub Token:**  
  A [GitHub Personal Access Token](https://github.com/settings/tokens) with `repo` (and/or `public_repo`) permissions.

- **Repository URL:**  
  Full URL to your GitHub repository (e.g., `https://github.com/yourusername/yourrepo`).

- **Target folder in the repo:**  
  Relative path inside your repository where notes will be placed (leave empty to use the root).

- **Branch:**  
  The branch to push changes to (default: `main`).

- **Notes/folders to export:**  
  The notes or folders you want to push to your repo.

- **Publish interval (min):**  
  How often to publish automatically (0 to disable periodic publishing).

## Usage

- **Manual Publishing:**  
  Use the command palette (`Cmd/Ctrl + P` → "Publish to GitHub now") or the "Synchronize now" button in the settings.

- **Automatic Publishing:**  
  If an interval is set, the plugin will periodically export your selected notes/folders.

- **Status:**  
  The last successful export time is displayed in the settings.

## Important Behavior

> **One-way export:**  
> This plugin performs a **one-way publish** from Obsidian to GitHub.  
> The contents of the selected notes/folders will **overwrite** the target folder in your GitHub repository on each publish.  
> Any files in the target GitHub folder that are not present locally will be **deleted**.  
> This is **not a two-way sync**—changes made on GitHub are not imported back into Obsidian.

## How It Works

- The plugin collects all selected notes/folders and their contents.
- It uses the GitHub API to create, update, or delete files in your specified repo folder and branch.
- The remote folder is overwritten to match your selection (additions, updates, deletions).
- Commits are made with the author `Obsidian GitHub Publisher`.

## Security & Privacy

- Your GitHub token is stored locally in your Obsidian vault settings.
- All publishing operations happen from your device directly to GitHub. No data is sent to third-party servers.
- **Never share your token or publish your settings file.**
