import { ConfluenceClient, AdfNode } from "../../confluence/client";
import {
  KnowledgeBlock,
  KnowledgePage,
  KnowledgePageMeta,
  KnowledgeProvider,
} from "../KnowledgeProvider";

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
}

// ─── ADF → KnowledgeBlock conversion ─────────────────────────────────────────

/**
 * Converts an array of ADF (Atlassian Document Format) nodes into
 * provider-agnostic KnowledgeBlock[].
 *
 * ADF reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */
function adfToBlocks(nodes: AdfNode[]): KnowledgeBlock[] {
  const blocks: KnowledgeBlock[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "heading": {
        const level = (node.attrs?.level as number) ?? 1;
        const type  = level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3";
        blocks.push({ type, text: extractText(node) });
        break;
      }

      case "paragraph": {
        const text = extractText(node);
        if (text) blocks.push({ type: "paragraph", text });
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
        if (text) blocks.push({ type: "code", text, language: lang });
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

      // Recurse into block containers (e.g. expand, panel, layoutSection)
      case "expand":
      case "nestedExpand":
      case "panel":
      case "layoutSection":
      case "layoutColumn":
      case "blockquote": {
        blocks.push(...adfToBlocks(node.content ?? []));
        break;
      }

      default:
        // Unknown node — try to extract text as a fallback paragraph
        if (node.content) {
          const text = extractText(node);
          if (text) blocks.push({ type: "paragraph", text });
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
