import * as vscode from "vscode";
import { ConfluenceClient } from "../confluence/client";
import { adfBlocksToText } from "../confluence/adfToText";
import { log, logError } from "../logger";

// ─── Session caches ───────────────────────────────────────────────────────────

const CACHE_TTL_MS  = 15 * 60 * 1000;   // 15 min
const CHUNK_CHARS   = 6_000;             // chars of source text per LLM call

interface SearchHit {
  index: number;   // 1-based display number
  id: string;
  title: string;
  url: string;
  excerpt: string;
  llmSummary: string;
}

interface SearchSession {
  query: string;
  hits: SearchHit[];
  expiresAt: number;
}

interface PageSession {
  pageId: string;
  title: string;
  url: string;
  chunks: string[];
}

// One search session at a time (single-user extension)
let latestSearch: SearchSession | null = null;

// Page content cache keyed by short id
const pageCache = new Map<string, PageSession>();

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Handles @company /search <userArg>
 *
 * Sub-commands:
 *   /search <query>          → Phase 1: CQL search + Copilot ranking → numbered list
 *   /search ver <N>          → Phase 2: fetch page N, show with Copilot (chunk 1)
 *   /search mas <key> <N>    → Phase 3: show chunk N of a previously fetched page
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

  // Phase 3 — paginate already-fetched page
  const masMatch = arg.match(/^mas\s+(\S+)\s+(\d+)$/i);
  if (masMatch) {
    await showPageChunk(masMatch[1], parseInt(masMatch[2], 10), stream, model, token);
    return;
  }

  // Phase 2 — user picks a result
  const verMatch = arg.match(/^ver\s+(\d+)$/i);
  if (verMatch) {
    await fetchAndShowPage(parseInt(verMatch[1], 10), stream, model, token);
    return;
  }

  // Phase 1 — new search
  await searchAndRank(arg, stream, model, token);
}

// ─── Phase 1: search + rank ───────────────────────────────────────────────────

