import * as vscode from "vscode";
import { NamingRule, parseNamingRules, parseProjectSteps } from "./notion/parser";
import { resolveWithCache, clearCache } from "./notion/cache";
import { createKnowledgeProvider, resetKnowledgeProvider } from "./knowledge/KnowledgeProviderFactory";
import { DiagnosticProvider } from "./providers/diagnosticProvider";
import { BankStandardsCodeActionProvider } from "./providers/codeActionProvider";
import { StatusBarProvider } from "./providers/statusBarProvider";
import { registerBankAgent } from "./agent/bankAgent";
import { GetStandardsTool } from "./agent/tools/GetStandardsTool";
import { ReviewTestTool } from "./agent/tools/ReviewTestTool";
import { CreateProjectTool } from "./agent/tools/CreateProjectTool";

let diagnosticProvider: DiagnosticProvider;
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  console.log("[BankStandards] ── activate() start ──────────────────────────");
  console.log(`[BankStandards] Extension path : ${context.extensionUri.fsPath}`);
  console.log(`[BankStandards] VS Code version: ${vscode.version}`);
  console.log(`[BankStandards] Storage path   : ${context.globalStorageUri?.fsPath ?? "n/a"}`);

  // Log current settings (no sensitive values)
  const cfg = vscode.workspace.getConfiguration("bankStandards");
  console.log(`[BankStandards] knowledgeSource: ${cfg.get("knowledgeSource") ?? "(not set)"}`);
  console.log(`[BankStandards] notionToken    : ${cfg.get<string>("notionToken") ? "configured" : "NOT SET"}`);
  console.log(`[BankStandards] confluenceUrl  : ${cfg.get("confluenceUrl") || "(not set)"}`);
  console.log(`[BankStandards] specialty      : ${cfg.get("specialty") ?? "(not set)"}`);
  const pagesMap = cfg.get<Record<string, string>>("pagesMap") ?? {};
  const specialtiesMap = cfg.get<Record<string, unknown>>("specialtiesMap") ?? {};
  console.log(`[BankStandards] pagesMap keys  : ${Object.keys(pagesMap).join(", ") || "(empty)"}`);
  console.log(`[BankStandards] specialties    : ${Object.keys(specialtiesMap).join(", ") || "(empty)"}`);

  extensionContext = context;

  console.log("[BankStandards] Registering DiagnosticProvider…");
  diagnosticProvider = new DiagnosticProvider(context);
  console.log("[BankStandards] DiagnosticProvider OK");

  console.log("[BankStandards] Registering StatusBarProvider…");
  new StatusBarProvider(context);
  console.log("[BankStandards] StatusBarProvider OK");

  console.log("[BankStandards] Registering @bank chat participant…");
  registerBankAgent(context);
  console.log("[BankStandards] @bank chat participant OK");

  // ─── LM Tools (available in Copilot agent mode) ──────────────────────────
  console.log("[BankStandards] Registering LM Tools…");
  try {
    context.subscriptions.push(
      vscode.lm.registerTool("bank_get_standards", new GetStandardsTool(context)),
      vscode.lm.registerTool("bank_review_test",   new ReviewTestTool(context)),
      vscode.lm.registerTool("bank_create_project", new CreateProjectTool())
    );
    console.log("[BankStandards] LM Tools registered: bank_get_standards, bank_review_test, bank_create_project");
  } catch (err: unknown) {
    console.error("[BankStandards] LM Tools registration FAILED:", err);
  }

  const SUPPORTED_LANGUAGES = [
    { language: "typescript" },
    { language: "javascript" },
    { language: "typescriptreact" },
    { language: "javascriptreact" },
    { language: "java" },
  ];
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    SUPPORTED_LANGUAGES,
    new BankStandardsCodeActionProvider(),
    { providedCodeActionKinds: BankStandardsCodeActionProvider.providedCodeActionKinds }
  );
  context.subscriptions.push(codeActionProvider);

  const refreshCmd = vscode.commands.registerCommand(
    "bankStandards.refreshStandards",
    async () => {
      resetKnowledgeProvider();
      await clearCache(context);
      await refreshStandards();
    }
  );

  // Reset provider singleton when knowledge source settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bankStandards.knowledgeSource") ||
          e.affectsConfiguration("bankStandards.notionToken") ||
          e.affectsConfiguration("bankStandards.confluenceUrl") ||
          e.affectsConfiguration("bankStandards.confluenceEmail") ||
          e.affectsConfiguration("bankStandards.confluenceToken")) {
        resetKnowledgeProvider();
      }
    })
  );

  const newProjectCmd = vscode.commands.registerCommand(
    "bankStandards.newProject",
    async () => {
      await showProjectGuide(context);
    }
  );

  context.subscriptions.push(refreshCmd, newProjectCmd);

  console.log("[BankStandards] ── activate() complete ─────────────────────");

  refreshStandards().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BankStandards] refreshStandards() failed on startup: ${msg}`);
    vscode.window.showWarningMessage(
      "Bank Standards: Could not load Notion standards. Check your settings."
    );
  });
}

async function refreshStandards() {
  const config = vscode.workspace.getConfiguration("bankStandards");
  const pagesMap = config.get<Record<string, string>>("pagesMap") ?? {};
  const standardsPageId = pagesMap["standards"];

  if (!standardsPageId) {
    vscode.window.showWarningMessage(
      'Bank Standards: No standards page ID configured. Add "standards" to bankStandards.pagesMap.'
    );
    return;
  }

  try {
    const provider = createKnowledgeProvider();
    const { data: rules, pageTitle, fromCache } = await resolveWithCache<NamingRule[]>(
      extensionContext,
      standardsPageId,
      provider,
      parseNamingRules,
      "refreshStandards"
    );

    diagnosticProvider.updateRules(rules);

    const origin = fromCache ? "cache (page unchanged)" : "Notion (page updated)";
    vscode.window.showInformationMessage(
      `Bank Standards: ${rules.length} rules loaded from "${pageTitle}" — ${origin}`
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Bank Standards: ${err.message}`);
  }
}

