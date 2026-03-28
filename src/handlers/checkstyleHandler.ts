import * as vscode from "vscode";
import * as path    from "path";
import { exec }     from "child_process";
import { promisify } from "util";
import { log, logError } from "../logger";
import { EXCLUDE_GLOB } from "../config/defaults";
import { resolveModel } from "../utils/modelResolver";

const execAsync = promisify(exec);

const OUTPUT_PATH          = "docs/checkstyle-report.md";
const FILES_PER_BATCH      = 2;    // small batch: full file content back from LLM
const MAX_CHARS_JAVA       = 6_000;
const MAX_JAVA_FILES       = 120;
const MAX_MAVEN_ITERATIONS = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface JavaFile {
  uri:     vscode.Uri;
  relPath: string;
  content: string;
}

interface FixedFile {
  relPath: string;
  uri:     vscode.Uri;
  content: string;
}

interface MavenError {
  filePath:    string;   // absolute or relative
  line:        number;
  col:         number;
  message:     string;
  rule:        string;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleCheckstyleCommand(
  stream: vscode.ChatResponseStream,
  model:  vscode.LanguageModelChat,
  token:  vscode.CancellationToken
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    stream.markdown("⚠️ No hay workspace abierto.");
    return;
  }

  const root        = folders[0].uri;
  const workspaceFs = root.fsPath;

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  const config          = vscode.workspace.getConfiguration("companyStandards");
  const mavenExec       = (config.get<string>("mavenExecutable") ?? "mvn").trim() || "mvn";
  const checkstylePath  = (config.get<string>("checkstyleConfigPath") ?? "").trim();

  // ── Read checkstyle.xml ───────────────────────────────────────────────────
  const checkstyleRules = await readCheckstyleConfig(root, checkstylePath);

  // ── Collect .java files ───────────────────────────────────────────────────
  stream.progress("Buscando archivos Java…");
  const files = await collectJavaFiles();

  if (files.length === 0) {
    stream.markdown("ℹ️ No encontré archivos `.java` en el workspace.");
    return;
  }

  const batches = chunk(files, FILES_PER_BATCH);

  stream.markdown(
    `## ☕ Checkstyle — Análisis y corrección Java\n\n` +
    `| | |\n|---|---|\n` +
    `| Archivos Java | **${files.length}** |\n` +
    `| Lotes | **${batches.length}** (${FILES_PER_BATCH} archivos c/u) |\n` +
    `| Config checkstyle | ${checkstyleRules ? "✅ Encontrada" : "⚠️ No encontrada — se usarán reglas Google/Sun estándar"} |\n\n` +
    `**Fases de corrección:**\n` +
    `1. IA corrige JavaDoc, indentación y espaciado por lotes\n` +
    `2. \`${mavenExec} checkstyle:check\` valida los cambios\n` +
    `3. Si hay errores Maven, IA itera (máx ${MAX_MAVEN_ITERATIONS} veces)\n\n`
  );

  log(`[CheckstyleHandler] ${files.length} files, ${batches.length} batches`);

  // ── Phase 1: AI fix ───────────────────────────────────────────────────────
  stream.markdown(`### Fase 1 — Corrección IA por lotes…\n\n`);

  const allFixed: FixedFile[] = [];
  let batchErrors = 0;

  for (let i = 0; i < batches.length; i++) {
    if (token.isCancellationRequested) { break; }

    const batch = batches[i];
    const names = batch.map((f) => shortName(f.relPath));
    stream.progress(`Lote ${i + 1}/${batches.length}: ${names.join(", ")}…`);

    const fixed = await fixBatchWithAI(batch, checkstyleRules, resolvedModel, token, root);
    if (fixed.length === 0) {
      batchErrors++;
      stream.markdown(`- ⚠️ Lote ${i + 1}: sin respuesta del modelo, archivos sin cambios\n`);
      // Keep original content
      for (const f of batch) {
        allFixed.push({ relPath: f.relPath, uri: f.uri, content: f.content });
      }
    } else {
      // Merge fixed with originals (LLM may not return all files)
      const fixedMap = new Map(fixed.map((f) => [f.relPath, f]));
      for (const f of batch) {
        const fix = fixedMap.get(f.relPath);
        if (fix) {
          allFixed.push(fix);
        } else {
          allFixed.push({ relPath: f.relPath, uri: f.uri, content: f.content });
        }
      }
      stream.markdown(`- ✅ Lote ${i + 1}: \`${names.join("`, `")}\` corregidos\n`);
    }
    log(`[CheckstyleHandler] Batch ${i + 1} AI fix done`);
  }

