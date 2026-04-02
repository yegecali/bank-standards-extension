import { ConfluenceClient, AdfNode } from "../../confluence/client";
import {
  KnowledgeBlock,
  KnowledgePage,
  KnowledgePageMeta,
  KnowledgeProvider,
} from "../KnowledgeProvider";
import { log } from "../../logger";

export class ConfluenceKnowledgeProvider implements KnowledgeProvider {
  readonly name = "Confluence";
  private client: ConfluenceClient;

  constructor() {
    this.client = new ConfluenceClient();
  }

  async getPageMetadata(pageId: string): Promise<KnowledgePageMeta> {
    const meta = await this.client.getPageMetadata(pageId);
    return {
      id:           meta.id,
      title:        meta.title,
      lastModified: meta.lastModified,
    };
  }

  async getPage(pageId: string): Promise<KnowledgePage> {
    const page = await this.client.getPage(pageId);
    return {
      id:     page.id,
      title:  page.title,
      blocks: adfToBlocks(page.adf.content ?? []),
    };
  }

  async getChildPages(pageId: string): Promise<KnowledgePageMeta[]> {
    const children = await this.client.getChildPages(pageId);
    return children.map((c) => ({
      id:           c.id,
      title:        c.title,
      lastModified: "",
    }));
  }
}

// ─── ADF → KnowledgeBlock conversion ─────────────────────────────────────────

/**
 * Converts an array of ADF (Atlassian Document Format) nodes into
 * provider-agnostic KnowledgeBlock[].
 *
 * ADF reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */
function adfToBlocks(nodes: AdfNode[], depth = 0): KnowledgeBlock[] {
  const blocks: KnowledgeBlock[] = [];
  const indent = "  ".repeat(depth);

  for (const node of nodes) {
    log(`[adfToBlocks]${indent} node.type="${node.type}"${node.attrs ? ` attrs=${JSON.stringify(node.attrs)}` : ""}`);

    switch (node.type) {
      case "heading": {
        const level = (node.attrs?.level as number) ?? 1;
        const type  = level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3";
        const text  = extractText(node);
        log(`[adfToBlocks]${indent} → ${type}: "${text}"`);
        blocks.push({ type, text });
        break;
      }

      case "paragraph": {
        const text = extractText(node);
        if (text) {
          log(`[adfToBlocks]${indent} → paragraph: "${text.slice(0, 60)}"`);
          blocks.push({ type: "paragraph", text });
        }
        break;
      }

      case "bulletList": {
        for (const item of node.content ?? []) {
          const text = extractText(item);
          if (text) blocks.push({ type: "bullet", text });
        }
        break;
      }

      case "orderedList": {
        for (const item of node.content ?? []) {
          const text = extractText(item);
          if (text) blocks.push({ type: "numbered", text });
        }
        break;
      }

      case "codeBlock": {
        const lang = (node.attrs?.language as string | undefined) ?? "plain";
        const text = extractText(node);
        if (text) {
          log(`[adfToBlocks]${indent} → code block (lang=${lang}): ${text.length} chars`);
          blocks.push({ type: "code", text, language: lang });
        }
        break;
      }

      case "rule": {
        blocks.push({ type: "divider", text: "" });
        break;
      }

      case "table": {
        blocks.push({ type: "table", text: "", hasColumnHeader: true });
        for (const row of node.content ?? []) {
          if (row.type === "tableRow") {
            const cells = (row.content ?? []).map((cell) => extractText(cell));
            blocks.push({ type: "table_row", text: "", cells });
          }
        }
        break;
      }

      // ── expand / nestedExpand ─────────────────────────────────────────────
      // The expand title can act as a prompt name (heading2), so we emit it
      // before recursing into the body content.
      case "expand":
      case "nestedExpand": {
        const title = (node.attrs?.title as string | undefined)?.trim();
        if (title) {
          log(`[adfToBlocks]${indent} → expand title as heading2: "${title}"`);
          blocks.push({ type: "heading2", text: title });
        }
        blocks.push(...adfToBlocks(node.content ?? [], depth + 1));
        break;
      }

      // ── panel (Info / Note / Warning / Tip / Success boxes) ──────────────
      // Panels can contain headings, paragraphs, and code blocks.
      // We emit a heading3 with the panel type as context, then recurse.
      case "panel": {
        const panelType = (node.attrs?.panelType as string | undefined) ?? "info";
        log(`[adfToBlocks]${indent} → panel (type=${panelType}), recursing into ${(node.content ?? []).length} children`);
        blocks.push(...adfToBlocks(node.content ?? [], depth + 1));
        break;
      }

      // ── bodiedExtension — Confluence block macros ────────────────────────
      // Examples: legacy "Code" macro, "Excerpt", "Section", custom macros.
      // If the extensionKey is "code", treat body text as a code block.
      // Otherwise recurse into content.
      case "bodiedExtension": {
        const extKey  = (node.attrs?.extensionKey as string | undefined) ?? "";
        const macroParams = (node.attrs?.parameters as Record<string, unknown> | undefined)?.macroParams as Record<string, unknown> | undefined;
        const lang    = (macroParams?.language as Record<string, string> | undefined)?.value ?? "plain";
        log(`[adfToBlocks]${indent} → bodiedExtension extensionKey="${extKey}"`);

        if (extKey === "code") {
          const text = extractText(node);
          if (text) {
            log(`[adfToBlocks]${indent}   → legacy Code macro → code block (lang=${lang}): ${text.length} chars`);
            blocks.push({ type: "code", text, language: lang });
          }
        } else {
          // Generic macro — recurse into body content
          blocks.push(...adfToBlocks(node.content ?? [], depth + 1));
        }
        break;
      }

      // ── inlineExtension / extension — inline macros ───────────────────────
      // Usually status badges, dates, etc. Extract any text as paragraph.
      case "inlineExtension":
      case "extension": {
        const text = extractText(node);
        if (text) blocks.push({ type: "paragraph", text });
        break;
      }

      // ── plain layout and quote containers ────────────────────────────────
      case "layoutSection":
      case "layoutColumn":
      case "blockquote": {
        blocks.push(...adfToBlocks(node.content ?? [], depth + 1));
        break;
      }

      default:
        log(`[adfToBlocks]${indent} ⚠️ unhandled node type="${node.type}" — ${node.content ? "recursing" : "skipping"}`);
        if (node.content) {
          blocks.push(...adfToBlocks(node.content, depth + 1));
        }
        break;
    }
  }

  return blocks;
}

/**
 * Recursively extracts all plain text from an ADF node tree.
 */
function extractText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";

  // listItem wraps a paragraph — go one level deeper
  if (node.type === "listItem") {
    return (node.content ?? []).map(extractText).join(" ").trim();
  }

  return (node.content ?? []).map(extractText).join("").trim();
}
