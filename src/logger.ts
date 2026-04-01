import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("Company Coding Standard");
  return channel;
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  channel?.appendLine(line);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  const line = `[${new Date().toISOString()}] ERROR ${msg}${detail ? ` — ${detail}` : ""}`;
  console.error(line);
  channel?.appendLine(line);
}

export function showChannel(): void {
  channel?.show(true);
}

/**
 * Shows a VS Code error notification, logs to the Output Channel, and
 * optionally offers an "Abrir configuración" button that jumps to the
 * relevant setting when clicked.
 *
 * @param message   User-facing error message.
 * @param settingFilter  Optional setting key to open (e.g. "companyStandards.notionToken").
 */
export function notifyError(message: string, settingFilter?: string): void {
  logError(message);
  showChannel();
  if (settingFilter) {
    vscode.window.showErrorMessage(message, "Abrir configuración").then((picked) => {
      if (picked === "Abrir configuración") {
        vscode.commands.executeCommand("workbench.action.openSettings", settingFilter);
      }
    });
  } else {
    vscode.window.showErrorMessage(message);
  }
}