  // Write all fixed files back to disk
  stream.progress("Escribiendo archivos corregidos…");
  let writtenCount = 0;
  for (const f of allFixed) {
    try {
      await vscode.workspace.fs.writeFile(f.uri, Buffer.from(f.content, "utf-8"));
      writtenCount++;
    } catch (err: unknown) {
      logError(`[CheckstyleHandler] Failed to write ${f.relPath}`, err);
    }
  }

  stream.markdown(`\n✅ **${writtenCount}** archivos escritos con correcciones de IA.\n\n`);

  // ── Phase 2: Maven checkstyle loop ────────────────────────────────────────
  stream.markdown(`### Fase 2 — Validación con Maven Checkstyle…\n\n`);

  // Build a live map for re-fix iterations
  const currentContent = new Map(allFixed.map((f) => [f.relPath, f]));

  let mavenErrors: MavenError[] = [];
  let iteration = 0;
  let mavenOutput = "";

  for (iteration = 0; iteration < MAX_MAVEN_ITERATIONS; iteration++) {
    if (token.isCancellationRequested) { break; }

    stream.progress(`Ejecutando \`${mavenExec} checkstyle:check\` (iteración ${iteration + 1})…`);
    log(`[CheckstyleHandler] Maven iteration ${iteration + 1}`);

    try {
      const result = await execAsync(
        `${mavenExec} checkstyle:check -f pom.xml --no-transfer-progress`,
        { cwd: workspaceFs, timeout: 120_000 }
      );
      mavenOutput = result.stdout + result.stderr;
    } catch (err: unknown) {
      // Maven exits with non-zero when there are violations — that's expected
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      mavenOutput = (execErr.stdout ?? "") + (execErr.stderr ?? "");
      if (!mavenOutput && execErr.message) {
        // Real failure (maven not found, pom.xml missing, etc.)
        logError("[CheckstyleHandler] Maven execution failed", err);
        stream.markdown(
          `❌ No pude ejecutar Maven: **${execErr.message}**\n\n` +
          `_Asegúrate de que \`${mavenExec}\` esté en el PATH y que el workspace tenga un \`pom.xml\`. ` +
          `Puedes configurar el ejecutable en \`companyStandards.mavenExecutable\`._`
        );
        break;
      }
    }

    mavenErrors = parseMavenCheckstyleErrors(mavenOutput, workspaceFs, allFixed);
    log(`[CheckstyleHandler] Maven iteration ${iteration + 1}: ${mavenErrors.length} errors`);

    if (mavenErrors.length === 0) {
      stream.markdown(`- ✅ Iteración ${iteration + 1}: **sin errores de checkstyle** — ¡código limpio!\n\n`);
      break;
    }

    // Group errors by file
    const errorsByFile = groupErrorsByFile(mavenErrors, allFixed);
    const errorFileCount = errorsByFile.size;

    stream.markdown(
      `- ⚠️ Iteración ${iteration + 1}: **${mavenErrors.length} errores** en **${errorFileCount} archivos** — corrigiendo con IA…\n`
    );

    // Re-fix only errored files
    const filesToFix: JavaFile[] = [];
    for (const [relPath, errors] of errorsByFile) {
      const current = currentContent.get(relPath);
      if (current) {
        filesToFix.push({ uri: current.uri, relPath, content: current.content });
      }
    }

    const reFixBatches = chunk(filesToFix, FILES_PER_BATCH);

    for (let b = 0; b < reFixBatches.length; b++) {
      if (token.isCancellationRequested) { break; }
      const batch = reFixBatches[b];
      const batchErrors2 = errorsByFile;

      stream.progress(`Re-fix lote ${b + 1}/${reFixBatches.length}…`);

      const fixed = await fixBatchWithErrors(batch, batchErrors2, checkstyleRules, resolvedModel, token, root);
      for (const f of fixed) {
        currentContent.set(f.relPath, f);
        try {
          await vscode.workspace.fs.writeFile(f.uri, Buffer.from(f.content, "utf-8"));
        } catch (writeErr: unknown) {
          logError(`[CheckstyleHandler] Re-fix write failed for ${f.relPath}`, writeErr);
        }
      }
    }

    stream.markdown(`  - 🔄 ${filesToFix.length} archivos re-corregidos\n`);
  }

