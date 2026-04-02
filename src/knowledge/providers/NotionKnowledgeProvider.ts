import { NotionClient, NotionBlock } from "../../notion/client";
import {
  KnowledgeBlock,
  KnowledgeBlockType,
  KnowledgePage,
  KnowledgePageMeta,
  KnowledgeProvider,
} from "../KnowledgeProvider";

export class NotionKnowledgeProvider implements KnowledgeProvider {
  readonly name = "Notion";
  private client: NotionClient;

  constructor() {
    this.client = new NotionClient();
  }

  async getPageMetadata(pageId: string): Promise<KnowledgePageMeta> {
    const meta = await this.client.getPageMetadata(pageId);
    return {
      id: meta.id,
      title: meta.title,
      lastModified: meta.lastModified,
    };
  }

  async getPage(pageId: string): Promise<KnowledgePage> {
    const page = await this.client.getPage(pageId);
    return {
      id: page.id,
      title: page.title,
      blocks: page.blocks.map(toKnowledgeBlock),
    };
  }
}

// ─── Notion → KnowledgeBlock conversion ─────────────────────────────────────

function toKnowledgeBlock(block: NotionBlock): KnowledgeBlock {
  const type = block.type;
  const content = (block[type] as Record<string, unknown>) ?? {};

  type RichTextArray = Array<{ plain_text: string }>;
  const richText = content.rich_text as RichTextArray | undefined;

  switch (type) {
    case "heading_1":
      return { type: "heading1", text: rt(richText) };
    case "heading_2":
      return { type: "heading2", text: rt(richText) };
    case "heading_3":
      return { type: "heading3", text: rt(richText) };
    case "paragraph":
      return { type: "paragraph", text: rt(richText) };
    case "bulleted_list_item":
      return { type: "bullet", text: rt(richText) };
    case "numbered_list_item":
      return { type: "numbered", text: rt(richText) };
    case "code":
      return {
        type: "code",
        text: rt(richText),
        language: (content.language as string | undefined) ?? "plain",
      };
    case "table":
      return {
        type: "table",
        text: "",
        hasColumnHeader: (content.has_column_header as boolean | undefined) ?? true,
      };
    case "table_row":
      return {
        type: "table_row",
        text: "",
        cells: ((content.cells ?? []) as Array<Array<{ plain_text: string }>>).map((cell) =>
          cell.map((t) => t.plain_text).join("")
        ),
      };
    case "divider":
      return { type: "divider", text: "" };
    default:
      return { type: "unknown", text: rt(richText) };
  }
}

function rt(richText: Array<{ plain_text: string }> | undefined): string {
  return (richText ?? []).map((t) => t.plain_text).join("");
}
