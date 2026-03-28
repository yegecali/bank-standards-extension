import { AdfNode } from "./client";

/**
 * Converts an array of ADF nodes to plain text suitable for LLM consumption.
 * Preserves heading hierarchy, lists, and code blocks with language hints.
 */
export function adfBlocksToText(nodes: AdfNode[], depth = 0): string {
  const parts: string[] = [];
  const indent = "  ".repeat(depth);

  for (const node of nodes) {
    switch (node.type) {
      case "heading": {
        const level  = (node.attrs?.level as number) ?? 1;
        const prefix = "#".repeat(Math.min(level, 3));
        parts.push(`${prefix} ${extractText(node)}`);
        break;
      }
      case "paragraph": {
        const text = extractText(node);
        if (text) parts.push(text);
        break;
      }
      case "bulletList":
      case "orderedList": {
        for (const item of node.content ?? []) {
          parts.push(`${indent}- ${extractText(item)}`);
        }
        break;
      }
      case "codeBlock": {
        const lang = (node.attrs?.language as string | undefined) ?? "";
        parts.push(`\`\`\`${lang}\n${extractText(node)}\n\`\`\``);
        break;
      }
      case "rule":
        parts.push("---");
        break;
      case "table": {
        for (const row of node.content ?? []) {
          if (row.type === "tableRow") {
            const cells = (row.content ?? []).map((c) => extractText(c));
            parts.push(`| ${cells.join(" | ")} |`);
          }
        }
        break;
      }
      case "expand":
      case "nestedExpand": {
        const title = (node.attrs?.title as string | undefined)?.trim();
        if (title) parts.push(`## ${title}`);
        parts.push(adfBlocksToText(node.content ?? [], depth + 1));
        break;
      }
      default:
        if (node.content) {
          parts.push(adfBlocksToText(node.content, depth));
        }
        break;
    }
  }

  return parts.filter(Boolean).join("\n\n");
}

function extractText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "listItem") {
    return (node.content ?? []).map(extractText).join(" ").trim();
  }
  return (node.content ?? []).map(extractText).join("").trim();
}
