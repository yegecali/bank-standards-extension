/**
 * Provider-agnostic abstraction for any knowledge source.
 * Implementations: NotionKnowledgeProvider, ConfluenceKnowledgeProvider, etc.
 */

export type KnowledgeBlockType =
  | "heading1" | "heading2" | "heading3"
  | "paragraph" | "code"
  | "bullet" | "numbered"
  | "table" | "table_row"
  | "divider" | "unknown";

export interface KnowledgeBlock {
  type: KnowledgeBlockType;
  /** Plain text content of the block (optional for table/divider blocks) */
  text?: string;
  /** Only for type="code" */
  language?: string;
  /** Only for type="table_row" — one string per cell */
  cells?: string[];
  /** Only for type="table" — whether first row is header */
  hasColumnHeader?: boolean;
}

export interface KnowledgePage {
  id: string;
  title: string;
  blocks: KnowledgeBlock[];
}

export interface KnowledgePageMeta {
  id: string;
  title: string;
  /** ISO 8601 — used for cache invalidation */
  lastModified: string;
}

export interface KnowledgeProvider {
  /** Human-readable name shown in logs and UI (e.g. "Notion", "Confluence") */
  readonly name: string;
  /** Lightweight call — returns only metadata, no content */
  getPageMetadata(pageId: string): Promise<KnowledgePageMeta>;
  /** Full call — returns metadata + all blocks */
  getPage(pageId: string): Promise<KnowledgePage>;
}
