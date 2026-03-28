import * as vscode from "vscode";
import { ConfluenceClient } from "../confluence/client";
import { adfBlocksToText } from "../confluence/adfToText";
import { log, logError } from "../logger";
import { CACHE } from "../config/defaults";

// ─── Session ──────────────────────────────────────────────────────────────────

interface SearchHit {
  index:      number;   // 1-based display number
  id:         string;
  title:      string;
  url:        string;
  excerpt:    string;
  llmSummary: string;
}

/**
 * Active synthesis session — stores pre-split LLM answer chunks so the user
 * can navigate with a simple `/search mas` (no key/number needed).
 */
interface ActiveSession {
  query:           string;
  hits:            SearchHit[];
  synthesisChunks: string[];   // full LLM answer split by paragraph boundaries
  currentChunk:    number;     // next chunk index to show (0-based)
  expiresAt:       number;
}

/** Backward-compat page cache for `/search ver N` full-page view */
interface PageSession {
  pageId: string;
  title:  string;
  url:    string;
  chunks: string[];
}

let activeSession: ActiveSession | null = null;
const pageCache = new Map<string, PageSession>();

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Handles @company /search <userArg>
 *
 * Sub-commands:
 *   /search <query>          → semantic search + direct synthesized answer
 *   /search mas              → next chunk of active synthesis session
 *   /search ver <N>          → full page view (backward compat)
 *   /search mas <key> <N>    → page chunk view (backward compat)
 */
export async function handleKbSearchCommand(
  userArg: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const arg = userArg.trim();

  if (!arg) {
    showHelp(stream);
    return;
  }

  // Backward compat: /search mas <key> <N>
  const masKeyMatch = arg.match(/^mas\s+(\S+)\s+(\d+)$/i);
  if (masKeyMatch) {
    await showPageChunk(masKeyMatch[1], parseInt(masKeyMatch[2], 10), stream, model, token);
    return;
  }

  // Simple continue: /search mas
  if (arg.toLowerCase() === "mas") {
    await continueSynthesis(stream);
    return;
  }

  // Backward compat: /search ver <N>
  const verMatch = arg.match(/^ver\s+(\d+)$/i);
  if (verMatch) {
    await fetchAndShowPage(parseInt(verMatch[1], 10), stream, model, token);
    return;
  }

  // New search
  await searchAndSynthesize(arg, stream, model, token);
}

// ─── Main search flow ─────────────────────────────────────────────────────────