  if (mavenErrors.length > 0 && iteration >= MAX_MAVEN_ITERATIONS) {
    stream.markdown(
      `\n⚠️ Se alcanzó el máximo de **${MAX_MAVEN_ITERATIONS} iteraciones**. ` +
      `Quedan **${mavenErrors.length} errores** — revisa manualmente o vuelve a ejecutar \`/checkstyle\`.\n\n`
    );
  }

  // ── Phase 3: Write report ─────────────────────────────────────────────────
  stream.progress("Generando reporte…");

  const report = buildReport(allFixed, mavenErrors, mavenOutput, iteration, checkstyleRules !== null);

  try {
    const docsDir = vscode.Uri.joinPath(root, "docs");
    const outFile = vscode.Uri.joinPath(root, OUTPUT_PATH);
    try { await vscode.workspace.fs.createDirectory(docsDir); } catch { /* exists */ }
    await vscode.workspace.fs.writeFile(outFile, Buffer.from(report, "utf-8"));
    log(`[CheckstyleHandler] Report written to ${OUTPUT_PATH}`);
  } catch (err: unknown) {
    logError("[CheckstyleHandler] Failed to write report", err);
  }

  stream.markdown(
    `\n---\n` +
    `## ✅ Checkstyle completado\n\n` +
    `| | |\n|---|---|\n` +
    `| Archivos procesados | **${files.length}** |\n` +
    `| Correcciones IA aplicadas | **${writtenCount}** |\n` +
    `| Iteraciones Maven | **${Math.min(iteration + 1, MAX_MAVEN_ITERATIONS)}** |\n` +
    `| Errores restantes | **${mavenErrors.length}** |\n\n` +
    `Reporte completo: \`${OUTPUT_PATH}\``
  );
}

// ─── AI Fix — Initial ─────────────────────────────────────────────────────────

async function fixBatchWithAI(
  batch:          JavaFile[],
  checkstyleRules: string | null,
  model:           vscode.LanguageModelChat,
  token:           vscode.CancellationToken,
  root:            vscode.Uri
): Promise<FixedFile[]> {
  const filesSection = batch
    .map((f) => `===INPUT_FILE ${f.relPath}===\n${f.content}\n===END_INPUT===`)
    .join("\n\n");

  const rulesSection = checkstyleRules
    ? `\n\n**Reglas Checkstyle configuradas (extracto):**\n\`\`\`xml\n${checkstyleRules.slice(0, 2_500)}\n\`\`\``
    : "\n\n**Reglas:** Aplica el estilo Google Java Style Guide (indentación 4 espacios, espaciado estándar).";

  const prompt = vscode.LanguageModelChatMessage.User(
    `Eres un formatter Java experto. Para cada archivo a continuación aplica ÚNICAMENTE estas correcciones:

**1. JavaDoc:**
- Agrega o completa Javadoc en clases públicas: descripción de la clase en una línea
- Agrega o completa Javadoc en métodos y constructores públicos/protegidos: descripción, @param (uno por parámetro), @return (si no es void), @throws (si lanza excepciones declaradas)
- No documentes getters/setters triviales, ni inner classes privadas

**2. Indentación:**
- 4 espacios por nivel (sin tabs). Reemplaza todos los tabs por 4 espacios

**3. Espaciado:**
- Espacio después de keywords: if, for, while, switch, catch, else
- Espacio alrededor de operadores binarios: =, +=, -=, ==, !=, <, >, <=, >=, &&, ||, +, -, *, /
- Sin espacio entre nombre de método y paréntesis en llamadas: \`metodo(\` no \`metodo (\`
- Espacio después de comas en parámetros y argumentos
- Línea en blanco entre métodos

**4. Variables mal posicionadas (solo si es necesario para checkstyle):**
- Si una variable local está declarada muy lejos de su primer uso, muévela a la línea inmediatamente antes del primer uso
- Solo mueve variables simples (no afectes el scope ni la lógica)

**REGLAS ABSOLUTAS — NUNCA CAMBIES:**
- Lógica de negocio, algoritmos, condiciones
- Nombres de variables, métodos, clases, campos
- Imports y su orden
- Anotaciones y su contenido
- Orden de métodos y clases
- Estructuras de control (if/for/while/switch)
- Tipos de retorno y firmas de métodos
${rulesSection}

Devuelve el contenido COMPLETO de cada archivo corregido usando EXACTAMENTE este formato (sin texto adicional fuera de los delimitadores):

===BEGIN_FILE {ruta relativa del archivo}===
{contenido completo del archivo}
===END_FILE===

Archivos a corregir:

${filesSection}`
  );

  const raw = await callModel(model, prompt, token);
  return parseFixedFiles(raw, batch, root);
}

