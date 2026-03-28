import * as vscode from "vscode";
import * as path    from "path";
import { log, logError } from "../logger";
import { createKnowledgeProvider } from "../knowledge/KnowledgeProviderFactory";
import { blocksToMarkdown } from "../notion/parser";
import { resolvePageId } from "../agent/specialtyResolver";
import { resolveModel } from "../utils/modelResolver";

/**
 * Handles @company /generate-test — generates unit tests for the active editor file.
 * Detects language (Java → JUnit 5, TS/JS → Jest), loads testing standards,
 * generates Triple-AAA tests for all public methods, and writes the test file.
 */
export async function handleGenerateTestCommand(
  stream:    vscode.ChatResponseStream,
  model:     vscode.LanguageModelChat,
  specialty: string,
  token:     vscode.CancellationToken
): Promise<void> {
  // ── Get active file ───────────────────────────────────────────────────────
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    stream.markdown(
      `⚠️ No hay ningún archivo abierto.\n\n` +
      `Abre el archivo para el que quieres generar tests y vuelve a ejecutar \`@company /generate-test\`.`
    );
    return;
  }

  const document = editor.document;
  const fileText = document.getText();
  const filePath = document.uri.fsPath;
  const fileName = path.basename(filePath);
  const langId   = document.languageId;
  const relPath  = vscode.workspace.asRelativePath(document.uri);

  if (!fileText.trim()) {
    stream.markdown(`⚠️ El archivo **${fileName}** está vacío.`);
    return;
  }

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // ── Detect framework and infer test file path ─────────────────────────────
  const { framework, testFilePath } = detectTestContext(filePath, langId);

  // ── Load testing standards ────────────────────────────────────────────────
  stream.progress("Cargando estándares de testing…");
  const testingPageId   = resolvePageId("testing", specialty);
  let testingContext    = "";

  if (testingPageId) {
    try {
      const provider = createKnowledgeProvider();
      const page     = await provider.getPage(testingPageId);
      testingContext = blocksToMarkdown(page.blocks).slice(0, 3_500);
      log(`[GenerateTestHandler] Testing standards loaded: ${testingContext.length} chars`);
    } catch (err: unknown) {
      logError("[GenerateTestHandler] Failed to load testing standards", err);
    }
  }

  // ── Check if test file already exists ────────────────────────────────────
  let existingTests = "";
  if (testFilePath) {
    try {
      const testUri  = vscode.Uri.file(testFilePath);
      const bytes    = await vscode.workspace.fs.readFile(testUri);
      existingTests  = Buffer.from(bytes).toString("utf-8").slice(0, 3_000);
      log(`[GenerateTestHandler] Existing test file found: ${testFilePath}`);
    } catch { /* file doesn't exist yet */ }
  }

  // ── Generate tests via LLM ────────────────────────────────────────────────
  stream.progress(`Generando tests para ${fileName}…`);
  stream.markdown(`## 🧪 Tests para \`${relPath}\`\n\n`);
  stream.markdown(
    `| | |\n|---|---|\n` +
    `| Framework | **${framework}** |\n` +
    `| Patrón | **Triple AAA (Arrange → Act → Assert)** |\n` +
    `| Archivo de test | \`${testFilePath ? vscode.workspace.asRelativePath(testFilePath) : "a determinar"}\` |\n\n`
  );

  const systemCtx = testingContext
    ? `Estándares de testing de la compañía:\n${testingContext}\n\n`
    : `Sigue el patrón Triple AAA (Arrange, Act, Assert) con ${framework}.\n\n`;

  const existingCtx = existingTests
    ? `\nTests existentes en el archivo de test (para no duplicar):\n\`\`\`${langId}\n${existingTests}\n\`\`\`\n\n`
    : "";

  const truncated = fileText.slice(0, 5_000);

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres un experto en testing que genera tests de calidad con ${framework}.\n\n` +
    `${systemCtx}` +
    `Genera tests unitarios completos para el siguiente archivo \`${relPath}\`.\n\n` +
    `**Requisitos:**\n` +
    `- Patrón Triple AAA: sección // Arrange, // Act, // Assert en cada test\n` +
    `- Un test por escenario (happy path + casos borde + errores para cada método público)\n` +
    `- Usa mocks/stubs para dependencias externas\n` +
    `- Nombres descriptivos: \`deberia_[resultado]_cuando_[condicion]()\` o \`given_[estado]_when_[accion]_then_[resultado]()\`\n` +
    `- No dupliques tests que ya existen\n` +
    `- Incluye imports necesarios al inicio\n\n` +
    `${existingCtx}` +
    `Genera el archivo de test COMPLETO y listo para compilar:\n\n` +
    `\`\`\`${langId}\n${truncated}\n\`\`\``
  );

  let generatedCode = "";
  try {
    const resp = await resolvedModel.sendRequest([msg], {}, token);
    for await (const chunk of resp.text) {
      stream.markdown(chunk);
      generatedCode += chunk;
    }
    log(`[GenerateTestHandler] Tests generated: ${generatedCode.length} chars`);
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[GenerateTestHandler] LLM error: ${err.code}`, err);
      stream.markdown(`\n❌ Error del modelo: ${err.message}`);
      return;
    }
    throw err;
  }

  // ── Write test file ───────────────────────────────────────────────────────
  if (!testFilePath) {
    stream.markdown(`\n\n_Copia el código generado en tu archivo de tests._`);
    return;
  }

  // Extract code block content from LLM response
  const codeMatch = generatedCode.match(/```(?:\w+)?\n([\s\S]+?)```/);
  const testCode  = codeMatch ? codeMatch[1] : generatedCode;

  if (!testCode.trim()) {
    stream.markdown(`\n\n⚠️ No se detectó código válido en la respuesta. Copia el código manualmente.`);
    return;
  }

  const writeAnswer = await vscode.window.showInformationMessage(
    `¿Escribir el archivo de test en \`${path.relative(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
      testFilePath
    )}\`?`,
    { modal: true },
    "Escribir",
    "Cancelar"
  );

  if (writeAnswer !== "Escribir") {
    stream.markdown(`\n\n_Escritura cancelada. Copia el código generado arriba._`);
    return;
  }

  try {
    // Ensure parent directory exists
    const testUri    = vscode.Uri.file(testFilePath);
    const testDirUri = vscode.Uri.file(path.dirname(testFilePath));
    try { await vscode.workspace.fs.createDirectory(testDirUri); } catch { /* exists */ }

    await vscode.workspace.fs.writeFile(testUri, Buffer.from(testCode, "utf-8"));
    stream.markdown(
      `\n\n✅ Archivo de test escrito: \`${vscode.workspace.asRelativePath(testFilePath)}\`\n\n` +
      `_Ejecuta los tests con tu runner habitual para verificar._`
    );
    log(`[GenerateTestHandler] Test file written: ${testFilePath}`);
  } catch (err: unknown) {
    logError("[GenerateTestHandler] Failed to write test file", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`\n\n❌ No pude escribir el archivo: **${msg}**`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface TestContext {
  framework:    string;
  testFilePath: string | null;
}

function detectTestContext(filePath: string, langId: string): TestContext {
  const ext      = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const dir      = path.dirname(filePath);

  // Java: src/main/java/... → src/test/java/..., append Test
  if (langId === "java" || ext === ".java") {
    const testPath = dir.replace(/src[/\\]main[/\\]java/, "src/test/java");
    return {
      framework:    "JUnit 5 + Mockito",
      testFilePath: path.join(testPath, `${baseName}Test.java`),
    };
  }

  // TypeScript / JavaScript: same dir or __tests__
  if (["typescript", "javascript", "typescriptreact", "javascriptreact"].includes(langId)) {
    return {
      framework:    "Jest",
      testFilePath: path.join(dir, `${baseName}.test${ext}`),
    };
  }

  // Python
  if (langId === "python" || ext === ".py") {
    return {
      framework:    "pytest",
      testFilePath: path.join(dir, `test_${baseName}.py`),
    };
  }

  // Kotlin
  if (langId === "kotlin" || ext === ".kt") {
    const testPath = dir.replace(/src[/\\]main[/\\]kotlin/, "src/test/kotlin");
    return {
      framework:    "JUnit 5 + MockK",
      testFilePath: path.join(testPath, `${baseName}Test.kt`),
    };
  }

  return { framework: "framework estándar del lenguaje", testFilePath: null };
}
