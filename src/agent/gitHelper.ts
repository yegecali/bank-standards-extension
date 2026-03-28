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

/**
 * Returns the current branch name, or null if unavailable.
 */
export function getCurrentBranch(): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
  const cwd = workspaceFolders[0].uri.fsPath;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
  } catch { return null; }
}

/**
 * Returns the diff of the current branch vs. the base branch (default: main).
 * Uses `git diff <base>...HEAD` — shows only commits introduced by this branch.
 * Returns null if git is unavailable or the base branch doesn't exist.
 */
export function getBranchDiff(baseBranch = "main"): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
  const cwd = workspaceFolders[0].uri.fsPath;
  try {
    const diff = execSync(`git diff ${baseBranch}...HEAD`, { cwd, encoding: "utf8" });
    log(`[GitHelper] Branch diff (${baseBranch}...HEAD): ${diff.length} chars`);
    return diff.trim() || null;
  } catch (err: unknown) {
    // Try origin/main as fallback
    try {
      const diff = execSync(`git diff origin/${baseBranch}...HEAD`, { cwd, encoding: "utf8" });
      log(`[GitHelper] Branch diff (origin/${baseBranch}...HEAD): ${diff.length} chars`);
      return diff.trim() || null;
    } catch {
      logError(`[GitHelper] Failed to get branch diff vs ${baseBranch}`, err);
      return null;
    }
  }
}

/**
 * Returns the list of files changed in the current branch vs. the base branch.
 */
export function getBranchChangedFiles(baseBranch = "main"): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return []; }
  const cwd = workspaceFolders[0].uri.fsPath;
  try {
    const out = execSync(`git diff ${baseBranch}...HEAD --name-only`, { cwd, encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    try {
      const out = execSync(`git diff origin/${baseBranch}...HEAD --name-only`, { cwd, encoding: "utf8" });
      return out.trim().split("\n").filter(Boolean);
    } catch { return []; }
  }
}

/**
 * Returns commit log of the current branch vs. the base branch.
 */
export function getBranchCommitLog(baseBranch = "main"): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
  const cwd = workspaceFolders[0].uri.fsPath;
  try {
    return execSync(
      `git log ${baseBranch}..HEAD --oneline --no-merges`,
      { cwd, encoding: "utf8" }
    ).trim() || null;
  } catch {
    try {
      return execSync(
        `git log origin/${baseBranch}..HEAD --oneline --no-merges`,
        { cwd, encoding: "utf8" }
      ).trim() || null;
    } catch { return null; }
  }
}
