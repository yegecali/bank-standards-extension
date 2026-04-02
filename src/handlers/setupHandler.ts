import * as vscode from "vscode";
import { PromptTemplate } from "../knowledge/parser";
import { log, logError } from "../logger";
import { resolveModel } from "../utils/modelResolver";

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handles @company /setup [action]
 *
 * - No arg  → list available setup actions from the knowledge base page
 * - With arg → find matching action, read workspace context, generate tailored
 *              step-by-step setup guide using the company-defined prompt template
 */
export async function handleSetupCommand(
  userArg: string,
  templates: PromptTemplate[],
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  pageTitle: string
): Promise<void> {
  log(`[SetupHandler] arg: "${userArg}", templates: ${templates.length}`);

  if (templates.length === 0) {
    stream.markdown(
      `⚠️ No encontré guías de setup en la página **${pageTitle}**.\n\n` +
      `Estructura la página con encabezados H2. Cada uno define una guía:\n\n` +
      "```markdown\n" +
      `## maven\n` +
      `Antes de compilar necesitas:\n` +
      `1. Descargar los certificados corporativos del servidor de seguridad interna.\n` +
      `2. Importarlos al cacert de Java: \`keytool -import -alias corp -file cert.crt -keystore $JAVA_HOME/lib/security/cacerts\`\n` +
      `3. Configurar ~/.m2/settings.xml con el repositorio privado.\n` +
      `4. Ejecutar \`mvn clean install -DskipTests\` para verificar.\n\n` +
      `## docker\n` +
      `Para levantar el ambiente con Docker...\n` +
      "```\n\n" +
      `Luego configura \`companyStandards.setupPage\` con el ID de esa página.`
    );
    return;
  }

  // No argument → list available setups
  if (!userArg) {
    showSetupCatalog(templates, stream, pageTitle);
    return;
  }

  // Find matching template
  const match = findBestMatch(userArg, templates);
  log(`[SetupHandler] findBestMatch("${userArg}") → ${match ? `"${match.name}"` : "NOT FOUND"}`);

  if (!match) {
    stream.markdown(
      `No encontré una guía de setup para **"${userArg}"**.\n\n` +
      `Guías disponibles: ${templates.map((t) => `\`${t.name}\``).join(", ")}\n\n` +
      `Usa \`@company /setup\` sin argumentos para ver el catálogo.`
    );
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  await executeSetupGuide(match, userArg, stream, resolvedModel, token);
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

function showSetupCatalog(
  templates: PromptTemplate[],
  stream: vscode.ChatResponseStream,
  pageTitle: string
): void {
  stream.markdown(`## 🛠️ Guías de setup — *${pageTitle}*\n\n`);
  stream.markdown(
    `Cada guía lee tu proyecto real y genera instrucciones paso a paso ` +
    `adaptadas a los estándares de la empresa.\n\n` +
    `Uso: \`@company /setup <guía>\`\n\n`
  );
  for (const t of templates) {
    stream.markdown(`### \`${t.name}\`\n${t.description || "_Sin descripción_"}\n\n`);
  }
  stream.markdown(
    `---\n**Ejemplos:**\n` +
    templates.slice(0, 4).map((t) => `- \`@company /setup ${t.name}\``).join("\n")
  );
}

// ─── Execute setup guide ──────────────────────────────────────────────────────

async function executeSetupGuide(
  template: PromptTemplate,
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  stream.progress(`Leyendo proyecto para generar guía de setup "${template.name}"…`);
  log(`[SetupHandler] Executing setup: "${template.name}"`);

  const workspaceCtx = await readWorkspaceContext();
  const extraContext  = userArg.replace(template.name, "").trim();

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un DevOps/SRE de la empresa ayudando a un developer a configurar su ambiente de desarrollo. ` +
    `Genera una guía paso a paso muy específica con comandos exactos listos para copiar y pegar. ` +
    `Indica qué hace cada comando, los posibles errores y cómo resolverlos. ` +
    `Adapta las instrucciones al proyecto real del desarrollador. ` +
    `Responde en el mismo idioma del usuario. Usa Markdown.`
  );

  const userMsg = vscode.LanguageModelChatMessage.User(
    `## Guía de setup: ${template.name}\n\n` +
    `### Instrucciones de la empresa:\n${template.template}\n\n` +
    (extraContext ? `### Contexto adicional: ${extraContext}\n\n` : "") +
    workspaceCtx
  );

  stream.markdown(`> 🛠️ Guía de setup: **${template.name}**\n\n`);
  stream.progress(`Generando guía personalizada…`);

  try {
    const response = await model.sendRequest([systemMsg, userMsg], {}, token);
    for await (const chunk of response.text) {
      stream.markdown(chunk);
    }
    log(`[SetupHandler] Setup guide generated for "${template.name}"`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[SetupHandler] LanguageModelError: ${err.code}`, err);
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else {
      logError("[SetupHandler] Unexpected error", err);
      throw err;
    }
  }
}

// ─── Workspace context ────────────────────────────────────────────────────────

async function readWorkspaceContext(): Promise<string> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) { return "\n\n_No hay workspace abierto._"; }

  const root  = workspaceFolders[0].uri;
  const parts: string[] = ["\n\n---\n## Proyecto actual\n"];

  const filesToRead = [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "package.json",
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
    ".env.example",
    ".env.template",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Makefile",
    ".mvn/wrapper/maven-wrapper.properties",
    ".node-version",
    ".nvmrc",
    "Dockerfile",
  ];

  for (const rel of filesToRead) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel));
      const content = Buffer.from(bytes).toString("utf-8").slice(0, 5000);
      parts.push(`\n### \`${rel}\`\n\`\`\`\n${content}\n\`\`\``);
      log(`[SetupHandler] Read: ${rel} (${content.length} chars)`);
    } catch { /* file not found — skip */ }
  }

  // Java version detection
  try {
    const javaVer = await tryReadFile(root, [".java-version", ".sdkmanrc"]);
    if (javaVer) { parts.push(`\n### Java version hint\n\`\`\`\n${javaVer}\n\`\`\``); }
  } catch { /* skip */ }

  return parts.join("\n");
}

async function tryReadFile(root: vscode.Uri, candidates: string[]): Promise<string | null> {
  for (const rel of candidates) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel));
      return Buffer.from(bytes).toString("utf-8").slice(0, 500);
    } catch { /* try next */ }
  }
  return null;
}


// ─── Fuzzy match ──────────────────────────────────────────────────────────────

function findBestMatch(
  query: string,
  templates: PromptTemplate[]
): PromptTemplate | undefined {
  const q = query.toLowerCase().trim();
  const exact = templates.find((t) => t.name === q);
  if (exact) { return exact; }
  const startsWith = templates.find((t) => q.startsWith(t.name) || t.name.startsWith(q));
  if (startsWith) { return startsWith; }
  const words  = q.split(/\s+/);
  const scored = templates.map((t) => ({
    t,
    score: words.filter((w) => t.name.includes(w)).length,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].t : undefined;
}
