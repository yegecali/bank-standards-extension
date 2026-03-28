import * as vscode from "vscode";
import * as path   from "path";
import * as fs     from "fs";
import { exec }    from "child_process";
import { promisify } from "util";
import { log, logError } from "../logger";
import { resolveModel } from "../utils/modelResolver";

const execAsync = promisify(exec);

interface ClassCoverage {
  package:    string;
  className:  string;
  lineMissed: number;
  lineCovered: number;
  branchMissed: number;
  branchCovered: number;
  lineRate:   number;
  branchRate: number;
}

/**
 * Handles @company /coverage — runs Maven tests and analyzes JaCoCo coverage report.
 *
 * Flow:
 * 1. Offers to run `mvn test` or just read existing report
 * 2. Reads target/site/jacoco/jacoco.csv (JaCoCo) or target/surefire-reports (Surefire)
 * 3. Parses coverage per class — highlights classes below threshold (default 60%)
 * 4. Uses LLM to suggest what to test for low-coverage classes
 * 5. Outputs coverage table + AI suggestions in chat
 */
export async function handleCoverageCommand(
  stream: vscode.ChatResponseStream,
  model:  vscode.LanguageModelChat,
  token:  vscode.CancellationToken
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    stream.markdown("⚠️ No hay workspace abierto.");
    return;
  }

  const cwd    = folders[0].uri.fsPath;
  const config = vscode.workspace.getConfiguration("companyStandards");
  const mvnExe = (config.get<string>("mavenExecutable") ?? "mvn").trim() || "mvn";
  const coverageThreshold = config.get<number>("coverageThreshold") ?? 60;

  // ── Ask whether to run tests first ──────────────────────────────────────
  const runOption = await vscode.window.showQuickPick(
    [
      {
        label:       "$(play) Ejecutar mvn test primero",
        description: "Compilará y ejecutará todos los tests, luego analizará la cobertura",
        value:       "run",
      },
      {
        label:       "$(graph) Solo leer reporte existente",
        description: "Usa el reporte JaCoCo/Surefire ya generado en target/",
        value:       "read",
      },
    ],
    { title: "Coverage — ¿Ejecutar tests?", placeHolder: "Elige una opción" }
  );

  if (!runOption) {
    stream.markdown("_Análisis de cobertura cancelado._");
    return;
  }

  // ── Optionally run Maven tests ────────────────────────────────────────────
  if (runOption.value === "run") {
    stream.progress("Ejecutando mvn test (puede tardar varios minutos)…");
    stream.markdown(`## ⚙️ Ejecutando tests\n\n\`${mvnExe} test\`\n\n`);

    try {
      const { stdout, stderr } = await execAsync(`${mvnExe} test`, {
        cwd,
        timeout: 300_000, // 5 min
      });
      const output = (stdout + stderr).slice(-2_000); // last 2000 chars
      const buildOk = /BUILD SUCCESS/.test(stdout + stderr);

      if (buildOk) {
        stream.markdown(`✅ **BUILD SUCCESS**\n\n`);
      } else {
        stream.markdown(
          `⚠️ **BUILD con errores** — puede haber tests fallidos.\n\n` +
          `\`\`\`\n${output}\n\`\`\`\n\n` +
          `Continuando con análisis del reporte disponible…\n\n`
        );
      }
      log(`[CoverageHandler] mvn test completed. Success: ${buildOk}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(
        `⚠️ Error al ejecutar Maven: **${msg}**\n\n` +
        `Intentando leer el reporte existente de todas formas…\n\n`
      );
      logError("[CoverageHandler] mvn test failed", err);
    }
  }

  // ── Find and parse JaCoCo CSV ─────────────────────────────────────────────
  stream.progress("Buscando reporte de cobertura JaCoCo…");

  const jacocoCsvPath = path.join(cwd, "target", "site", "jacoco", "jacoco.csv");
  const surefireDir   = path.join(cwd, "target", "surefire-reports");

  let coverageData: ClassCoverage[] = [];
  let reportSource = "";

  if (fs.existsSync(jacocoCsvPath)) {
    reportSource = "JaCoCo (jacoco.csv)";
    coverageData = parseJacocoCsv(jacocoCsvPath);
    log(`[CoverageHandler] Parsed JaCoCo CSV: ${coverageData.length} classes`);
  } else if (fs.existsSync(surefireDir)) {
    reportSource = "Surefire (surefire-reports)";
    coverageData = parseSurefireReports(surefireDir);
    log(`[CoverageHandler] Parsed Surefire: ${coverageData.length} entries`);
  } else {
    stream.markdown(
      `⚠️ No se encontró ningún reporte de cobertura.\n\n` +
      `**Buscado en:**\n` +
      `- \`target/site/jacoco/jacoco.csv\` (JaCoCo)\n` +
      `- \`target/surefire-reports/\` (Surefire)\n\n` +
      `**Para generar el reporte JaCoCo**, agrega el plugin a tu \`pom.xml\`:\n` +
      `\`\`\`xml\n` +
      `<plugin>\n` +
      `  <groupId>org.jacoco</groupId>\n` +
      `  <artifactId>jacoco-maven-plugin</artifactId>\n` +
      `  <executions>\n` +
      `    <execution><goals><goal>prepare-agent</goal></goals></execution>\n` +
      `    <execution><id>report</id><phase>test</phase><goals><goal>report</goal></goals></execution>\n` +
      `  </executions>\n` +
      `</plugin>\n` +
      `\`\`\``
    );
    return;
  }

  if (coverageData.length === 0) {
    stream.markdown(`⚠️ El reporte de cobertura está vacío o no pudo parsearse.`);
    return;
  }

  // ── Build coverage table ──────────────────────────────────────────────────
  stream.markdown(`## 📊 Cobertura de Tests — ${reportSource}\n\n`);

  const belowThreshold = coverageData.filter((c) => c.lineRate < coverageThreshold);
  const above          = coverageData.filter((c) => c.lineRate >= coverageThreshold);
  const avgLine        = coverageData.reduce((s, c) => s + c.lineRate, 0) / coverageData.length;

  // Summary metrics
  stream.markdown(
    `| Métrica | Valor |\n|---|---|\n` +
    `| Clases analizadas | **${coverageData.length}** |\n` +
    `| Cobertura promedio | **${avgLine.toFixed(1)}%** |\n` +
    `| Umbral configurado | **${coverageThreshold}%** |\n` +
    `| Clases bajo umbral | **${belowThreshold.length}** ${belowThreshold.length > 0 ? "⚠️" : "✅"} |\n` +
    `| Clases sobre umbral | **${above.length}** ✅ |\n\n`
  );

  // Low coverage classes table
  if (belowThreshold.length > 0) {
    stream.markdown(`### ⚠️ Clases con cobertura < ${coverageThreshold}%\n\n`);
    stream.markdown(`| Clase | Paquete | Líneas % | Branches % | Líneas faltantes |\n|---|---|---|---|---|\n`);

    const sorted = [...belowThreshold].sort((a, b) => a.lineRate - b.lineRate);
    for (const c of sorted) {
      const lineEmoji   = c.lineRate < 30 ? "🔴" : c.lineRate < 50 ? "🟡" : "🟠";
      stream.markdown(
        `| \`${c.className}\` | \`${c.package}\` | ${lineEmoji} ${c.lineRate.toFixed(1)}% | ${c.branchRate.toFixed(1)}% | ${c.lineMissed} |\n`
      );
    }
    stream.markdown("\n");
  } else {
    stream.markdown(`✅ **Todas las clases superan el umbral de ${coverageThreshold}%**\n\n`);
  }

  // High coverage classes (collapsed)
  if (above.length > 0) {
    stream.markdown(`### ✅ Clases con buena cobertura (≥ ${coverageThreshold}%)\n\n`);
    const topClasses = [...above].sort((a, b) => b.lineRate - a.lineRate).slice(0, 10);
    stream.markdown(`| Clase | Líneas % | Branches % |\n|---|---|---|\n`);
    for (const c of topClasses) {
      stream.markdown(`| \`${c.className}\` | ${c.lineRate.toFixed(1)}% | ${c.branchRate.toFixed(1)}% |\n`);
    }
    if (above.length > 10) {
      stream.markdown(`\n_… y ${above.length - 10} clases más con buena cobertura._\n`);
    }
    stream.markdown("\n");
  }

  // ── AI suggestions for low coverage classes ───────────────────────────────
  if (belowThreshold.length === 0) {
    stream.markdown(`\n🎉 **¡Excelente cobertura!** Todas las clases están sobre el ${coverageThreshold}%.`);
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  stream.progress("Generando sugerencias de tests con IA…");
  stream.markdown(`## 💡 Sugerencias de mejora de cobertura\n\n`);

  const topLow = belowThreshold
    .sort((a, b) => a.lineRate - b.lineRate)
    .slice(0, 8);

  const classesContext = topLow
    .map((c) =>
      `- \`${c.package}.${c.className}\`: ${c.lineRate.toFixed(1)}% líneas (${c.lineMissed} líneas sin cubrir), ${c.branchRate.toFixed(1)}% branches`
    )
    .join("\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un experto en testing de software Java con JUnit 5 y Mockito.\n\n` +
    `Las siguientes clases tienen baja cobertura de tests (umbral: ${coverageThreshold}%):\n\n` +
    `${classesContext}\n\n` +
    `Para cada clase, proporciona:\n` +
    `1. **¿Qué testear?** — Escenarios o casos de uso que probablemente no están cubiertos (happy path, edge cases, errores)\n` +
    `2. **Ejemplo de test** — Un test JUnit 5 + Mockito de ejemplo para el escenario más importante\n\n` +
    `Agrupa las sugerencias por clase. Usa el patrón Triple-AAA (Arrange, Act, Assert).\n` +
    `Responde en español, sé específico y práctico.`
  );

  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const chunk of resp.text) {
      stream.markdown(chunk);
    }
    log(`[CoverageHandler] AI suggestions generated for ${topLow.length} low-coverage classes`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[CoverageHandler] LLM error: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo: ${err.message}`);
      return;
    }
    throw err;
  }
}

// ─── JaCoCo CSV parser ────────────────────────────────────────────────────────

/**
 * Parses JaCoCo jacoco.csv format:
 * GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED,...
 */
function parseJacocoCsv(csvPath: string): ClassCoverage[] {
  try {
    const content = fs.readFileSync(csvPath, "utf-8");
    const lines   = content.trim().split("\n");
    if (lines.length < 2) { return []; }

    const result: ClassCoverage[] = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 9) { continue; }

      // Columns: GROUP(0), PACKAGE(1), CLASS(2), INSTRUCTION_MISSED(3), INSTRUCTION_COVERED(4),
      //          BRANCH_MISSED(5), BRANCH_COVERED(6), LINE_MISSED(7), LINE_COVERED(8), ...
      const packageName  = parts[1]?.trim() ?? "";
      const className    = parts[2]?.trim() ?? "";
      const branchMissed = parseInt(parts[5] ?? "0", 10) || 0;
      const branchCovered = parseInt(parts[6] ?? "0", 10) || 0;
      const lineMissed   = parseInt(parts[7] ?? "0", 10) || 0;
      const lineCovered  = parseInt(parts[8] ?? "0", 10) || 0;

      if (!className || className === "CLASS") { continue; }

      const totalLines   = lineMissed + lineCovered;
      const totalBranches = branchMissed + branchCovered;
      const lineRate     = totalLines   > 0 ? (lineCovered   / totalLines)   * 100 : 100;
      const branchRate   = totalBranches > 0 ? (branchCovered / totalBranches) * 100 : 100;

      result.push({
        package:      packageName,
        className,
        lineMissed,
        lineCovered,
        branchMissed,
        branchCovered,
        lineRate,
        branchRate,
      });
    }

    return result;
  } catch (err: unknown) {
    logError("[CoverageHandler] Failed to parse jacoco.csv", err);
    return [];
  }
}

// ─── Surefire parser ──────────────────────────────────────────────────────────

/**
 * Surefire reports don't contain line coverage — only test results (pass/fail).
 * We parse them to provide a list of test class results instead.
 */
function parseSurefireReports(reportsDir: string): ClassCoverage[] {
  try {
    const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".xml"));
    if (files.length === 0) { return []; }

    const result: ClassCoverage[] = [];

    for (const file of files) {
      const content  = fs.readFileSync(path.join(reportsDir, file), "utf-8");
      const nameMatch = content.match(/name="([^"]+)"/);
      const testsMatch = content.match(/tests="(\d+)"/);
      const failMatch  = content.match(/failures="(\d+)"/);
      const errorMatch = content.match(/errors="(\d+)"/);

      if (!nameMatch) { continue; }

      const className = nameMatch[1].split(".").pop() ?? nameMatch[1];
      const packageName = nameMatch[1].includes(".")
        ? nameMatch[1].substring(0, nameMatch[1].lastIndexOf("."))
        : "";
      const tests   = parseInt(testsMatch?.[1] ?? "0", 10);
      const failing = (parseInt(failMatch?.[1] ?? "0", 10)) + (parseInt(errorMatch?.[1] ?? "0", 10));
      const passing = tests - failing;
      const rate    = tests > 0 ? (passing / tests) * 100 : 100;

      result.push({
        package:       packageName,
        className,
        lineMissed:    failing,
        lineCovered:   passing,
        branchMissed:  0,
        branchCovered: 0,
        lineRate:      rate,
        branchRate:    100,
      });
    }

    return result;
  } catch (err: unknown) {
    logError("[CoverageHandler] Failed to parse surefire reports", err);
    return [];
  }
}
