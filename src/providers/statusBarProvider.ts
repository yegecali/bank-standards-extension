import * as vscode from "vscode";

export class StatusBarProvider {
  private item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "workbench.action.problems.focus";
    this.item.tooltip = "Bank Standards violations in this file. Click to open Problems panel.";
    context.subscriptions.push(this.item);

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.languages.onDidChangeDiagnostics(() => this.update())
    );

    this.update();
  }

  private update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.item.hide();
      return;
    }

    const violations = vscode.languages
      .getDiagnostics(editor.document.uri)
      .filter((d) => d.source === "Company Coding Standard");

    if (violations.length === 0) {
      this.item.text = "$(check) Bank Standards";
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(warning) Company: ${violations.length} violation${violations.length === 1 ? "" : "s"}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    this.item.show();
  }
}
