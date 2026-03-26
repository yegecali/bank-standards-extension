import * as vscode from "vscode";
import { NamingRule } from "../notion/parser";
import {
  findViolations,
  findAdditionalViolations,
  AdditionalRules,
  DEFAULT_ADDITIONAL_RULES,
} from "../standards/validator";

const SUPPORTED_LANGUAGES = [
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "java",
];

const DEBOUNCE_MS = 300;

// ─── Settings rule shape ─────────────────────────────────────────────────────

interface SettingsNamingRule {
  context:     string;
  convention:  NamingRule["convention"];
  description: string;
  severity?:   "error" | "warning" | "info";
  enabled?:    boolean;
}

// ─── Built-in default naming rules ────────────────────────────────────────────
// Used when companyStandards.namingRules is not configured.

const DEFAULT_NAMING_RULES: SettingsNamingRule[] = [
  { context: "functions",      convention: "camelCase",   description: "Functions must use camelCase",           enabled: true },
  { context: "variables",      convention: "camelCase",   description: "Variables must use camelCase",           enabled: true },
  { context: "constants",      convention: "UPPER_SNAKE", description: "Constants must use UPPER_SNAKE_CASE",    enabled: true },
  { context: "classes",        convention: "PascalCase",  description: "Classes must use PascalCase",            enabled: true },
  { context: "interfaces",     convention: "PascalCase",  description: "Interfaces must use PascalCase",         enabled: true },
  { context: "types",          convention: "PascalCase",  description: "Type aliases must use PascalCase",       enabled: true },
  { context: "enums",          convention: "PascalCase",  description: "Enums must use PascalCase",              enabled: true },
  { context: "enum members",   convention: "UPPER_SNAKE", description: "Enum members must use UPPER_SNAKE_CASE", enabled: true },
  { context: "methods",        convention: "camelCase",   description: "Methods must use camelCase",             enabled: true },
  { context: "parameters",     convention: "camelCase",   description: "Parameters must use camelCase",          enabled: true },
  { context: "private fields", convention: "camelCase",   description: "Private fields must use camelCase",      enabled: true },
  { context: "test functions", convention: "camelCase",   description: "Test names must use camelCase",          enabled: true },
];

// ─── Provider ────────────────────────────────────────────────────────────────

export class DiagnosticProvider {
  private collection: vscode.DiagnosticCollection;
  /** Rules from the knowledge base (Notion/Confluence) — used as fallback */
  private kbRules: NamingRule[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(context: vscode.ExtensionContext) {
    this.collection = vscode.languages.createDiagnosticCollection("companyStandards");
    context.subscriptions.push(this.collection);

    // Re-validate all open documents when settings change
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("companyStandards.namingRules") ||
          e.affectsConfiguration("companyStandards.additionalRules")
        ) {
          vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
        }
      })
    );

    // Validate on open and save
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.scheduleValidation(doc))
    );
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.scheduleValidation(doc))
    );

    // Validate all open editors on startup
    vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
  }

  /**
   * Called by bankAgent when it loads naming rules from the knowledge base.
   * Settings rules take priority; KB rules fill in any contexts not covered by settings.
   */
  updateRules(kbRules: NamingRule[]): void {
    this.kbRules = kbRules;
    vscode.workspace.textDocuments.forEach((doc) => this.validate(doc));
  }

  // ─── Settings readers ──────────────────────────────────────────────────────

  /**
   * Resolves the active naming rules by merging settings + knowledge base.
   *
   * Priority order:
   * 1. companyStandards.namingRules (if configured) OR built-in defaults
   * 2. Knowledge-base rules for contexts NOT already covered by step 1
   */
  private resolveNamingRules(): NamingRule[] {
    const config      = vscode.workspace.getConfiguration("companyStandards");
    const settingsRaw = config.get<SettingsNamingRule[]>("namingRules");
    const source      = settingsRaw && settingsRaw.length > 0 ? settingsRaw : DEFAULT_NAMING_RULES;

    // Keep only enabled rules
    const settingsRules: NamingRule[] = source
      .filter((r) => r.enabled !== false)
      .map((r) => ({ context: r.context, convention: r.convention, description: r.description }));

    // Contexts already covered by settings → KB rules for the rest
    const covered      = new Set(settingsRules.map((r) => r.context.toLowerCase()));
    const kbComplement = this.kbRules.filter((r) => !covered.has(r.context.toLowerCase()));

    return [...settingsRules, ...kbComplement];
  }

  private resolveAdditionalRules(): AdditionalRules {
    const config = vscode.workspace.getConfiguration("companyStandards");
    const raw    = config.get<Partial<AdditionalRules>>("additionalRules") ?? {};
    return { ...DEFAULT_ADDITIONAL_RULES, ...raw };
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  private scheduleValidation(document: vscode.TextDocument): void {
    const key      = document.uri.toString();
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

    const namingRules     = this.resolveNamingRules();
    const additionalRules = this.resolveAdditionalRules();

    // ── Naming convention diagnostics ────────────────────────────────────────
    const namingDiags = findViolations(document, namingRules).map((v) => {
      const diag = new vscode.Diagnostic(
        v.range,
        `[Company Standard] "${v.name}" should be ${v.rule.convention}. ` +
          `Suggestion: "${v.suggestion}" — ${v.rule.description}`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = "Company Coding Standard";
      diag.code   = v.rule.convention;
      return diag;
    });

    // ── Additional coding standard diagnostics ────────────────────────────────
    const additionalDiags = findAdditionalViolations(document, additionalRules).map((d) => {
      const diag = new vscode.Diagnostic(d.range, d.message, d.severity);
      diag.source = "Company Coding Standard";
      diag.code   = d.code;
      return diag;
    });

    this.collection.set(document.uri, [...namingDiags, ...additionalDiags]);
  }

  dispose(): void {
    this.debounceTimers.forEach((t) => clearTimeout(t));
    this.debounceTimers.clear();
    this.collection.dispose();
  }
}
