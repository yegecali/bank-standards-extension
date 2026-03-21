import * as vscode from "vscode";
import { KnowledgeProvider } from "./KnowledgeProvider";
import { NotionKnowledgeProvider } from "./providers/NotionKnowledgeProvider";
import { ConfluenceKnowledgeProvider } from "./providers/ConfluenceKnowledgeProvider";

export type KnowledgeSourceType = "notion" | "confluence";

/**
 * Reads bankStandards.knowledgeSource from settings and returns
 * the matching KnowledgeProvider instance.
 *
 * Defaults to "notion" if not configured.
 */
export function createKnowledgeProvider(): KnowledgeProvider {
  const config = vscode.workspace.getConfiguration("bankStandards");
  const source = (config.get<string>("knowledgeSource") ?? "notion") as KnowledgeSourceType;

  console.log(`[KnowledgeProviderFactory] Creating provider for source: "${source}"`);

  switch (source) {
    case "notion":
      return new NotionKnowledgeProvider();
    case "confluence":
      return new ConfluenceKnowledgeProvider();
    default:
      console.warn(`[KnowledgeProviderFactory] Unknown source "${source}", falling back to Notion`);
      return new NotionKnowledgeProvider();
  }
}
