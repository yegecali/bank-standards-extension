import * as vscode from "vscode";
import { log, logError } from "../logger";
import { BATCH, EXCLUDE_GLOB_NO_TESTS, SRC_EXTENSIONS_FULL, DEFAULT_SECURITY_RISKS } from "../config/defaults";

const OUTPUT_PATH = "docs/security-report.md";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceFile {
  uri:     vscode.Uri;
  relPath: string;
  name:    string;
  content: string;
}

interface BatchFinding {
  batchIndex:   number;
  fileNames:    string[];
  rawFindings:  string;      // iteration 1
  deepFindings: string;      // iteration 2
}

interface RiskSummaryEntry {
  risk:      string;
  status:    "✅" | "⚠️" | "❌";
  files:     string[];
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleSecurityCommand(
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    stream.markdown("⚠️ No hay workspace abierto.");
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // ── Load configured risks ─────────────────────────────────────────────────
  const config = vscode.workspace.getConfiguration("companyStandards");
  const risks: string[] = config.get<string[]>("securityRisks") ?? DEFAULT_SECURITY_RISKS;

  // ── Discovery ─────────────────────────────────────────────────────────────
  stream.progress("Buscando archivos fuente para análisis de seguridad…");
  const files = await collectSourceFiles();

  if (files.length === 0) {
    stream.markdown("ℹ️ No encontré archivos de código fuente en el workspace.");
    return;
  }

  const batches = chunk(files, BATCH.FILES_PER_BATCH);

  stream.markdown(
    `## 🔐 Análisis de seguridad\n\n` +
    `| | |\n|---|---|\n` +
    `| Archivos analizados | **${files.length}** |\n` +
    `| Lotes | **${batches.length}** (${BATCH.FILES_PER_BATCH} archivos c/u) |\n` +
    `| Riesgos configurados | **${risks.length}** |\n\n` +
    `**Riesgos a evaluar:**\n` +
    risks.map((r) => `- ${r.split(" — ")[0]}`).join("\n") +
    `\n\nSe procesará en **2 iteraciones**: detección inicial → análisis profundo con soluciones.\n\n`
  );

  log(`[SecurityHandler] ${files.length} files, ${batches.length} batches, ${risks.length} risks`);

  // ── Iteration 1: detect issues ────────────────────────────────────────────
  stream.markdown(`### Iteración 1 — Detectando vulnerabilidades por lote…\n\n`);
  const batchFindings: BatchFinding[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (token.isCancellationRequested) { break; }
    const batch = batches[i];
    const names = batch.map((f) => f.name);
    stream.progress(`Escaneando lote ${i + 1}/${batches.length}: ${names.join(", ")}…`);

    const raw = await scanBatch(batch, risks, resolvedModel, token);
    batchFindings.push({ batchIndex: i, fileNames: names, rawFindings: raw, deepFindings: "" });

    const issueCount = countIssues(raw);
    const icon = issueCount === 0 ? "✅" : issueCount <= 2 ? "⚠️" : "❌";
    stream.markdown(`- ${icon} Lote ${i + 1}: \`${names.join("`, `")}\` — ${issueCount} hallazgo(s)\n`);
    log(`[SecurityHandler] Batch ${i + 1} iteration 1 done — ${issueCount} issues`);
  }

  // ── Iteration 2: deep analysis + remediation ──────────────────────────────
  stream.markdown(`\n### Iteración 2 — Análisis profundo y soluciones…\n\n`);

  for (let i = 0; i < batchFindings.length; i++) {
    if (token.isCancellationRequested) { break; }
    const result = batchFindings[i];
    stream.progress(`Analizando en profundidad lote ${i + 1}/${batchFindings.length}…`);

    const deep = await deepAnalysis(batches[i], result.rawFindings, risks, resolvedModel, token);
    result.deepFindings = deep;

    stream.markdown(`- ✅ Lote ${i + 1} analizado en profundidad\n`);
    log(`[SecurityHandler] Batch ${i + 1} iteration 2 done (${deep.length} chars)`);
  }

  // ── Build summary + write file ────────────────────────────────────────────
  stream.progress("Generando reporte de seguridad…");
  const allFindings = batchFindings.map((r) => r.deepFindings || r.rawFindings).join("\n\n");
  const summary     = buildRiskSummary(risks, allFindings, batchFindings);
  const fileContent = buildOutputFile(summary, allFindings, risks, files.length);

  try {
    const root    = folders[0].uri;
    const docsDir = vscode.Uri.joinPath(root, "docs");
    const outFile = vscode.Uri.joinPath(root, OUTPUT_PATH);

    try { await vscode.workspace.fs.createDirectory(docsDir); } catch { /* exists */ }
    await vscode.workspace.fs.writeFile(outFile, Buffer.from(fileContent, "utf-8"));

    log(`[SecurityHandler] Written to ${OUTPUT_PATH}`);

    // Show inline summary table
    const critical = summary.filter((s) => s.status === "❌").length;
    const warnings = summary.filter((s) => s.status === "⚠️").length;
    const passing  = summary.filter((s) => s.status === "✅").length;

    const overallIcon = critical > 0 ? "🔴" : warnings > 0 ? "🟡" : "🟢";

    stream.markdown(
      `\n---\n` +
      `## ${overallIcon} Resultado del análisis\n\n` +
      `| Estado | Cantidad |\n|---|---|\n` +
      `| ❌ Crítico/Alto | **${critical}** |\n` +
      `| ⚠️ Medio | **${warnings}** |\n` +
      `| ✅ Cumple | **${passing}** |\n\n` +
      `### Resumen por riesgo\n\n` +
      `| Riesgo | Estado | Archivos |\n|---|---|---|\n` +
      summary.map((s) =>
        `| ${s.risk} | ${s.status} | ${s.files.length > 0 ? s.files.slice(0, 3).map((f) => `\`${f}\``).join(", ") : "—"} |`
      ).join("\n") +
      `\n\n📄 Reporte completo con soluciones: \`${OUTPUT_PATH}\``
    );
  } catch (err: unknown) {
    logError("[SecurityHandler] Failed to write file", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude escribir el archivo: \`${msg}\``);
  }
}