// ─── AI Fix — Maven error re-fix ──────────────────────────────────────────────

async function fixBatchWithErrors(
  batch:           JavaFile[],
  errorsByFile:    Map<string, MavenError[]>,
  checkstyleRules: string | null,
  model:           vscode.LanguageModelChat,
  token:           vscode.CancellationToken,
  root:            vscode.Uri
): Promise<FixedFile[]> {
  const filesSection = batch.map((f) => {
    const errors = errorsByFile.get(f.relPath) ?? [];
    const errorList = errors
      .map((e) => `  Línea ${e.line}, col ${e.col}: ${e.message} [${e.rule}]`)
      .join("\n");
    return (
      `===INPUT_FILE ${f.relPath}===\n${f.content}\n===END_INPUT===\n\n` +
      `Errores Checkstyle en este archivo:\n${errorList || "  (sin errores específicos)"}`
    );
  }).join("\n\n---\n\n");

  const prompt = vscode.LanguageModelChatMessage.User(
    `Maven Checkstyle reportó los siguientes errores. Corrige ÚNICAMENTE los errores listados por línea/regla. No modifiques nada más.

REGLAS ABSOLUTAS — NUNCA CAMBIES la lógica, nombres, imports, anotaciones, orden de métodos ni algoritmos.

Devuelve el contenido COMPLETO de cada archivo corregido:

===BEGIN_FILE {ruta relativa del archivo}===
{contenido completo del archivo}
===END_FILE===

${filesSection}`
  );

  const raw = await callModel(model, prompt, token);
  return parseFixedFiles(raw, batch, root);
}

// ─── Parse LLM output ─────────────────────────────────────────────────────────

function parseFixedFiles(raw: string, batch: JavaFile[], root: vscode.Uri): FixedFile[] {
  const results: FixedFile[] = [];
  const pattern = /===BEGIN_FILE (.+?)===\n([\s\S]*?)===END_FILE===/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const relPath = match[1].trim();
    const content = match[2];

    // Find the matching original file (by relPath or basename)
    const original = batch.find(
      (f) => f.relPath === relPath ||
             f.relPath.endsWith(relPath) ||
             relPath.endsWith(f.relPath) ||
             shortName(f.relPath) === shortName(relPath)
    );

    if (original) {
      results.push({ relPath: original.relPath, uri: original.uri, content });
    } else {
      // Try to resolve the URI from the relPath directly
      const uri = vscode.Uri.joinPath(root, relPath);
      results.push({ relPath, uri, content });
    }
  }

  return results;
}

// ─── Maven output parsing ─────────────────────────────────────────────────────

function parseMavenCheckstyleErrors(
  output:    string,
  workspace: string,
  allFiles:  FixedFile[]
): MavenError[] {
  const errors: MavenError[] = [];
  // Match: [ERROR] /abs/path/File.java:10:5: message [Rule]
  const pattern = /\[ERROR\]\s+(.+?\.java):(\d+):(\d+):\s+(.+?)\s+\[(\w+)\]/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const rawPath = match[1].trim();
    errors.push({
      filePath: rawPath,
      line:     parseInt(match[2], 10),
      col:      parseInt(match[3], 10),
      message:  match[4].trim(),
      rule:     match[5],
    });
  }

  return errors;
}

function groupErrorsByFile(
  errors:    MavenError[],
  allFiles:  FixedFile[]
): Map<string, MavenError[]> {
  const map = new Map<string, MavenError[]>();

  for (const err of errors) {
    // Match absolute path to a relative path in allFiles
    const matched = allFiles.find((f) =>
      err.filePath.endsWith(f.relPath.replace(/\//g, path.sep)) ||
      err.filePath.includes(f.relPath.replace(/\//g, path.sep)) ||
      err.filePath.endsWith(f.relPath)
    );

    const key = matched?.relPath ?? err.filePath;
    const existing = map.get(key) ?? [];
    existing.push(err);
    map.set(key, existing);
  }

  return map;
}

// ─── File discovery ───────────────────────────────────────────────────────────

async function collectJavaFiles(): Promise<JavaFile[]> {
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles("**/*.java", EXCLUDE_GLOB, MAX_JAVA_FILES);
  } catch { return []; }

  const result: JavaFile[] = [];
  for (const uri of uris) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, MAX_CHARS_JAVA);
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), content });
    } catch { /* skip */ }
  }

  log(`[CheckstyleHandler] Collected ${result.length} Java files`);
  return result;
}

