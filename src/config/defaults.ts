/**
 * Centralized defaults and shared constants for all handlers.
 *
 * Sections:
 *  - File scanning   — extensions, exclusions, priorities
 *  - Batch sizes     — LLM context limits per handler type
 *  - Cache config    — TTL and chunk sizes
 *  - Jira            — pagination
 *  - Code layers     — ordering for document/explain handlers
 *  - Security risks  — default OWASP-based risk list
 */

// ─── File scanning ────────────────────────────────────────────────────────────

/** Source code extensions for analysis (no config files) */
export const SRC_EXTENSIONS = [
  ".java", ".ts", ".kt", ".py", ".cs", ".go", ".js",
];

/** Source code + config/infra extensions (for security scan) */
export const SRC_EXTENSIONS_FULL = [
  ...SRC_EXTENSIONS,
  ".xml", ".yaml", ".yml", ".properties", ".env",
];

/** Glob pattern to exclude non-source directories in all workspace scans */
export const EXCLUDE_GLOB =
  "{**/node_modules/**,**/target/**,**/dist/**,**/out/**,**/.git/**,**/__pycache__/**,**/build/**,**/.next/**}";

/** Same as EXCLUDE_GLOB but also skips test directories (used for security scan) */
export const EXCLUDE_GLOB_NO_TESTS =
  "{**/node_modules/**,**/target/**,**/dist/**,**/out/**,**/.git/**,**/__pycache__/**,**/build/**,**/.next/**,**/test/**,**/__tests__/**,**/spec/**}";

// ─── Batch sizes ──────────────────────────────────────────────────────────────

/**
 * LLM batch/context limits — kept intentionally small to avoid context
 * saturation and hallucinations in Copilot.
 */
export const BATCH = {
  /** General handlers (document, security): files per LLM call */
  FILES_PER_BATCH: 4,

  /** Explain handler: controllers per LLM call (larger files) */
  CONTROLLERS_PER_BATCH: 3,

  /** Max files collected from workspace per scan */
  MAX_FILES: 100,

  /** Max characters read per source file */
  MAX_CHARS_FILE: 4_500,

  /** Max characters for controller files (explain handler) */
  MAX_CHARS_CONTROLLER: 5_000,

  /** Max characters for service files (explain handler iteration 2) */
  MAX_CHARS_SERVICE: 3_000,

  /** Max characters for combined OpenAPI spec */
  MAX_CHARS_OPENAPI: 6_000,
} as const;

// ─── Cache config ─────────────────────────────────────────────────────────────

export const CACHE = {
  /** Session TTL for search/page caches (ms) */
  TTL_MS: 15 * 60 * 1000,

  /** Max characters of page content per LLM chunk (kb search pagination) */
  CHUNK_CHARS: 6_000,

  /** How many top-ranked pages to fetch and read for synthesis */
  TOP_PAGES: 3,

  /** Max characters per page when building synthesis context (leaves room for prompt overhead) */
  MAX_PAGE_CHARS: 4_000,
} as const;

// ─── Jira ─────────────────────────────────────────────────────────────────────

export const JIRA = {
  /** Issues shown per page in /jira search results */
  PAGE_SIZE: 8,
} as const;

// ─── Code layers ──────────────────────────────────────────────────────────────

/**
 * Ordered list of code layer keywords.
 * Used to prioritize and group files in document/explain handlers.
 * Earlier entries = higher priority.
 */
export const LAYER_ORDER = [
  "controller",
  "resource",
  "router",
  "service",
  "usecase",
  "repository",
  "gateway",
  "client",
  "util",
  "helper",
  "other",
] as const;

export type LayerName = typeof LAYER_ORDER[number];

// ─── Security risks ───────────────────────────────────────────────────────────

/**
 * Default security risk checklist for /security command.
 * Format: "Risk Name — description of what to look for"
 * Configurable via companyStandards.securityRisks in settings.
 */
export const DEFAULT_SECURITY_RISKS: string[] = [
  "SQL Injection — consultas construidas con concatenación de strings o sin parámetros preparados",
  "XSS (Cross-Site Scripting) — datos del usuario renderizados sin sanitizar en HTML/JSON",
  "Secrets y credenciales hardcodeadas — contraseñas, tokens, API keys, claves privadas en el código fuente",
  "Autenticación insegura — manejo débil de contraseñas, sesiones sin expiración, tokens predecibles",
  "Exposición de datos sensibles — PII, tokens o datos confidenciales en logs, respuestas de error o endpoints",
  "IDOR / Autorización insuficiente — acceso a recursos sin verificar que el usuario actual es el propietario",
  "Deserialización insegura — datos externos deserializados sin validación de tipo o schema",
  "Validación de entrada insuficiente — datos del usuario usados directamente sin validar formato, longitud o tipo",
  "Inyección de comandos — llamadas a shell, exec() o procesos con input del usuario sin sanitizar",
  "Path Traversal — rutas de archivo construidas con input del usuario sin sanitizar",
  "Configuración insegura — debug mode activo, CORS abierto, cabeceras de seguridad faltantes",
  "Manejo inseguro de errores — stack traces, mensajes internos o información del sistema expuesta al cliente",
  "CSRF — operaciones de escritura sin token de verificación de origen",
  "Race conditions / TOCTOU — operaciones check-then-act sin sincronización",
];