async function showProjectGuide(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("bankStandards");
  const pagesMap = config.get<Record<string, string>>("pagesMap") ?? {};
  const projectPageId = pagesMap["project"];

  if (!projectPageId) {
    vscode.window.showWarningMessage(
      'Bank Standards: No project guide page ID configured. Add "project" to bankStandards.pagesMap.'
    );
    return;
  }

  try {
    const provider = createKnowledgeProvider();
    const { data: steps, pageTitle, fromCache } = await resolveWithCache(
      context,
      projectPageId,
      provider,
      parseProjectSteps,
      "showProjectGuide"
    );

    const panel = vscode.window.createWebviewPanel(
      "bankProjectGuide",
      `Project Guide: ${pageTitle}`,
      vscode.ViewColumn.Beside,
      {}
    );

    panel.webview.html = buildProjectGuideHtml(pageTitle, steps, fromCache);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Bank Standards: ${err.message}`);
  }
}

function buildProjectGuideHtml(
  title: string,
  steps: ReturnType<typeof parseProjectSteps>,
  fromCache = false
): string {
  const stepsHtml = steps
    .map(
      (s) => `
      <li>
        <strong>${s.title}</strong>
        ${s.description !== s.title ? `<p>${s.description}</p>` : ""}
      </li>`
    )
    .join("");

  const badge = fromCache
    ? `<span class="badge cache">cached</span>`
    : `<span class="badge live">live from Notion</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
    h1 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; display: flex; align-items: center; gap: 10px; }
    ol { padding-left: 20px; }
    li { margin-bottom: 12px; }
    p { margin: 4px 0 0; opacity: 0.8; font-size: 0.9em; }
    .badge { font-size: 0.55em; padding: 2px 8px; border-radius: 4px; font-weight: normal; }
    .badge.cache { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .badge.live  { background: #1a7f37; color: #fff; }
  </style>
</head>
<body>
  <h1>${title} ${badge}</h1>
  <ol>${stepsHtml}</ol>
</body>
</html>`;
}

export function deactivate() {
  diagnosticProvider?.dispose();
}
