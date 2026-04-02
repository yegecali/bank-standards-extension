import * as vscode from "vscode";
import { KnowledgeProvider } from "./KnowledgeProvider";
import { ConfluenceKnowledgeProvider } from "./providers/ConfluenceKnowledgeProvider";
import { log } from "../logger";

export type KnowledgeSourceType = "confluence";

let cachedProvider: KnowledgeProvider | null = null;
let cachedSource: string | null = null;

/**
 * Returns a singleton KnowledgeProvider for the configured knowledge source.
 * The instance is reused across requests unless the source setting changes.
 * Call resetKnowledgeProvider() to force recreation (e.g. after settings change).
 */
export function createKnowledgeProvider(): KnowledgeProvider {
  const config = vscode.workspace.getConfiguration("companyStandards");
  const source = (config.get<string>("knowledgeSource") ?? "confluence") as KnowledgeSourceType;

  if (cachedProvider && cachedSource === source) {
    return cachedProvider;
  }

  log(`[KnowledgeProviderFactory] Creating provider for source: "${source}"`);

  cachedProvider = new ConfluenceKnowledgeProvider();
  cachedSource = source;
  return cachedProvider;
}

/**
 * Clears the cached provider instance.
 * Should be called when knowledge source settings change.
 */
export function resetKnowledgeProvider(): void {
  cachedProvider = null;
  cachedSource = null;
  log("[KnowledgeProviderFactory] Provider cache cleared");
}
