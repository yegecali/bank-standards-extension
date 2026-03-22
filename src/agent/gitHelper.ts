import { execSync } from "child_process";
import * as vscode from "vscode";
import { log, logError } from "../logger";

/**
 * Returns the staged git diff (git diff --cached) for the current workspace.
 * Returns null if there are no staged changes, or if git is unavailable.
 */
export function getStagedDiff(): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return null;
  }
  const cwd = workspaceFolders[0].uri.fsPath;

  try {
    const diff = execSync("git diff --cached", { cwd, encoding: "utf8" });
    log(`[GitHelper] Staged diff: ${diff.length} chars`);
    return diff.trim() || null;
  } catch (err: unknown) {
    logError("[GitHelper] Failed to run git diff --cached", err);
    return null;
  }
}