async function readCheckstyleConfig(root: vscode.Uri, configuredPath: string): Promise<string | null> {
  const candidates = configuredPath
    ? [configuredPath]
    : [
        "config/checkstyle/checkstyle.xml",
        "checkstyle.xml",
        "src/main/checkstyle/checkstyle.xml",
        ".checkstyle.xml",
        "build/checkstyle.xml",
      ];

  for (const candidate of candidates) {
    try {
      const uri   = vscode.Uri.joinPath(root, candidate);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text  = Buffer.from(bytes).toString("utf-8");
      log(`[CheckstyleHandler] Checkstyle config found at: ${candidate}`);
      return text;
    } catch { /* not found, try next */ }
  }

  log("[CheckstyleHandler] No checkstyle config found, using defaults");
  return null;
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(
  files:           FixedFile[],
  remainingErrors: MavenError[],
  mavenOutput:     string,
  iterations:      number,
  hadConfig:       boolean
): string {
  const now = new Date().toISOString().split("T")[0];

  const errorsByFile = new Map<string, MavenError[]>();
  for (const e of remainingErrors) {
    const existing = errorsByFile.get(e.filePath) ?? [];
    existing.push(e);
    errorsByFile.set(e.filePath, existing);
  }

  const parts: string[] = [
    `# Reporte Checkstyle`,
    ``,
    `> Generado por \`@company /checkstyle\` el ${now}`,
    `> Config Checkstyle: ${hadConfig ? "✅ Configuración personalizada encontrada" : "⚠️ Sin config — estilo Google/Sun aplicado"}`,
    ``,
    `## Resumen`,
    ``,
    `| Métrica | Valor |`,
    `|---|---|`,
    `| Archivos Java procesados | **${files.length}** |`,
    `| Iteraciones Maven | **${Math.min(iterations + 1, MAX_MAVEN_ITERATIONS)}** |`,
    `| Errores checkstyle restantes | **${remainingErrors.length}** |`,
    `| Estado final | ${remainingErrors.length === 0 ? "✅ Sin errores" : "⚠️ Con errores pendientes"} |`,
    ``,
    `## Archivos corregidos`,
    ``,
    ...files.map((f) => `- \`${f.relPath}\``),
    ``,
  ];

  if (remainingErrors.length > 0) {
    parts.push(`## Errores checkstyle pendientes (${remainingErrors.length})`, ``);

    for (const [file, errs] of errorsByFile) {
      parts.push(`### \`${file}\``, ``);
      for (const e of errs) {
        parts.push(`- **Línea ${e.line}:${e.col}** — ${e.message} \`[${e.rule}]\``);
      }
      parts.push(``);
    }

    parts.push(
      `> **Sugerencia:** Vuelve a ejecutar \`@company /checkstyle\` para continuar iterando,`,
      `> o revisa manualmente los errores listados arriba.`,
      ``
    );
  }

  if (mavenOutput) {
    // Include last 60 lines of Maven output for context
    const outputLines = mavenOutput.split("\n").filter((l) => l.trim());
    const tail = outputLines.slice(-60).join("\n");
    parts.push(
      `## Última salida de Maven (extracto)`,
      ``,
      "```",
      tail,
      "```",
      ``
    );
  }

  parts.push(`---`, `_Fin del reporte — ${files.length} archivos procesados_`);
  return parts.join("\n");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
  return out;
}

function shortName(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

async function callModel(
  model: vscode.LanguageModelChat,
  msg:   vscode.LanguageModelChatMessage,
  token: vscode.CancellationToken
): Promise<string> {
  let result = "";
  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) { result += c; }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[CheckstyleHandler] LLM error: ${err.code}`, err);
    } else {
      logError("[CheckstyleHandler] Unexpected LLM error", err);
    }
  }
  return result;
}