async function searchAndRank(
  query: string,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  stream.progress(`Buscando en todos los espacios de Confluence…`);
  log(`[KbSearch] Phase 1 — query: "${query}"`);

  const client = new ConfluenceClient();
  let raw: Awaited<ReturnType<ConfluenceClient["searchPagesMeta"]>>;

  try {
    raw = await client.searchPagesMeta(query, 10);
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

  stream.progress(`Encontradas ${raw.length} páginas — pidiendo a Copilot que las clasifique…`);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  // Ask Copilot to rank and summarize
  const listText = raw
    .map((p, i) => `${i + 1}. ${p.title}\nExtracto: ${p.excerpt || "(sin extracto)"}`)
    .join("\n\n");

  const rankMsg = vscode.LanguageModelChatMessage.User(
    `El usuario buscó: "${query}"\n\n` +
    `Se encontraron las siguientes páginas en Confluence:\n\n${listText}\n\n` +
    `Clasifica las páginas de mayor a menor relevancia para la consulta del usuario.\n` +
    `Responde ÚNICAMENTE con líneas en este formato exacto (una por página, sin texto adicional):\n` +
    `INDICE|RESUMEN_BREVE_EN_UNA_LINEA\n\n` +
    `Ejemplo:\n` +
    `3|Guía completa de configuración de Kafka para microservicios Java\n` +
    `1|Introducción general a la arquitectura de mensajería\n\n` +
    `Incluye todas las páginas. INDICE es el número original de la lista.`
  );

  let rankResponse = "";
  try {
    const resp = await resolvedModel.sendRequest([rankMsg], {}, token);
    for await (const chunk of resp.text) { rankResponse += chunk; }
  } catch (err) {
    logError("[KbSearch] Copilot ranking failed — using original order", err);
    // Fallback: use original order with excerpt as summary
    rankResponse = raw.map((p, i) => `${i + 1}|${p.excerpt || p.title}`).join("\n");
  }

  // Parse ranking response
  const hits: SearchHit[] = parseRanking(rankResponse, raw);

  // Save session
  latestSearch = {
    query,
    hits,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  setTimeout(() => { latestSearch = null; }, CACHE_TTL_MS);

  // Render results list
  stream.markdown(`## 🔍 Resultados para: *${query}*\n\n`);
  stream.markdown(`Copilot encontró **${hits.length}** páginas relevantes en Confluence:\n\n`);

  for (const hit of hits) {
    stream.markdown(
      `**${hit.index}.** [${hit.title}](${hit.url})\n` +
      `> ${hit.llmSummary}\n\n`
    );
  }

  stream.markdown(
    `---\n` +
    `¿Cuál quieres ver? Responde con el número:\n\n` +
    hits.slice(0, 3).map((h) => `- \`@company /search ver ${h.index}\``).join("\n")
  );

  log(`[KbSearch] Phase 1 done — ${hits.length} hits ranked`);
}

function parseRanking(
  rankText: string,
  raw: Array<{ id: string; title: string; url: string; excerpt: string }>
): SearchHit[] {
  const lines = rankText.split("\n").map((l) => l.trim()).filter(Boolean);
  const ordered: SearchHit[] = [];
  const seen = new Set<number>();

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

  // Add any pages Copilot omitted (fallback)
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

// ─── Phase 2: fetch page + show first chunk ───────────────────────────────────

async function fetchAndShowPage(
  displayN: number,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  if (!latestSearch || Date.now() > latestSearch.expiresAt) {
    stream.markdown(
      `⚠️ La sesión de búsqueda expiró. Ejecuta una nueva búsqueda:\n` +
      `\`@company /search <tu consulta>\``
    );
    return;
  }

  const hit = latestSearch.hits.find((h) => h.index === displayN);
  if (!hit) {
    stream.markdown(
      `⚠️ No encontré la opción **${displayN}**. ` +
      `Los resultados disponibles son: ${latestSearch.hits.map((h) => h.index).join(", ")}.`
    );
    return;
  }

  stream.progress(`Obteniendo contenido completo de "${hit.title}"…`);
  log(`[KbSearch] Phase 2 — fetching page ${hit.id} ("${hit.title}")`);

  const client = new ConfluenceClient();
  let pageText: string;
  try {
    const page = await client.getPage(hit.id);
    pageText = adfBlocksToText(page.adf.content ?? []);
  } catch (err: unknown) {
    logError("[KbSearch] Failed to fetch page", err);
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ No pude obtener la página: \`${msg}\``);
    return;
  }

  if (!pageText.trim()) {
    stream.markdown(`ℹ️ La página **${hit.title}** no tiene contenido de texto.`);
    return;
  }

  // Split into chunks
  const chunks = splitIntoChunks(pageText, CHUNK_CHARS);
  const cacheKey = hit.id.slice(-6);   // short key based on page id
  pageCache.set(cacheKey, {
    pageId: hit.id,
    title:  hit.title,
    url:    hit.url,
    chunks,
  });
  setTimeout(() => pageCache.delete(cacheKey), CACHE_TTL_MS);

  log(`[KbSearch] Page split into ${chunks.length} chunk(s) — key: ${cacheKey}`);
  await showPageChunk(cacheKey, 1, stream, model, token);
}

// ─── Phase 3: show Nth chunk ──────────────────────────────────────────────────

async function showPageChunk(
  cacheKey: string,
  chunkN: number,   // 1-based
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<void> {
  const session = pageCache.get(cacheKey);
  if (!session) {
    stream.markdown(
      `⚠️ El contenido expiró (15 min). Vuelve a seleccionar la página:\n` +
      `\`@company /search ver <N>\``
    );
    return;
  }

  const idx = chunkN - 1;
  if (idx < 0 || idx >= session.chunks.length) {
    stream.markdown(
      `ℹ️ No hay más contenido para esta página. ` +
      `Total de partes: **${session.chunks.length}**.`
    );
    return;
  }

  const chunk     = session.chunks[idx];
  const total     = session.chunks.length;
  const remaining = total - chunkN;

  stream.progress(`Procesando parte ${chunkN}/${total} de "${session.title}"…`);

  const resolvedModel = await resolveModel(model, stream);
  if (!resolvedModel) { return; }

  const isFirst = chunkN === 1;
  const partLabel = total > 1 ? ` (parte ${chunkN} de ${total})` : "";

  const systemMsg = vscode.LanguageModelChatMessage.User(
    `Eres un asistente interno de la empresa. ` +
    `Presenta el siguiente contenido de Confluence de forma clara y estructurada. ` +
    `Conserva la jerarquía de secciones. Usa Markdown. Responde en español.`
  );

  const userMsg = vscode.LanguageModelChatMessage.User(
    (isFirst
      ? `## Página: ${session.title}\n\nURL: ${session.url}\n\n`
      : `## Continuación de: ${session.title}${partLabel}\n\n`) +
    `### Contenido:\n${chunk}`
  );

  if (isFirst) {
    stream.markdown(`## 📄 ${session.title}${partLabel}\n[Ver en Confluence](${session.url})\n\n---\n\n`);
  } else {
    stream.markdown(`## 📄 ${session.title} — Parte ${chunkN}/${total}\n\n---\n\n`);
  }

  try {
    const response = await resolvedModel.sendRequest([systemMsg, userMsg], {}, token);
    for await (const c of response.text) { stream.markdown(c); }
  } catch (err: unknown) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`❌ Error del modelo (\`${err.code}\`): ${err.message}`);
    } else { throw err; }
  }

  if (remaining > 0) {
    const nextN = chunkN + 1;
    stream.markdown(
      `\n\n---\n` +
      `_Mostrando parte **${chunkN}** de **${total}**. Queda${remaining > 1 ? "n" : ""} **${remaining}** parte${remaining > 1 ? "s" : ""} más._\n\n` +
      `¿Quieres ver la siguiente parte?\n` +
      `\`@company /search mas ${cacheKey} ${nextN}\``
    );
  } else {
    stream.markdown(`\n\n---\n_Fin del documento **${session.title}**._`);
  }

  log(`[KbSearch] Phase 3 — shown chunk ${chunkN}/${total} of page ${session.pageId}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) { return [text]; }

  const chunks: string[] = [];
  // Split on double newlines to avoid cutting mid-paragraph
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
    `Busca en todos los espacios de Confluence con lenguaje natural.\n\n` +
    `**Flujo:**\n` +
    `1. \`@company /search <pregunta>\` — busca y muestra una lista de páginas relevantes\n` +
    `2. \`@company /search ver <N>\` — muestra el contenido completo de la página N\n` +
    `3. \`@company /search mas <key> <N>\` — muestra la siguiente parte si el contenido es largo\n\n` +
    `**Ejemplos:**\n` +
    `- \`@company /search cómo configurar kafka\`\n` +
    `- \`@company /search proceso de deploy a producción\`\n` +
    `- \`@company /search estándares para microservicios REST\`\n`
  );
}

// ─── Model resolver ───────────────────────────────────────────────────────────

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
