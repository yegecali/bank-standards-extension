import { KnowledgeBlock } from "./KnowledgeProvider";
import { log } from "../logger";

export interface NamingRule {
  context: string;
  convention: "camelCase" | "PascalCase" | "UPPER_SNAKE" | "kebab-case" | "snake_case";
  description: string;
}

export interface ProjectStep {
  order: number;
  title: string;
  description: string;
}

/**
 * Extracts naming rules from normalized KnowledgeBlock[].
 * Works with any provider (Confluence, etc.).
 *
 * Supports two formats:
 * 1. Table rows: cells[0]=context, cells[1]=convention, cells[2]=description
 * 2. Paragraph with inline text: "use camelCase for test functions"
 */
export function parseNamingRules(blocks: KnowledgeBlock[]): NamingRule[] {
  const rules: NamingRule[] = [];
  let skipNextRow = false;

  for (const block of blocks) {
    if (block.type === "table") {
      skipNextRow = block.hasColumnHeader ?? true;
      continue;
    }

    if (block.type === "table_row") {
      if (skipNextRow) { skipNextRow = false; continue; }
      const cells = block.cells ?? [];
      if (cells.length >= 3) {
        const convention = detectConvention(cells[1]);
        if (convention) {
          rules.push({ context: cells[0].trim(), convention, description: cells[2].trim() });
        }
      }
      continue;
    }

    if (block.type === "paragraph" && block.text) {
      const inlineRegex =
        /use\s+(camelCase|PascalCase|snake_case|UPPER_SNAKE|kebab-case)\s+for\s+([^\.]+)/gi;
      let match: RegExpExecArray | null;
      while ((match = inlineRegex.exec(block.text)) !== null) {
        rules.push({
          context: match[2].trim(),
          convention: match[1] as NamingRule["convention"],
          description: `Use ${match[1]} for ${match[2].trim()}`,
        });
      }
    }
  }

  return rules;
}

/**
 * Extracts project steps from numbered blocks.
 * Works with any provider.
 */
export function parseProjectSteps(blocks: KnowledgeBlock[]): ProjectStep[] {
  const steps: ProjectStep[] = [];
  let order = 1;

  for (const block of blocks) {
    if (block.type === "numbered" && block.text) {
      const [title, ...rest] = block.text.split(/[:\-–]/);
      steps.push({
        order: order++,
        title: title?.trim() ?? block.text,
        description: rest.join(" ").trim() || block.text,
      });
    }
  }

  return steps;
}

// ─── Prompt Library ──────────────────────────────────────────────────────────

export interface PromptTemplate {
  /** Short slug used to invoke the prompt (e.g. "review", "aaa-pattern") */
  name: string;
  /** One-line description shown in the listing */
  description: string;
  /** The actual prompt text sent to the LLM */
  template: string;
}

/**
 * Parses a knowledge base page into a list of PromptTemplates.
 *
 * Expected page format — each prompt is a section:
 *
 *   ## <name>
 *   <description paragraph>
 *   ```
 *   <template text>
 *   ```
 *
 * The code block is the template. If there is no code block, the first
 * paragraph after the heading is used as both description and template.
 */
