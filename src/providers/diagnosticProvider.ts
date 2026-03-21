import * as vscode from "vscode";
import { NamingRule } from "../notion/parser";
import { findViolations } from "../standards/validator";

const SUPPORTED_LANGUAGES = [
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "java",
];

export class DiagnosticProvider {
  private collection: vscode.DiagnosticCollection;
  private rules: NamingRule[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.collection =
      vscode.languages.createDiagnosticCollection("bankStandards");
    context.subscriptions.push(this.collection);

    // Validate on open
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.validate(doc)),
    );

    // Validate on save
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.validate(doc)),
    );

    // Validate all open editors on rule update
    vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
  }

  updateRules(rules: NamingRule[]): void {
    this.rules = rules;
    // Re-validate all open documents with the new rules
    vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
  }

  private validate(document: vscode.TextDocument): void {
    if (!SUPPORTED_LANGUAGES.includes(document.languageId)) return;
    if (document.uri.scheme !== "file") return;

    const violations = findViolations(document, this.rules);

    const diagnostics = violations.map((v) => {
      const diag = new vscode.Diagnostic(
        v.range,
        `[Bank Standard] "${v.name}" should be ${v.rule.convention}. ` +
          `Suggestion: "${v.suggestion}" (Rule: ${v.rule.description})`,
        vscode.DiagnosticSeverity.Warning,
      );
      diag.source = "Bank Standards";
      diag.code = v.rule.convention;
      return diag;
    });

    this.collection.set(document.uri, diagnostics);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