async function searchAndSynthesize(
  query: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  log(`[KbSearch] New search: "${query}"`);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // 1 — Expand query with AI for better CQL coverage
  stream.progress("Expandiendo búsqueda con IA…");
  const cqlTerms = await expandQuery(query, resolvedModel, token);
  log(`[KbSearch] CQL terms: "${cqlTerms}"`);

  // 2 — CQL search (metadata only, fast)
  stream.progress("Buscando en Confluence…");
  const client = new ConfluenceClient();
  let raw: Awaited<ReturnType<ConfluenceClient["searchPagesMeta"]>>;
  try {
    raw = await client.searchPagesMeta(cqlTerms, 10);
  } catch (err: unknown) {
    logError("[KbSearch] Confluence search failed", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No se pudo conectar a Confluence: \`${msg}\``);
    return;
  }

  if (raw.length === 0) {
    stream.markdown(
      `ℹ️ No encontré páginas relacionadas con **"${query}"** en Confluence.\n\n` +
      `Intenta con términos más generales o verifica tu configuración de Confluence.`
    );
    return;
  }

  // 3 — Rank by relevance
  stream.progress(`Clasificando ${raw.length} páginas por relevancia…`);
  const rankMsg = vscode.LanguageModelChatMessage.User(
    `El usuario buscó: "${query}"\n\n` +
    `Páginas encontradas:\n\n` +
    raw.map((p, i) => `${i + 1}. ${p.title}\nExtracto: ${p.excerpt || "(sin extracto)"}`).join("\n\n") +
    `\n\nClasifica de mayor a menor relevancia. Responde SOLO con líneas:\nINDICE|RESUMEN_BREVE\n\nIncluye todas las páginas.`
  );

  let rankResponse = "";
  try {
    const resp = await resolvedModel.sendRequest([rankMsg], {}, token);
    for await (const c of resp.text) { rankResponse += c; }
  } catch {
    rankResponse = raw.map((p, i) => `${i + 1}|${p.excerpt || p.title}`).join("\n");
  }

  const hits = parseRanking(rankResponse, raw);

  // 4 — Fetch full content of top N pages
  const topN = Math.min(CACHE.TOP_PAGES, hits.length);
  stream.progress(`Leyendo ${topN} páginas relevantes…`);

  const pageContents: Array<{ title: string; url: string; text: string }> = [];
  for (const hit of hits.slice(0, topN)) {
    try {
      const page = await client.getPage(hit.id);
      const text = adfBlocksToText(page.adf.content ?? []).slice(0, CACHE.MAX_PAGE_CHARS);
      pageContents.push({ title: hit.title, url: hit.url, text });
      log(`[KbSearch] Fetched: "${hit.title}" (${text.length} chars)`);
    } catch (err) {
      logError(`[KbSearch] Failed to fetch page ${hit.id}`, err);
    }
  }

  if (pageContents.length === 0) {
    stream.markdown("❌ No se pudo obtener el contenido de las páginas encontradas.");
    return;
  }

  // 5 — Synthesize a direct answer
  stream.progress("Sintetizando respuesta…");
  const synthesis = await synthesizeAnswer(query, pageContents, resolvedModel, token);

  if (!synthesis.trim()) {
    stream.markdown("❌ No se pudo generar una respuesta. Inténtalo de nuevo.");
    return;
  }

  // 6 — Split into chunks and store session
  const chunks = splitIntoChunks(synthesis, CACHE.CHUNK_CHARS);
  activeSession = {
    query,
    hits,
    synthesisChunks: chunks,
    currentChunk:    0,
    expiresAt:       Date.now() + CACHE.TTL_MS,
  };
  setTimeout(() => { activeSession = null; }, CACHE.TTL_MS);

  log(`[KbSearch] Synthesis split into ${chunks.length} chunk(s)`);

  // 7 — Show sources header
  stream.markdown(`## 🔍 Respuesta — *${query}*\n\n`);
  stream.markdown(
    `**Fuentes consultadas:**\n` +
    pageContents.map((p) => `- [${p.title}](${p.url})`).join("\n") +
    `\n\n---\n\n`
  );

  // 8 — Show first chunk
  showSynthesisChunk(chunks[0], 1, chunks.length, stream);
  activeSession.currentChunk = 1;
}

// ─── Synthesize answer ────────────────────────────────────────────────────────

async function synthesizeAnswer(
  query: string,
  pages: Array<{ title: string; url: string; text: string }>,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const pagesContext = pages
    .map((p) => `## ${p.title}\nURL: ${p.url}\n\n${p.text}`)
    .join("\n\n---\n\n");

  const msg = vscode.LanguageModelChatMessage.User(
    `Eres el asistente interno de la empresa. El usuario preguntó:\n**"${query}"**\n\n` +
    `Basándote ÚNICAMENTE en las siguientes páginas de Confluence, genera una respuesta:\n` +
    `- Directa, estructurada y accionable\n` +
    `- Cita la fuente usando [NombrePágina] cuando uses información de esa página\n` +
    `- Si la información no está en las páginas, indícalo claramente\n` +
    `- Usa Markdown con secciones, listas y código donde corresponda\n` +
    `- Responde en el mismo idioma de la pregunta\n\n` +
    `--- PÁGINAS DE CONFLUENCE ---\n\n${pagesContext}`
  );

  let result = "";
  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) { result += c; }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      logError(`[KbSearch] Synthesis LLM error: ${err.code}`, err);
    } else {
      logError("[KbSearch] Synthesis unexpected error", err);
    }
  }
  return result;
}

// ─── Continue synthesis ───────────────────────────────────────────────────────

