import * as vscode from "vscode";
import { createKnowledgeProvider } from "../../knowledge/KnowledgeProviderFactory";
import { createProjectCore } from "../projectCreator";
import { resolvePageId } from "../specialtyResolver";

export interface CreateProjectInput {
  /** Project name in lowercase-with-hyphens format (e.g. "payment-service") */
  projectName?: string;
  /** Optional specialty override (e.g. "frontend", "backend", "qa") */
  specialty?: string;
}

/**
 * LM Tool: generates a Maven + Java 21 + Quarkus project from the bank's
 * knowledge source template.
 * Available in Copilot agent mode — invoked automatically when the user
 * asks to create, scaffold, or initialize a project.
 * Requires user confirmation before writing files to disk.
 */
export class CreateProjectTool implements vscode.LanguageModelTool<CreateProjectInput> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CreateProjectInput>
  ): vscode.PreparedToolInvocation {
    const name = options.input.projectName ?? "my-service";
    return {
      invocationMessage: `Preparando proyecto "${name}"…`,
      confirmationMessages: {
        title: "Crear proyecto Quarkus",
        message: new vscode.MarkdownString(
          `¿Crear el proyecto **${name}** en la carpeta del workspace actual?\n\n` +
          `Se generarán: \`pom.xml\`, \`openapi.yaml\`, \`application.properties\` y clases Java.`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CreateProjectInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    // 1 — Resolve workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return result(
        "Error: no workspace folder is open. " +
        "Open a folder in VS Code first (File → Open Folder)."
      );
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // 2 — Resolve project name: tool input → input box fallback
    let projectName = options.input.projectName?.trim();
    if (!projectName) {
      projectName = await vscode.window.showInputBox({
        title: "Nombre del proyecto",
        prompt: `Se creará en: ${workspaceRoot}`,
        value: "my-service",
        validateInput: (v) =>
          /^[a-z][a-z0-9-]*$/.test(v) ? null : "Usa solo minúsculas, números y guiones",
      });
    }

    if (!projectName) {
      return result("Project creation cancelled — no project name provided.");
    }

    // 3 — Load project template from knowledge source (specialty-aware)
    const { specialty } = options.input;
    const pageId = resolvePageId("project", specialty);

    if (!pageId) {
      return result(
        "No project template page configured. " +
        "Add 'project' to bankStandards.specialtiesMap.<specialty> (or legacy pagesMap) in settings."
      );
    }

    try {
      const provider = createKnowledgeProvider();
      const page     = await provider.getPage(pageId);

      // 4 — Create files with progress notification
      let created: { folder: string; files: string[] } | null = null;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Bank Standards: Creating project "${projectName}"`,
          cancellable: false,
        },
        async (progress) => {
          created = await createProjectCore(
            page.blocks,
            projectName!,
            workspaceRoot,
            (msg) => progress.report({ message: msg })
          );
        }
      );

      if (!created) {
        return result("Project creation failed — no files were written.");
      }

      const { folder, files } = created as { folder: string; files: string[] };
      return result(
        `✅ Project "${projectName}" created successfully.\n\n` +
        `**Location:** \`${folder}\`\n\n` +
        `**Files generated (${files.length}):**\n` +
        files.map((f) => `- \`${f}\``).join("\n") +
        `\n\nRun \`mvn quarkus:dev\` inside the project folder to start the server.`
      );
    } catch (err: any) {
      return result(`Error creating project: ${err.message}`);
    }
  }
}

function result(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
