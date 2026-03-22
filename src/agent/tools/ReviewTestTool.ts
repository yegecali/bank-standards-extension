import * as vscode from "vscode";
import { createKnowledgeProvider } from "../../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../../notion/parser";
import { resolvePageId } from "../specialtyResolver";

export interface ReviewTestInput {
  /** Optional specialty override (e.g. "frontend", "backend", "qa") */
  specialty?: string;
}

/**
 * LM Tool: reads the active editor file and fetches the bank's test standards,
 * providing both as context so the LLM can perform a review.
 * Available in Copilot agent mode — invoked automatically when the user
 * asks to review, analyze, or validate a test file.
 */
export class ReviewTestTool implements vscode.LanguageModelTool<ReviewTestInput> {
  constructor(_context: vscode.ExtensionContext) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReviewTestInput>
  ): vscode.PreparedToolInvocation {
    const editor        = vscode.window.activeTextEditor;
    const fileName      = editor?.document.fileName.split("/").pop() ?? "active file";
    const specialtyLabel = options.input.specialty ? ` [${options.input.specialty}]` : "";
    return {
      invocationMessage: `Leyendo "${fileName}" y estándares de tests${specialtyLabel}…`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReviewTestInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    // 1 — Active editor file
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return result(
        "No active file found. Open the test file you want to review in the editor first."
      );
    }

    const fileName    = editor.document.fileName.split("/").pop() ?? "file";
    const langId      = editor.document.languageId;
    const fileContent = editor.document.getText();

    // 2 — Testing standards from knowledge source (specialty-aware)
    const { specialty } = options.input;
    const pageId = resolvePageId("testing", specialty);

    if (!pageId) {
      return result(
        `File to review:\n\`\`\`${langId}\n${fileContent}\n\`\`\`\n\n` +
        "Note: No 'testing' page configured. " +
        "Add it to companyStandards.specialtiesMap.<specialty>.testing (or legacy pagesMap). " +
        "Review based on general best practices (Triple AAA pattern)."
      );
    }

    try {
      const provider  = createKnowledgeProvider();
      const page      = await provider.getPage(pageId);
      const standards = blocksToMarkdown(page.blocks);

      return result(
        `# Test Review Context\n\n` +
        `## Standards: ${page.title}\n\n` +
        standards +
        `\n\n---\n\n` +
        `## File to review: \`${fileName}\`\n\n` +
        `\`\`\`${langId}\n${fileContent}\n\`\`\`\n\n` +
        `Analyze the file line-by-line against the standards above. ` +
        `List each violation with: line number, rule violated, and suggested fix. ` +
        `End with a checklist summary (✅/❌ per rule).`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return result(`Error loading test standards: ${msg}`);
    }
  }
}

function result(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
