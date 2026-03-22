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

const DEBOUNCE_MS = 300;

export class DiagnosticProvider {
  private collection: vscode.DiagnosticCollection;
  private rules: NamingRule[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(context: vscode.ExtensionContext) {
    this.collection =
      vscode.languages.createDiagnosticCollection("companyStandards");
    context.subscriptions.push(this.collection);

    // Validate on open
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.scheduleValidation(doc)),
    );

    // Validate on save (debounced — rapid saves won't trigger multiple scans)
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.scheduleValidation(doc)),
    );

    // Validate all open editors on startup
    vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
  }

  updateRules(rules: NamingRule[]): void {
    this.rules = rules;
    // Re-validate all open documents with the new rules
    vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
  }

  private scheduleValidation(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.validate(document);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }

  private validate(document: vscode.TextDocument): void {
    if (!SUPPORTED_LANGUAGES.includes(document.languageId)) return;
    if (document.uri.scheme !== "file") return;

    const violations = findViolations(document, this.rules);

    const diagnostics = violations.map((v) => {
      const diag = new vscode.Diagnostic(
        v.range,
        `[Company Standard] "${v.name}" should be ${v.rule.convention}. ` +
          `Suggestion: "${v.suggestion}" (Rule: ${v.rule.description})`,
        vscode.DiagnosticSeverity.Warning,
      );
      diag.source = "Company Coding Standard";
      diag.code = v.rule.convention;
      return diag;
    });

    this.collection.set(document.uri, diagnostics);
  }

  dispose(): void {
    this.debounceTimers.forEach((t) => clearTimeout(t));
    this.debounceTimers.clear();
    this.collection.dispose();
  }
}