async function continueSynthesis(
  stream: vscode.ChatResponseStream
): Promise<void> {
  if (!activeSession || Date.now() > activeSession.expiresAt) {
    stream.markdown(
      `⚠️ No hay una búsqueda activa o expiró (15 min).\n\n` +
      `Inicia una nueva: \`@company /search <tu pregunta>\``
    );
    return;
  }

  const { synthesisChunks, currentChunk, query } = activeSession;

  if (currentChunk >= synthesisChunks.length) {
    stream.markdown(
      `ℹ️ Ya mostramos toda la respuesta para **"${query}"**.\n\n` +
      `Para buscar algo nuevo: \`@company /search <nueva pregunta>\``
    );
    return;
  }

  showSynthesisChunk(
    synthesisChunks[currentChunk],
    currentChunk + 1,
    synthesisChunks.length,
    stream
  );
  activeSession.currentChunk++;
}

function showSynthesisChunk(
  chunk: string,
  partN: number,
  total: number,
  stream: vscode.ChatResponseStream
): void {
  stream.markdown(chunk);

  if (partN < total) {
    stream.markdown(
      `\n\n---\n_Parte **${partN}** de **${total}**. Hay más información._\n\n` +
      `\`@company /search mas\``
    );
  } else {
    stream.markdown(`\n\n---\n_Fin de la respuesta._`);
  }
}

// ─── Query expansion ──────────────────────────────────────────────────────────