// ─── Iteration 1: scan for issues ────────────────────────────────────────────

async function scanBatch(
  batch: SourceFile[],
  risks: string[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const filesSection = batch
    .map((f) => `### ${f.name} (${f.relPath})\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const riskList = risks.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Actúas simultáneamente como:\n` +
    `1. **Analista de seguridad senior** especializado en OWASP Top 10, SANS Top 25 y seguridad en aplicaciones bancarias/financieras.\n` +
    `2. **Desarrollador senior** con fuertes conocimientos de secure coding, capaz de proponer soluciones concretas en el mismo lenguaje del código.\n\n` +

    `Analiza los siguientes archivos fuente en busca de estos riesgos de seguridad:\n${riskList}\n\n` +

    `FORMATO DE SALIDA OBLIGATORIO — un bloque por hallazgo, exactamente así:\n\n` +
    `## FINDING\n` +
    `ARCHIVO: ruta/relativa/al/archivo\n` +
    `RIESGO: nombre exacto del riesgo de la lista\n` +
    `SEVERIDAD: CRÍTICO|ALTO|MEDIO|BAJO\n` +
    `LINEA_APROX: número o rango de líneas\n` +
    `DESCRIPCION: descripción técnica precisa del problema encontrado\n` +
    `CODIGO_VULNERABLE:\n` +
    "```\n" +
    `fragmento exacto del código problemático\n` +
    "```\n" +
    `CUMPLE: SÍ|NO|PARCIAL\n\n` +

    `Si un archivo no tiene hallazgos para un riesgo, NO generes un bloque para ese riesgo en ese archivo.\n` +
    `Si no encuentras ningún hallazgo en el lote completo, escribe: SIN_HALLAZGOS\n` +
    `Sé minucioso: revisa también archivos de configuración, propiedades y variables de entorno.\n\n` +

    `${filesSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Iteration 2: deep analysis + remediation ─────────────────────────────────

async function deepAnalysis(
  batch: SourceFile[],
  rawFindings: string,
  risks: string[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  if (rawFindings.trim() === "SIN_HALLAZGOS" || rawFindings.trim() === "") {
    return rawFindings;
  }

  const filesSection = batch
    .map((f) => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Actúas como analista de seguridad senior y desarrollador experto en secure coding.\n\n` +
    `Tienes los hallazgos preliminares de un análisis de seguridad y el código fuente original.\n` +
    `Tu tarea es:\n` +
    `1. **Confirmar o descartar** cada hallazgo — algunos pueden ser falsos positivos\n` +
    `2. **Profundizar** el análisis: ¿es explotable? ¿cuál es el vector de ataque real?\n` +
    `3. **Agregar el impacto** de negocio si se explota esta vulnerabilidad\n` +
    `4. **Proveer solución concreta** con código corregido en el mismo lenguaje\n` +
    `5. **Agregar referencias** OWASP, CWE o CVE relevantes\n\n` +

    `FORMATO DE SALIDA OBLIGATORIO — enriquece cada bloque FINDING existente:\n\n` +
    `## FINDING\n` +
    `ARCHIVO: ruta/relativa/al/archivo\n` +
    `RIESGO: nombre del riesgo\n` +
    `SEVERIDAD: CRÍTICO|ALTO|MEDIO|BAJO\n` +
    `LINEA_APROX: número o rango\n` +
    `ESTADO: CONFIRMADO|FALSO_POSITIVO|PARCIAL\n` +
    `DESCRIPCION: descripción técnica detallada y vector de ataque\n` +
    `IMPACTO: qué puede hacer un atacante si explota esto\n` +
    `CODIGO_VULNERABLE:\n` +
    "```\n" +
    `fragmento del código problemático\n` +
    "```\n" +
    `SOLUCION:\n` +
    "```\n" +
    `código corregido completo y listo para usar\n` +
    "```\n" +
    `NOTAS_SOLUCION: pasos adicionales si los hay (configuración, dependencias, etc.)\n` +
    `REFERENCIA: OWASP A0X:2021 — Nombre | CWE-XXX\n` +
    `CUMPLE: SÍ|NO|PARCIAL\n\n` +

    `Si un hallazgo es FALSO_POSITIVO, explica por qué en DESCRIPCION y omite CODIGO_VULNERABLE y SOLUCION.\n\n` +
    `--- HALLAZGOS PRELIMINARES ---\n${rawFindings}\n\n` +
    `--- CÓDIGO FUENTE ORIGINAL ---\n${filesSection}`
  );

  return await callModel(model, msg, token);
}

// ─── Build risk summary ───────────────────────────────────────────────────────

function buildRiskSummary(risks: string[], allFindings: string, batches: BatchFinding[]): RiskSummaryEntry[] {
  return risks.map((risk) => {
    const riskName = risk.split(" — ")[0].toLowerCase();
    const findings = [...allFindings.matchAll(/## FINDING[\s\S]*?(?=## FINDING|$)/gm)];

    const matchingFindings = findings.filter((f) => {
      const block = f[0].toLowerCase();
      return block.includes(riskName) || riskName.split(" ").some((w) => w.length > 3 && block.includes(w));
    });

    const confirmed = matchingFindings.filter((f) => {
      const block = f[0];
      return /ESTADO:\s*CONFIRMADO/i.test(block) || /CUMPLE:\s*NO/i.test(block);
    });

    const partial = matchingFindings.filter((f) => {
      const block = f[0];
      return /ESTADO:\s*PARCIAL/i.test(block) || /CUMPLE:\s*PARCIAL/i.test(block);
    });

    const affectedFiles = [...new Set(
      matchingFindings
        .map((f) => f[0].match(/ARCHIVO:\s*(.+)/)?.[1]?.trim().split("/").pop() ?? "")
        .filter((f) => f && !/FALSO_POSITIVO/i.test(f))
    )];

    let status: "✅" | "⚠️" | "❌";
    if (confirmed.length > 0) {
      const hasCritical = confirmed.some((f) => /SEVERIDAD:\s*(CRÍTICO|ALTO)/i.test(f[0]));
      status = hasCritical ? "❌" : "⚠️";
    } else if (partial.length > 0) {
      status = "⚠️";
    } else {
      status = "✅";
    }

    return { risk: risk.split(" — ")[0], status, files: affectedFiles };
  });
}

// ─── Build output markdown file ───────────────────────────────────────────────

function buildOutputFile(
  summary: RiskSummaryEntry[],
  allFindings: string,
  risks: string[],
  fileCount: number
): string {
  const now      = new Date().toISOString().split("T")[0];
  const critical = summary.filter((s) => s.status === "❌").length;
  const warnings = summary.filter((s) => s.status === "⚠️").length;
  const passing  = summary.filter((s) => s.status === "✅").length;
  const overall  = critical > 0 ? "🔴 REQUIERE ACCIÓN INMEDIATA" : warnings > 0 ? "🟡 REVISAR" : "🟢 APROBADO";

  const parts: string[] = [
    `# Reporte de Seguridad`,
    ``,
    `> Generado por \`@company /security\` el ${now}`,
    `> Archivos analizados: **${fileCount}** | Riesgos evaluados: **${risks.length}**`,
    ``,
    `## Estado general: ${overall}`,
    ``,
    `| Estado | Cantidad |`,
    `|--------|----------|`,
    `| ❌ Crítico/Alto | ${critical} |`,
    `| ⚠️ Medio | ${warnings} |`,
    `| ✅ Cumple | ${passing} |`,
    ``,
    `---`,
    ``,
    `## Resumen por riesgo`,
    ``,
    `| Riesgo | Estado | Archivos afectados |`,
    `|--------|--------|--------------------|`,
    ...summary.map((s) =>
      `| ${s.risk} | ${s.status} | ${s.files.length > 0 ? s.files.map((f) => `\`${f}\``).join(", ") : "—"} |`
    ),
    ``,
    `---`,
    ``,
    `## Hallazgos detallados`,
    ``,
  ];

  // Format findings as readable markdown
  const findingBlocks = [...allFindings.matchAll(/## FINDING[\s\S]*?(?=## FINDING|$)/gm)];
  const confirmed     = findingBlocks.filter((f) => !/FALSO_POSITIVO/i.test(f[0]) && !/ESTADO:\s*FALSO/i.test(f[0]));
  const falsePos      = findingBlocks.filter((f) => /FALSO_POSITIVO/i.test(f[0]) || /ESTADO:\s*FALSO/i.test(f[0]));

  if (confirmed.length === 0) {
    parts.push(`_No se encontraron vulnerabilidades confirmadas en el análisis._`);
  } else {
    // Sort: CRÍTICO → ALTO → MEDIO → BAJO
    const severityOrder: Record<string, number> = { CRÍTICO: 0, ALTO: 1, MEDIO: 2, BAJO: 3 };
    confirmed.sort((a, b) => {
      const sa = a[0].match(/SEVERIDAD:\s*(\w+)/i)?.[1]?.toUpperCase() ?? "BAJO";
      const sb = b[0].match(/SEVERIDAD:\s*(\w+)/i)?.[1]?.toUpperCase() ?? "BAJO";
      return (severityOrder[sa] ?? 4) - (severityOrder[sb] ?? 4);
    });

    for (const finding of confirmed) {
      parts.push(formatFinding(finding[0]));
    }
  }

  if (falsePos.length > 0) {
    parts.push(``, `---`, ``, `## Falsos positivos descartados`, ``);
    for (const f of falsePos) {
      const archivo = f[0].match(/ARCHIVO:\s*(.+)/)?.[1]?.trim() ?? "desconocido";
      const riesgo  = f[0].match(/RIESGO:\s*(.+)/)?.[1]?.trim() ?? "desconocido";
      const desc    = f[0].match(/DESCRIPCION:\s*(.+)/)?.[1]?.trim() ?? "";
      parts.push(`- **${riesgo}** en \`${archivo}\`: ${desc}`);
    }
  }

  parts.push(``, `---`);
  parts.push(`_Reporte generado automáticamente. Valida los hallazgos con tu equipo de seguridad antes de cerrarlos._`);

  return parts.join("\n");
}

function formatFinding(block: string): string {
  const get  = (key: string) => block.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim() ?? "";
  const getMultiline = (key: string) => {
    const m = block.match(new RegExp(`${key}:[\\s\\S]*?(?=\\n[A-Z_]+:|$)`));
    return m ? m[0].replace(`${key}:`, "").trim() : "";
  };

  const archivo    = get("ARCHIVO");
  const riesgo     = get("RIESGO");
  const severidad  = get("SEVERIDAD");
  const linea      = get("LINEA_APROX");
  const descripcion = get("DESCRIPCION");
  const impacto    = get("IMPACTO");
  const referencia = get("REFERENCIA");
  const cumple     = get("CUMPLE");
  const notas      = get("NOTAS_SOLUCION");

  const sevIcon: Record<string, string> = { CRÍTICO: "🔴", ALTO: "🟠", MEDIO: "🟡", BAJO: "🔵" };
  const icon = sevIcon[severidad.toUpperCase()] ?? "⚪";

  // Extract code blocks
  const codeBlocks = [...block.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
  const vulnCode   = codeBlocks[0] ?? "";
  const fixCode    = codeBlocks[1] ?? "";

  const lines: string[] = [
    `### ${icon} ${riesgo} — \`${archivo.split("/").pop()}\``,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Archivo** | \`${archivo}\` |`,
    `| **Severidad** | ${icon} ${severidad} |`,
    `| **Línea aprox.** | ${linea || "—"} |`,
    `| **Cumple** | ${cumple === "SÍ" ? "✅ Sí" : cumple === "PARCIAL" ? "⚠️ Parcial" : "❌ No"} |`,
    `| **Referencia** | ${referencia || "—"} |`,
    ``,
    `**Descripción:** ${descripcion}`,
    ``,
  ];

  if (impacto) {
    lines.push(`**Impacto si se explota:** ${impacto}`, ``);
  }

  if (vulnCode) {
    lines.push(`**Código vulnerable:**`, vulnCode, ``);
  }

  if (fixCode) {
    lines.push(`**Solución:**`, fixCode, ``);
  }

  if (notas) {
    lines.push(`> ℹ️ ${notas}`, ``);
  }

  lines.push(`---`, ``);
  return lines.join("\n");
}

function countIssues(findings: string): number {
  if (findings.trim() === "SIN_HALLAZGOS") { return 0; }
  return (findings.match(/## FINDING/g) ?? []).length;
}

// ─── File discovery ───────────────────────────────────────────────────────────

async function collectSourceFiles(): Promise<SourceFile[]> {
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(
      `**/*.{${SRC_EXTENSIONS_FULL.map((e) => e.slice(1)).join(",")}}`,
      EXCLUDE_GLOB_NO_TESTS,
      BATCH.MAX_FILES
    );
  } catch { return []; }

  // Prioritize: config files first (secrets), then controllers, then services
  const priorityScore = (uri: vscode.Uri): number => {
    const name = uri.path.toLowerCase();
    if (name.endsWith(".env") || name.includes("application.properties") || name.includes("application.yml")) { return 100; }
    if (name.includes("config") || name.includes("security") || name.includes("auth")) { return 80; }
    if (name.includes("controller") || name.includes("resource") || name.includes("router")) { return 60; }
    if (name.includes("service") || name.includes("repository")) { return 40; }
    return 10;
  };

  uris.sort((a, b) => priorityScore(b) - priorityScore(a));

  const result: SourceFile[] = [];
  for (const uri of uris.slice(0, BATCH.MAX_FILES)) {
    try {
      const bytes   = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8").slice(0, BATCH.MAX_CHARS_FILE);
      const name    = uri.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      result.push({ uri, relPath: vscode.workspace.asRelativePath(uri), name, content });
    } catch { /* skip */ }
  }

  log(`[SecurityHandler] Collected ${result.length} files`);
  return result;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
  return out;
}

async function callModel(
  model: vscode.LanguageModelChat,
  msg: vscode.LanguageModelChatMessage,
  token: vscode.CancellationToken
): Promise<string> {
  let result = "";
  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) { result += c; }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[SecurityHandler] LLM error: ${err.code}`, err);
    } else {
      logError("[SecurityHandler] Unexpected LLM error", err);
    }
  }
  return result;
}

async function resolveModel(
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream
): Promise<vscode.LanguageModelChat | null> {
  if (model.id !== "auto") { return model; }
  stream.progress("Seleccionando modelo de lenguaje…");
  for (const selector of [
    { vendor: "copilot", family: "gpt-4o" },
    { vendor: "copilot", family: "gpt-4" },
    { vendor: "copilot", family: "claude-sonnet" },
    {},
  ]) {
    const models = await vscode.lm.selectChatModels(selector);
    if (models.length > 0) { return models[0]; }
  }
  stream.markdown("❌ No hay modelos de lenguaje disponibles. Activa GitHub Copilot.");
  return null;
}
