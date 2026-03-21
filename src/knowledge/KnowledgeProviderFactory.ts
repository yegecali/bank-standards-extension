import * as vscode from "vscode";
import { KnowledgeProvider } from "./KnowledgeProvider";
import { NotionKnowledgeProvider } from "./providers/NotionKnowledgeProvider";
import { ConfluenceKnowledgeProvider } from "./providers/ConfluenceKnowledgeProvider";

export type KnowledgeSourceType = "notion" | "confluence";

let cachedProvider: KnowledgeProvider | null = null;
let cachedSource: string | null = null;

/**
 * Returns a singleton KnowledgeProvider for the configured knowledge source.
 * The instance is reused across requests unless the source setting changes.
 * Call resetKnowledgeProvider() to force recreation (e.g. after settings change).
 */
export function createKnowledgeProvider(): KnowledgeProvider {
  const config = vscode.workspace.getConfiguration("bankStandards");
  const source = (config.get<string>("knowledgeSource") ?? "notion") as KnowledgeSourceType;

  if (cachedProvider && cachedSource === source) {
    return cachedProvider;
  }

  console.log(`[KnowledgeProviderFactory] Creating provider for source: "${source}"`);

  switch (source) {
    case "notion":
      cachedProvider = new NotionKnowledgeProvider();
      break;
    case "confluence":
      cachedProvider = new ConfluenceKnowledgeProvider();
      break;
    default:
      console.warn(`[KnowledgeProviderFactory] Unknown source "${source}", falling back to Notion`);
      cachedProvider = new NotionKnowledgeProvider();
  }

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
  console.log("[KnowledgeProviderFactory] Provider cache cleared");
}