async function expandQuery(
  query: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<string> {
  const msg = vscode.LanguageModelChatMessage.User(
    `El usuario quiere buscar en Confluence: "${query}"\n\n` +
    `Extrae 2-3 términos de búsqueda clave en español e inglés optimizados para CQL full-text search.\n` +
    `Responde SOLO con los términos separados por espacios, sin explicación.\n` +
    `Ejemplo: "kafka configuración microservicio kafka configuration"`
  );

  let terms = "";
  try {
    const resp = await model.sendRequest([msg], {}, token);
    for await (const c of resp.text) { terms += c; }
    terms = terms.trim().replace(/["\n]/g, " ").trim();
    log(`[KbSearch] Expanded query: "${terms}"`);
  } catch {
    log(`[KbSearch] Query expansion failed — using original`);
    return query;
  }

  return terms || query;
}

// ─── Backward compat: full page view ─────────────────────────────────────────

async function fetchAndShowPage(
  displayN: number,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const hits = activeSession?.hits;
  if (!hits || !activeSession || Date.now() > activeSession.expiresAt) {
    stream.markdown(
      `⚠️ La sesión de búsqueda expiró. Ejecuta una nueva búsqueda:\n` +
      `\`@company /search <tu consulta>\``
    );
    return;
  }

  const hit = hits.find((h) => h.index === displayN);
  if (!hit) {
    stream.markdown(`⚠️ No encontré la opción **${displayN}**. Opciones: ${hits.map((h) => h.index).join(", ")}.`);
    return;
  }

  stream.progress(`Obteniendo contenido completo de "${hit.title}"…`);

  const client = new ConfluenceClient();
  let pageText: string;
  try {
    const page = await client.getPage(hit.id);
    pageText = adfBlocksToText(page.adf.content ?? []);
  } catch (err: unknown) {
    logError("[KbSearch] Failed to fetch page", err);
    stream.markdown(`❌ No pude obtener la página: \`${err instanceof Error ? err.message : String(err)}\``);
    return;
  }

  if (!pageText.trim()) {
    stream.markdown(`ℹ️ La página **${hit.title}** no tiene contenido de texto.`);
    return;
  }

  const chunks   = splitIntoChunks(pageText, CACHE.CHUNK_CHARS);
  const cacheKey = hit.id.slice(-6);
  pageCache.set(cacheKey, { pageId: hit.id, title: hit.title, url: hit.url, chunks });
  setTimeout(() => pageCache.delete(cacheKey), CACHE.TTL_MS);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }
  await showPageChunk(cacheKey, 1, stream, resolvedModel, token);
}

async function showPageChunk(
  cacheKey: string,
  chunkN: number,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const session = pageCache.get(cacheKey);
  if (!session) {
    stream.markdown(`⚠️ El contenido expiró. Vuelve a seleccionar: \`@company /search ver <N>\``);
    return;
  }

  const idx       = chunkN - 1;
  const total     = session.chunks.length;
  const remaining = total - chunkN;

  if (idx < 0 || idx >= total) {
    stream.markdown(`ℹ️ No hay más contenido. Total de partes: **${total}**.`);
    return;
  }

  stream.progress(`Procesando parte ${chunkN}/${total}…`);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  const isFirst  = chunkN === 1;
  const partLabel = total > 1 ? ` (parte ${chunkN} de ${total})` : "";

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Presenta el siguiente contenido de Confluence de forma clara y estructurada. ` +
    `Conserva la jerarquía de secciones. Usa Markdown. Responde en español.`
  );
  const userMsg = vscode.LanguageModelChatMessage.User(
    (isFirst ? `## Página: ${session.title}\nURL: ${session.url}\n\n` : `## Continuación: ${session.title}${partLabel}\n\n`) +
    `### Contenido:\n${session.chunks[idx]}`
  );

  if (isFirst) {
    stream.markdown(`## 📄 ${session.title}${partLabel}\n[Ver en Confluence](${session.url})\n\n---\n\n`);
  } else {
    stream.markdown(`## 📄 ${session.title} — Parte ${chunkN}/${total}\n\n---\n\n`);
  }

  try {
    const resp = await resolvedModel.sendRequest([systemMsg, userMsg], {}, token);
    for await (const c of resp.text) { stream.markdown(c); }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else { throw err; }
  }

  if (remaining > 0) {
    const nextN = chunkN + 1;
    stream.markdown(
      `\n\n---\n_Parte **${chunkN}** de **${total}**._\n\n` +
      `\`@company /search mas ${cacheKey} ${nextN}\``
    );
  } else {
    stream.markdown(`\n\n---\n_Fin del documento **${session.title}**._`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRanking(
  rankText: string,
  raw: Array<{ id: string; title: string; url: string; excerpt: string }>
): SearchHit[] {
  const lines  = rankText.split("\n").map((l) => l.trim()).filter(Boolean);
  const ordered: SearchHit[] = [];
  const seen   = new Set<number>();

  for (const line of lines) {
    const m = line.match(/^(\d+)\|(.+)$/);
    if (!m) { continue; }
    const originalIdx = parseInt(m[1], 10) - 1;
    if (originalIdx < 0 || originalIdx >= raw.length || seen.has(originalIdx)) { continue; }
    seen.add(originalIdx);
    ordered.push({
      index:      ordered.length + 1,
      id:         raw[originalIdx].id,
      title:      raw[originalIdx].title,
      url:        raw[originalIdx].url,
      excerpt:    raw[originalIdx].excerpt,
      llmSummary: m[2].trim(),
    });
  }

  for (let i = 0; i < raw.length; i++) {
    if (!seen.has(i)) {
      ordered.push({
        index:      ordered.length + 1,
        id:         raw[i].id,
        title:      raw[i].title,
        url:        raw[i].url,
        excerpt:    raw[i].excerpt,
        llmSummary: raw[i].excerpt || raw[i].title,
      });
    }
  }

  return ordered;
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) { return [text]; }
  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChars && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) { chunks.push(current.trim()); }
  return chunks;
}

function showHelp(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    `## 🔍 Búsqueda en la base de conocimientos\n\n` +
    `Busca en Confluence con lenguaje natural — Copilot lee las páginas relevantes y responde directamente.\n\n` +
    `**Uso:**\n` +
    `- \`@company /search <pregunta>\` — busca y genera una respuesta sintetizada con citas\n` +
    `- \`@company /search mas\` — muestra la siguiente parte si la respuesta es larga\n` +
    `- \`@company /search ver <N>\` — muestra el contenido completo de la página N del último resultado\n\n` +
    `**Ejemplos:**\n` +
    `- \`@company /search cómo configurar kafka\`\n` +
    `- \`@company /search proceso de deploy a producción\`\n` +
    `- \`@company /search estándares para microservicios REST\`\n`
  );
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
