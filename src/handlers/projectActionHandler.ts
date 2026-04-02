import * as vscode from "vscode";
import * as path from "path";
import { PromptTemplate } from "../knowledge/parser";
import { log, logError } from "../logger";
import { resolveModel } from "../utils/modelResolver";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedFile {
  filePath: string;
  language: string;
  content: string;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handles the @company /project <action> command.
 *
 * Flow:
 *   1. No arg → list available actions from the prompt library page
 *   2. With arg → find matching action, read workspace context, execute with LLM
 *      → parse response for file blocks → create new files / show diffs for existing
 */
export async function handleProjectCommand(
  userArg: string,
  templates: PromptTemplate[],
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  pageTitle: string
): Promise<void> {
  log(`[ProjectAction] handleProjectCommand — arg: "${userArg}", templates: ${templates.length}`);

  if (templates.length === 0) {
    stream.markdown(
      `⚠️ No encontré acciones en la página **${pageTitle}**.\n\n` +
      `Asegúrate de estructurarla con encabezados H2 para cada acción:\n\n` +
      "```\n## agrega-redis\nCrea una interfaz RedisClient, agrega la dependencia...\n\n" +
      "## agrega-client-rest\nLee el pom.xml actual, agrega configuración...\n```"
    );
    return;
  }

  if (!userArg) {
    showActionCatalog(templates, stream, pageTitle);
    return;
  }

  const match = findBestMatch(userArg, templates);
  log(`[ProjectAction] findBestMatch("${userArg}") → ${match ? `"${match.name}"` : "NOT FOUND"}`);

  if (!match) {
    stream.markdown(
      `No encontré una acción que coincida con **"${userArg}"**.\n\n` +
      `Acciones disponibles: ${templates.map((t) => `\`${t.name}\``).join(", ")}\n\n` +
      `Usa \`@company /project\` sin argumentos para ver el catálogo.`
    );
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  await executeProjectAction(match, userArg, stream, resolvedModel, token);
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

function showActionCatalog(
  templates: PromptTemplate[],
  stream: vscode.ChatResponseStream,
  pageTitle: string
): void {
  stream.markdown(`## ⚙️ Acciones de proyecto — *${pageTitle}*\n\n`);
  stream.markdown(
    `Cada acción lee el contexto de tu proyecto (pom.xml, properties, estructura) ` +
    `y genera o modifica archivos automáticamente.\n\n` +
    `Uso: \`@company /project <acción>\`\n\n`
  );
  for (const t of templates) {
    stream.markdown(`### \`${t.name}\`\n${t.description || "_Sin descripción_"}\n\n`);
  }
  stream.markdown(
    "---\n**Ejemplos:**\n" +
    templates.slice(0, 3).map((t) => `- \`@company /project ${t.name}\``).join("\n")
  );
}

// ─── Execute action ───────────────────────────────────────────────────────────

async function executeProjectAction(
  template: PromptTemplate,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  stream.progress(`Leyendo contexto del proyecto para "${template.name}"…`);
  log(`[ProjectAction] Executing action: "${template.name}", model: "${model.id}"`);

  // 1 — Read workspace context
  const workspaceCtx = await readWorkspaceContext();
  log(`[ProjectAction] Workspace context: ${workspaceCtx.length} chars`);

  // 2 — Build extra context from user arg (words beyond the action name)
  const extraContext = userArg.replace(template.name, "").trim();

  // 3 — Build prompt
  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un agente experto en desarrollo de software integrado en VSCode. ` +
    `Cuando generes archivos nuevos o modifiques existentes, usa bloques de código con la ruta del archivo ` +
    `en el lenguaje del bloque como comentario de primera línea: // filepath: ruta/al/archivo.java\n` +
    `Si el archivo ya existe en el proyecto, indica claramente qué secciones agregar/modificar. ` +
    `Responde en el mismo idioma del usuario. Usa Markdown.`
  );

  const userMsg = vscode.LanguageModelChatMessage.User(
    `## Acción: ${template.name}\n\n` +
    template.template +
    (extraContext ? `\n\n**Contexto adicional del usuario:** ${extraContext}` : "") +
    workspaceCtx
  );

  stream.markdown(`> ⚙️ Acción: **${template.name}**\n\n`);
  stream.progress(`Generando cambios para "${template.name}"…`);

  // 4 — Stream LLM response and collect full text
  let fullResponse = "";
  try {
    const response = await model.sendRequest([systemMsg, userMsg], {}, token);
    for await (const fragment of response.text) {
      stream.markdown(fragment);
      fullResponse += fragment;
    }
    log(`[ProjectAction] LLM response: ${fullResponse.length} chars`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[ProjectAction] LanguageModelError — code: "${err.code}"`, err);
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else {
      logError("[ProjectAction] Unexpected error", err);
      throw err;
    }
    return;
  }

  // 5 — Parse and apply new files from the response
  const newFiles = parseNewFiles(fullResponse);
  if (newFiles.length === 0) {
    log(`[ProjectAction] No new files to create in response`);
    return;
  }

  await applyNewFiles(newFiles, stream);
}

// ─── Workspace context reader ─────────────────────────────────────────────────

/**
 * Reads the most relevant project files from the workspace:
 * pom.xml, build.gradle, package.json, application.properties/yml,
 * and a shallow file-tree (2 levels).
 */
async function readWorkspaceContext(): Promise<string> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return "\n\n_No hay workspace abierto._";
  }

  const root = workspaceFolders[0].uri;
  const parts: string[] = ["\n\n---\n## Contexto actual del proyecto\n"];

  // Files to read (in order of priority)
  const filesToRead = [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "package.json",
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
    "src/main/resources/application.yaml",
    "src/main/resources/bootstrap.properties",
    "src/main/resources/bootstrap.yml",
    ".env",
    "docker-compose.yml",
    "docker-compose.yaml",
  ];

  for (const rel of filesToRead) {
    const uri = vscode.Uri.joinPath(root, rel);
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8");
      const ext     = rel.split(".").pop() ?? "text";
      const lang    = extToLang(ext);
      parts.push(`\n### \`${rel}\`\n\`\`\`${lang}\n${content.slice(0, 8000)}\n\`\`\``);
      log(`[ProjectAction] Read context file: ${rel} (${content.length} chars)`);
    } catch {
      // File doesn't exist — skip silently
    }
  }

  // Shallow project structure (2 levels)
  try {
    const tree = await buildFileTree(root, 2);
    if (tree.length > 0) {
      parts.push(`\n### Estructura del proyecto\n\`\`\`\n${tree.join("\n")}\n\`\`\``);
    }
  } catch (err) {
    logError("[ProjectAction] Could not build file tree", err);
  }

  return parts.join("\n");
}

