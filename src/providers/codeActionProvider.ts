import * as vscode from "vscode";

export class BankStandardsCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((d) => d.source === "Bank Standards")
      .flatMap((diagnostic) => this.buildActions(document, diagnostic));
  }

  private buildActions(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction[] {
    const suggestion = this.extractSuggestion(diagnostic.message);
    if (!suggestion) return [];

    const currentName = document.getText(diagnostic.range);
    const actions: vscode.CodeAction[] = [];

    // --- Action 1: Fix in current file ---
    const fixInFile = new vscode.CodeAction(
      `Rename to "${suggestion}" (Bank Standard)`,
      vscode.CodeActionKind.QuickFix
    );
    fixInFile.diagnostics = [diagnostic];
    fixInFile.isPreferred = true;
    fixInFile.edit = new vscode.WorkspaceEdit();
    fixInFile.edit.replace(document.uri, diagnostic.range, suggestion);
    actions.push(fixInFile);

    // --- Action 2: Rename all occurrences in file ---
    const allOccurrences = this.findAllOccurrences(document, currentName);
    if (allOccurrences.length > 1) {
      const fixAll = new vscode.CodeAction(
        `Rename all ${allOccurrences.length} occurrences of "${currentName}" to "${suggestion}"`,
        vscode.CodeActionKind.QuickFix
      );
      fixAll.diagnostics = [diagnostic];
      fixAll.edit = new vscode.WorkspaceEdit();
      for (const range of allOccurrences) {
        fixAll.edit.replace(document.uri, range, suggestion);
      }
      actions.push(fixAll);
    }

    return actions;
  }

  /**
   * Extracts the suggestion from the diagnostic message.
   * Message format: `... Suggestion: "suggestedName" ...`
   */
  private extractSuggestion(message: string): string | undefined {
    const match = message.match(/Suggestion:\s*"([^"]+)"/);
    return match?.[1];
  }

  /**
   * Finds all ranges in the document where the identifier appears as a whole word.
   */
  private findAllOccurrences(
    document: vscode.TextDocument,
    name: string
  ): vscode.Range[] {
    const text = document.getText();
    const ranges: vscode.Range[] = [];
    const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const start = document.positionAt(match.index);
      const end = document.positionAt(match.index + name.length);
      ranges.push(new vscode.Range(start, end));
    }

    return ranges;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
