import * as vscode from "vscode";
import { createKnowledgeProvider } from "../../knowledge/KnowledgeProviderFactory";
import { parseNamingRules, blocksToMarkdown } from "../../notion/parser";
import { resolveWithCache } from "../../notion/cache";
import { resolvePageId } from "../specialtyResolver";

export interface GetStandardsInput {
  /** Optional topic to focus the query (e.g. "java methods", "constants") */
  topic?: string;
  /** Optional specialty override (e.g. "frontend", "backend", "qa") */
  specialty?: string;
}

/**
 * LM Tool: retrieves bank coding standards from the knowledge source.
 * Available in Copilot agent mode — the LLM invokes this automatically
 * when the user asks about naming conventions or coding standards.
 */
export class GetStandardsTool implements vscode.LanguageModelTool<GetStandardsInput> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetStandardsInput>
  ): vscode.PreparedToolInvocation {
    const { topic, specialty } = options.input;
    const specialtyLabel = specialty ? ` [${specialty}]` : "";
    return {
      invocationMessage: topic
        ? `Consultando estándares${specialtyLabel} sobre "${topic}"…`
        : `Consultando estándares del banco${specialtyLabel}…`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetStandardsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { specialty } = options.input;
    const pageId = resolvePageId("standards", specialty);

    if (!pageId) {
      return result(
        "No standards page configured. " +
        "Add 'standards' to bankStandards.specialtiesMap.<specialty> (or legacy pagesMap) in settings."
      );
    }

    try {
      const provider = createKnowledgeProvider();
      const { pageTitle, fromCache } = await resolveWithCache(
        this.context, pageId, provider, parseNamingRules, "GetStandardsTool"
      );
      const page    = await provider.getPage(pageId);
      const content = blocksToMarkdown(page.blocks);
      const topic   = options.input.topic?.toLowerCase();

      const filtered = topic ? filterByTopic(content, topic) : content;
      const source   = fromCache ? "cache" : provider.name + " live";

      return result(
        `# Bank Standards — ${pageTitle}\n` +
        `> Source: ${source}\n\n` +
        filtered
      );
    } catch (err: any) {
      return result(`Error loading standards: ${err.message}`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns only the sections of the content that mention the topic.
 * Falls back to the full content if no section matches.
 */
function filterByTopic(content: string, topic: string): string {
  const lines    = content.split("\n");
  const sections: string[][] = [];
  let   current: string[]    = [];

  for (const line of lines) {
    if (line.startsWith("#")) {
      if (current.length) sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current);

  const matched = sections.filter((s) =>
    s.join("\n").toLowerCase().includes(topic)
  );

  return matched.length ? matched.map((s) => s.join("\n")).join("\n\n") : content;
}

function result(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