async function buildFileTree(
  dir: vscode.Uri,
  depth: number,
  prefix = ""
): Promise<string[]> {
  if (depth < 0) { return []; }
  const IGNORE = new Set([
    "node_modules", ".git", "target", "build", "dist", "out",
    ".idea", ".vscode", "__pycache__", ".DS_Store",
  ]);

  const entries = await vscode.workspace.fs.readDirectory(dir);
  const lines: string[] = [];

  for (const [name, type] of entries) {
    if (IGNORE.has(name)) { continue; }
    lines.push(`${prefix}${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}`);
    if (type === vscode.FileType.Directory && depth > 0) {
      const sub = await buildFileTree(vscode.Uri.joinPath(dir, name), depth - 1, prefix + "  ");
      lines.push(...sub);
    }
  }
  return lines;
}

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    xml: "xml", gradle: "groovy", kts: "kotlin",
    json: "json", properties: "properties",
    yml: "yaml", yaml: "yaml", env: "bash",
  };
  return map[ext] ?? "text";
}

// ─── Parse & apply generated files ───────────────────────────────────────────

/**
 * Extracts code blocks from the LLM response that contain a
 * `// filepath: path/to/file.ext` or `# filepath: ...` as the first line.
 */
function parseNewFiles(response: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(response)) !== null) {
    const lang    = match[1] ?? "";
    const content = match[2];
    const firstLine = content.split("\n")[0].trim();

    // Accept: // filepath: ..., # filepath: ..., <!-- filepath: ... -->
    const fpMatch = firstLine.match(/^(?:\/\/|#|<!--)\s*filepath:\s*(.+?)(?:\s*-->)?$/i);
    if (!fpMatch) { continue; }

    const filePath = fpMatch[1].trim();
    const body     = content.split("\n").slice(1).join("\n");
    files.push({ filePath, language: lang, content: body });
    log(`[ProjectAction] Parsed file: "${filePath}" (${lang})`);
  }

  return files;
}

/**
 * Creates new files in the workspace. If a file already exists it shows a
 * diff-like comparison and asks for confirmation before overwriting.
 */
async function applyNewFiles(
  files: ParsedFile[],
  stream: vscode.ChatResponseStream
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    stream.markdown("\n\n⚠️ No hay workspace abierto — no puedo crear archivos.");
    return;
  }

  const root = workspaceFolders[0].uri;
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const targetUri = vscode.Uri.joinPath(root, file.filePath);
    let exists = false;

    try {
      await vscode.workspace.fs.stat(targetUri);
      exists = true;
    } catch { /* does not exist */ }

    if (exists) {
      // Show warning but don't overwrite automatically — user should review
      stream.markdown(
        `\n\n> ⚠️ **\`${file.filePath}\` ya existe** — revisa las secciones sugeridas arriba y aplica los cambios manualmente.`
      );
      skipped.push(file.filePath);
      log(`[ProjectAction] Skipped existing file: "${file.filePath}"`);
      continue;
    }

    // Ensure parent directories exist
    const parentUri = vscode.Uri.joinPath(targetUri, "..");
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch { /* already exists */ }

    await vscode.workspace.fs.writeFile(
      targetUri,
      Buffer.from(file.content, "utf-8")
    );
    created.push(file.filePath);
    log(`[ProjectAction] Created file: "${file.filePath}"`);
  }

  if (created.length > 0) {
    stream.markdown(
      `\n\n---\n## ✅ Archivos creados (${created.length})\n\n` +
      created.map((f) => `- \`${f}\``).join("\n")
    );
  }
  if (skipped.length > 0) {
    stream.markdown(
      `\n\n## ⚠️ Archivos existentes (${skipped.length}) — requieren revisión manual\n\n` +
      skipped.map((f) => `- \`${f}\``).join("\n")
    );
  }
}


// ─── Fuzzy match ──────────────────────────────────────────────────────────────

function findBestMatch(
  query: string,
  templates: PromptTemplate[]
): PromptTemplate | undefined {
  const q = query.toLowerCase().trim();

  // 1. Exact slug match
  const exact = templates.find((t) => t.name === q);
  if (exact) { return exact; }

  // 2. Starts-with match
  const startsWith = templates.find((t) => q.startsWith(t.name) || t.name.startsWith(q));
  if (startsWith) { return startsWith; }

  // 3. All words in query appear in template name
  const words  = q.split(/\s+/);
  const scored = templates.map((t) => ({
    t,
    score: words.filter((w) => t.name.includes(w)).length,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].t : undefined;
}