export function parsePromptLibrary(blocks: KnowledgeBlock[]): PromptTemplate[] {
  const prompts: PromptTemplate[] = [];
  let current: Partial<PromptTemplate> | null = null;

  log(`[parsePromptLibrary] Starting — total blocks: ${blocks.length}`);
  log(`[parsePromptLibrary] Block types: ${blocks.map((b) => b.type).join(", ")}`);

  const flush = () => {
    if (current?.name && current.template) {
      log(`[parsePromptLibrary] ✅ Prompt saved — name: "${current.name}", desc: "${(current.description ?? "").slice(0, 40)}…", template: ${current.template.length} chars`);
      prompts.push({
        name: current.name,
        description: current.description ?? current.template.slice(0, 80),
        template: current.template,
      });
    } else if (current?.name) {
      log(`[parsePromptLibrary] ⚠️ Skipped "${current.name}" — missing: ${!current.template ? "code block (template)" : ""}${!current.description ? " description" : ""}`);
    }
    current = null;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    log(`[parsePromptLibrary] Block[${i}] type="${block.type}" text="${(block.text ?? "").slice(0, 60)}"`);

    if (block.type === "heading2" && block.text) {
      flush();
      // Strip common Confluence prefixes like "Prompts: " or "Prompt - "
      // and remove special characters that would break the slug
      const name = block.text
        .trim()
        .toLowerCase()
        .replace(/^prompts?\s*[:\-–]\s*/i, "")   // remove "Prompts: " prefix
        .replace(/[^\w\s-]/g, "")                 // remove special chars
        .trim()
        .replace(/\s+/g, "-");                    // spaces to hyphens
      log(`[parsePromptLibrary] 📌 H2 detected → raw: "${block.text.trim()}" → slug: "${name}"`);
      current = { name };
      continue;
    }

    if (block.type === "heading1" || block.type === "heading3") {
      log(`[parsePromptLibrary] ⚠️ Heading NOT H2 (type="${block.type}") — ignoring. Use Heading 2 to start a prompt.`);
    }

    if (!current) {
      log(`[parsePromptLibrary] Block[${i}] skipped — no active H2 heading above it`);
      continue;
    }

    if (block.type === "code" && block.text) {
      if (!current.template) {
        current.template = block.text.trim();
        log(`[parsePromptLibrary] 💻 Code block → template set for "${current.name}": ${current.template.length} chars`);
      }
      continue;
    }

    if (block.type === "paragraph" && block.text) {
      const text = block.text.trim();
      if (!current.description) {
        current.description = text;
        log(`[parsePromptLibrary] 📝 Description set for "${current.name}": "${text.slice(0, 60)}"`);
      } else if (!current.template) {
        // No code block yet — start building template from paragraphs
        current.template = text;
        log(`[parsePromptLibrary] 📄 Template started from paragraph for "${current.name}": "${text.slice(0, 60)}"`);
      } else {
        // Accumulate subsequent paragraphs into the template
        current.template += "\n" + text;
        log(`[parsePromptLibrary] 📄 Template appended paragraph for "${current.name}" (+${text.length} chars)`);
      }
      continue;
    }

    if ((block.type === "bullet" || block.type === "numbered") && block.text) {
      const text = block.text.trim();
      if (current.template !== undefined) {
        current.template += "\n- " + text;
        log(`[parsePromptLibrary] 📄 Template appended bullet for "${current.name}"`);
      }
      continue;
    }

    log(`[parsePromptLibrary] Block[${i}] type="${block.type}" ignored inside prompt "${current.name}"`);
  }

  flush();
  log(`[parsePromptLibrary] Done — ${prompts.length} prompts parsed: [${prompts.map((p) => p.name).join(", ")}]`);
  return prompts;
}

// ─── Shared block → Markdown renderer ────────────────────────────────────────

/**
 * Converts provider-agnostic KnowledgeBlock[] to Markdown text.
 * Used by the agent, the LLM tools, and the prompt library handler.
 */
export function blocksToMarkdown(blocks: KnowledgeBlock[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const text = block.type === "table_row"
      ? (block.cells ?? []).join(" | ")
      : (block.text ?? "");
    if (!text && block.type !== "divider") continue;

    switch (block.type) {
      case "heading1":  lines.push(`# ${text}`);  break;
      case "heading2":  lines.push(`## ${text}`); break;
      case "heading3":  lines.push(`### ${text}`); break;
      case "bullet":    lines.push(`- ${text}`);  break;
      case "numbered":  lines.push(`1. ${text}`); break;
      case "code":      lines.push(`\`\`\`${block.language ?? ""}\n${text}\n\`\`\``); break;
      case "divider":   lines.push("---"); break;
      case "table_row": lines.push(text); break;
      default:          lines.push(text);
    }
  }

  return lines.join("\n");
}

function detectConvention(text: string): NamingRule["convention"] | null {
  const lower = text.toLowerCase();
  if (lower.includes("camelcase")) return "camelCase";
  if (lower.includes("pascalcase")) return "PascalCase";
  if (lower.includes("upper_snake") || lower.includes("screaming")) return "UPPER_SNAKE";
  if (lower.includes("kebab")) return "kebab-case";
  if (lower.includes("snake_case")) return "snake_case";
  return null;
}
