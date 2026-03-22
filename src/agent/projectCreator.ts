import * as vscode from "vscode";
import * as path from "path";
import { KnowledgeBlock } from "../knowledge/KnowledgeProvider";
import { log } from "../logger";

export interface CreatedProject {
  folder: string;
  files: string[];
}

/**
 * Detects if the user is asking to CREATE a project (not just explain).
 */
export function isCreateIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const createPatterns = [
    /\bcrea(me|r|lo)?\b/,
    /\bgenera(me|r|lo)?\b/,
    /\bhaz\b/,
    /\bconstruye\b/,
    /\binicializa\b/,
    /\bscaffold\b/,
    /\bcreate\b/,
    /\bgenerate\b/,
    /\binit\b/,
    /\barmar\b/,
  ];
  return createPatterns.some((r) => r.test(lower));
}

/**
 * Core project creation logic — provider-agnostic, stream-agnostic.
 * Used by both the chat handler and the LM Tool.
 *
 * @param blocks   Knowledge blocks from any provider
 * @param projectName  Already-resolved project name (no UI prompt here)
 * @param workspaceRoot  Absolute path to the target parent directory
 * @param onProgress  Optional callback for progress messages
 */
export async function createProjectCore(
  blocks: KnowledgeBlock[],
  projectName: string,
  workspaceRoot: string,
  onProgress?: (msg: string) => void
): Promise<CreatedProject> {
  onProgress?.(`Generando estructura del proyecto "${projectName}"…`);

  const codeBlocks = extractCodeBlocks(blocks);
  log(`[ProjectCreator] Extracted ${Object.keys(codeBlocks).length} code block groups`);

  const rootPath = path.join(workspaceRoot, projectName);
  const files = await writeProjectFiles(rootPath, projectName, codeBlocks);
  log(`[ProjectCreator] Created ${files.length} files in ${rootPath}`);

  return { folder: rootPath, files };
}

/**
 * Chat-stream variant — asks for project name via input box, then
 * delegates to createProjectCore.
 */
export async function createProjectFromNotion(
  blocks: KnowledgeBlock[],
  stream: vscode.ChatResponseStream
): Promise<CreatedProject | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    stream.markdown("⚠️ No hay una carpeta abierta en VSCode. Abre una carpeta primero (`File → Open Folder`).");
    return null;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const projectName = await vscode.window.showInputBox({
    title: "Nombre del proyecto",
    prompt: `Se creará en: ${workspaceRoot}`,
    value: "my-service",
    validateInput: (v) => /^[a-z][a-z0-9-]*$/.test(v) ? null : "Usa solo minúsculas, números y guiones",
  });

  if (!projectName) {
    stream.markdown("⚠️ No se ingresó nombre de proyecto. Operación cancelada.");
    return null;
  }

  return createProjectCore(blocks, projectName, workspaceRoot, (msg) => stream.progress(msg));
}

// ─── File writer ─────────────────────────────────────────────────────────────

async function writeProjectFiles(
  rootPath: string,
  projectName: string,
  codeBlocks: Record<string, string[]>
): Promise<string[]> {
  const created: string[] = [];

  const write = async (relPath: string, content: string) => {
    const uri = vscode.Uri.file(path.join(rootPath, relPath));
    const dir = vscode.Uri.file(path.dirname(uri.fsPath));
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    created.push(relPath);
    log(`[ProjectCreator] Created: ${relPath}`);
  };

  const pomContent   = codeBlocks["xml"]?.[0]        ?? buildDefaultPom(projectName);
  const yamlContent  = codeBlocks["yaml"]?.[0]       ?? buildDefaultOpenApi(projectName);
  const propsContent = codeBlocks["properties"]?.[0] ?? buildDefaultProperties();

  await write("pom.xml", pomContent);
  await write("src/main/resources/META-INF/openapi.yaml", yamlContent);
  await write("src/main/resources/application.properties", propsContent);

  for (const javaBlock of codeBlocks["java"] ?? []) {
    await write(resolveJavaPath(javaBlock, projectName), javaBlock);
  }

  for (const dir of [
    "src/main/java/com/bank/controller",
    "src/test/java/com/bank/controller",
    "src/main/resources/META-INF",
  ]) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(rootPath, dir)));
  }

  return created;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractCodeBlocks(blocks: KnowledgeBlock[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const block of blocks) {
    if (block.type !== "code") continue;
    const lang = (block.language ?? "plain").toLowerCase().replace("plain text", "text");
    const text = block.text ?? "";
    if (!text.trim()) continue;
    if (!result[lang]) result[lang] = [];
    result[lang].push(text);
  }
  return result;
}

function resolveJavaPath(javaSource: string, _projectName: string): string {
  const packageMatch = javaSource.match(/^package\s+([\w.]+);/m);
  const pkg          = packageMatch?.[1] ?? "com.bank";
  const pkgPath      = pkg.replace(/\./g, "/");
  const classMatch   = javaSource.match(/(?:public\s+)?class\s+(\w+)/);
  const className    = classMatch?.[1] ?? "Unknown";
  const isTest       = javaSource.includes("@QuarkusTest") || javaSource.includes("Test.class") || className.endsWith("Test");
  return `${isTest ? "src/test/java" : "src/main/java"}/${pkgPath}/${className}.java`;
}

function buildDefaultPom(projectName: string): string {
  return `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.bank</groupId>
  <artifactId>${projectName}</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <properties>
    <java.version>21</java.version>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
    <quarkus.platform.version>3.8.0</quarkus.platform.version>
  </properties>
</project>`;
}

function buildDefaultOpenApi(projectName: string): string {
  return `openapi: 3.0.3
info:
  title: ${projectName} API
  version: 1.0.0
paths:
  /dummy:
    get:
      operationId: getDummy
      responses:
        '200':
          description: OK`;
}

function buildDefaultProperties(): string {
  return `mp.openapi.scan.disable=true
quarkus.swagger-ui.always-include=true
quarkus.swagger-ui.path=/swagger-ui`;
}
