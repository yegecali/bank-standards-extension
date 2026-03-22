import * as vscode from "vscode";
import { KnowledgeBlock, KnowledgeProvider } from "../knowledge/KnowledgeProvider";
import { log } from "../logger";

export interface CacheEntry<T> {
  pageId: string;
  pageTitle: string;
  /** ISO 8601 from the provider's last-modified date — used for invalidation */
  lastModified: string;
  data: T;
}

const CACHE_KEY_PREFIX = "companyStandards.cache.";

/**
 * Resolves data for a knowledge page using a two-step strategy:
 *
 * 1. Check globalState for a cached entry.
 * 2. Fetch only page metadata (lastModified) — lightweight, no content.
 * 3. If the date matches the cache → return cached data.
 * 4. If the page changed (or no cache) → fetch full blocks, parse, store, return.
 *
 * Works with any KnowledgeProvider (Notion, Confluence, etc.).
 */
export async function resolveWithCache<T>(
  context: vscode.ExtensionContext,
  pageId: string,
  provider: KnowledgeProvider,
  parse: (blocks: KnowledgeBlock[]) => T,
  source: string
): Promise<{ data: T; pageTitle: string; fromCache: boolean }> {
  const key = `${CACHE_KEY_PREFIX}${pageId}`;
  const cached = context.globalState.get<CacheEntry<T>>(key);

  // Step 1 — lightweight metadata check
  const meta = await provider.getPageMetadata(pageId);

  if (cached && cached.lastModified === meta.lastModified) {
    log(`[${source}] Cache hit for page "${meta.title}" (${pageId}) via ${provider.name}`);
    return { data: cached.data, pageTitle: meta.title, fromCache: true };
  }

  // Step 2 — cache miss or page updated
  log(
    `[${source}] Cache miss for "${meta.title}" via ${provider.name} — ` +
      (cached
        ? `page updated (${cached.lastModified} → ${meta.lastModified})`
        : "no cache entry")
  );

  const page = await provider.getPage(pageId);
  const data = parse(page.blocks);

  const entry: CacheEntry<T> = {
    pageId,
    pageTitle: page.title,
    lastModified: meta.lastModified,
    data,
  };

  await context.globalState.update(key, entry);

  return { data, pageTitle: page.title, fromCache: false };
}

/**
 * Removes all cached entries from globalState.
 * Called when the user runs "Bank: Refresh Standards" manually.
 */
export async function clearCache(context: vscode.ExtensionContext): Promise<void> {
  const keys = context.globalState.keys().filter((k) => k.startsWith(CACHE_KEY_PREFIX));
  await Promise.all(keys.map((k) => context.globalState.update(k, undefined)));
}
