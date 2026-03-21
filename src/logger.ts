import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("Bank Standards");
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
