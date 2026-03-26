# Company Coding Standard

> Define and enforce your company's development standards directly in VSCode — powered by your own knowledge base (Notion or Confluence).

**Preview** · [Marketplace](https://marketplace.visualstudio.com/items?itemName=yemicanchari.company-coding-standard)

---

## What it does

This extension connects VSCode to your company's knowledge base (Notion or Confluence) and gives your team an AI agent that enforces standards, generates code, manages Jira issues, and automates repetitive project tasks — all from the chat panel.

---

## Commands at a glance

All commands are invoked via the `@company` agent in the VSCode Chat panel.

### Knowledge & Standards

| Command | What it does |
|---|---|
| `@company /standards` | Fetches and explains your company's naming conventions and coding rules from the knowledge base |
| `@company /review` | Reviews the active editor file against your coding standards |
| `@company /specialty [name]` | Changes the active specialty (backend, frontend, qa) or lists the configured ones |

### Code Generation

| Command | What it does |
|---|---|
| `@company /generate-test` | Generates unit tests for the active file following your test standards (Triple AAA pattern) |
| `@company /docs` | Generates JSDoc/JavaDoc for the active file following your documentation standards |
| `@company /commit` | Suggests a commit message based on staged changes and your commit conventions |
| `@company /create` | Scaffolds a full Maven + Java 21 + Quarkus project from your Notion/Confluence template |

### Prompt Library

| Command | What it does |
|---|---|
| `@company /prompts` | Lists all available prompts from your knowledge base |
| `@company /prompts <name>` | Applies a saved prompt from your knowledge base to the active editor file |

Example prompts you can define: `sonar-vulnerabilities`, `fortify-remediation`, `anti-patterns`, `test-quality`.

### Project Actions

| Command | What it does |
|---|---|
| `@company /project` | Lists all available project actions from your knowledge base |
| `@company /project <action>` | Reads your workspace context (pom.xml, properties, file tree) and applies an AI-driven action defined in your knowledge base |

Examples:
```
@company /project agrega-redis
@company /project agrega-client-rest
@company /project agrega-client-rest configurar para produccion
```

Each action is an H2 heading in your configured `projectActionsPage`. The agent reads your real project files and generates or modifies code accordingly:
- **New files** are created automatically in the workspace
- **Existing files** (pom.xml, application.properties) show suggested changes for manual review

### Jira Integration

| Command | What it does |
|---|---|
| `@company /jira` | Lists issues using a configured JQL query (or default: In Progress issues from your projects) |
| `@company /jira PROJ-123` | Shows full issue detail: description, priority, story points, subtasks, time metrics |
| `@company /jira subtasks PROJ-123` | Lists your subtasks assigned to you on that issue, with a critical age alarm |
| `@company /jira create PROJ-123` | Creates a new subtask under a parent issue |
| `@company /jira update PROJ-123` | Updates the issue's documentation (description, comments) |

### New Feature Workflow

| Command | What it does |
|---|---|
| `@company /new-feature` | Guided flow: select a Jira story, plan and implement it following your company standards |

---

## LM Tools (available in any Copilot chat)

These tools are also available as Copilot tools (no `@company` needed):

| Tool | When it activates |
|---|---|
| `#companyStandards` | User asks about naming conventions or coding rules |
| `#bankReview` | User asks to review or validate a test file |
| `#bankCreate` | User asks to create or scaffold a new project |

---

## VS Code Commands (Command Palette)

| Command | What it does |
|---|---|
| `Company: New Project Guide` | Opens the guided project creation flow |
| `Company: Refresh Standards` | Clears the knowledge cache and reloads from source |
| `Company: Setup Confluence Space` | Wizard to configure which Confluence spaces map to which page types |

---

## Configuration

Open `Settings (Ctrl+,)` and search for `companyStandards`.

### A. Knowledge Source

```json
"companyStandards.knowledgeSource": "notion"  // or "confluence"
```

#### Option A1 — Notion
```json
"companyStandards.notionToken": "secret_xxxx"
```
Get it from [notion.so/my-integrations](https://www.notion.so/my-integrations).

#### Option A2 — Confluence
```json
"companyStandards.confluenceUrl":   "https://yourcompany.atlassian.net",
"companyStandards.confluenceEmail": "you@company.com",
"companyStandards.confluenceToken": "your-api-token"
```
Get your token from [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

Use `Company: Setup Confluence Space` from the Command Palette for a guided setup wizard.

---

### B. Pages Map (per specialty)

Map each specialty to the pages in your knowledge base:

```json
"companyStandards.specialty": "backend",

"companyStandards.specialtiesMap": {
  "backend": {
    "standards": "<page-id>",
    "testing":   "<page-id>",
    "project":   "<page-id>",
    "prompts":   "<page-id>"
  },
  "frontend": {
    "standards": "<page-id>",
    "testing":   "<page-id>"
  },
  "qa": {
    "standards": "<page-id>",
    "testing":   "<page-id>"
  }
}
```

Or use the flat fallback (no specialties):
```json
"companyStandards.pagesMap": {
  "standards": "<page-id>",
  "testing":   "<page-id>",
  "project":   "<page-id>",
  "prompts":   "<page-id>"
}
```

---

### C. Project Actions Page

The `/project` command reads actions from a dedicated page:

```json
"companyStandards.projectActionsPage": "<page-id-or-url>"
```

Structure the page with H2 headings — each becomes an action:

```markdown
## agrega-redis
Lee el pom.xml del proyecto actual.
Agrega la dependencia `io.quarkus:quarkus-redis-client`.
Crea la interfaz `RedisClient` en el paquete principal con métodos get, set, delete.
Configura las propiedades de conexión en application.properties.
Muestra un ejemplo de cómo inyectarla.

Los archivos nuevos deben incluir como primera línea: // filepath: ruta/al/Archivo.java

## agrega-client-rest
Lee el pom.xml y application.properties actuales.
Agrega la dependencia de MicroProfile REST Client.
Crea la interfaz del cliente en src/main/java/.../client/NombreClient.java.
Crea el DAO en src/main/java/.../dao/NombreDao.java.
Agrega la configuración del base-url en application.properties.
```

---

### D. Jira

```json
"companyStandards.jiraUrl":     "https://yourcompany.atlassian.net",
"companyStandards.jiraEmail":   "you@company.com",
"companyStandards.jiraToken":   "your-api-token",
"companyStandards.jiraProject": ["BANK", "DEV"]
```

**Custom JQL** (overrides the default filter):
```json
"companyStandards.jiraJql": "project = BANK AND assignee = currentUser() AND status != Done ORDER BY priority DESC"
```

**Subtask age alarm** (flags subtasks open too long):
```json
"companyStandards.subtaskAgeThresholdDays": 3
```

---

### E. Coding Standards Rules (inline diagnostics)

Rules are applied as inline warnings directly in the editor.

**Naming conventions:**
```json
"companyStandards.namingRules": [
  { "context": "functions",  "convention": "camelCase",   "description": "Functions must use camelCase" },
  { "context": "classes",    "convention": "PascalCase",  "description": "Classes must use PascalCase" },
  { "context": "constants",  "convention": "UPPER_SNAKE", "description": "Constants must use UPPER_SNAKE_CASE" },
  { "context": "interfaces", "convention": "PascalCase",  "description": "Interfaces must use PascalCase" }
]
```

Available contexts: `functions`, `variables`, `constants`, `classes`, `interfaces`, `types`, `enums`, `enum members`, `methods`, `parameters`, `private fields`, `test functions`

Available conventions: `camelCase`, `PascalCase`, `snake_case`, `UPPER_SNAKE`, `kebab-case`

**Additional rules:**
```json
"companyStandards.additionalRules": {
  "disallowConsoleLog":    true,   // warn on console.log in production code
  "maxLineLength":         120,    // warn if lines exceed 120 chars
  "interfacePrefix":       "forbidden",  // "required" | "forbidden" | "optional"
  "disallowTodoComments":  true,   // warn on TODO/FIXME/HACK comments
  "disallowEmptyCatch":    true,   // warn on empty catch blocks
  "disallowExplicitAny":   true    // warn on explicit `any` in TypeScript
}
```

---

## Prompt Library — page format

Structure your prompts page with H2 headings. The body becomes the prompt template:

```markdown
## sonar-vulnerabilidades
Analiza el código del archivo activo buscando vulnerabilidades reportadas por SonarQube.
Para cada vulnerabilidad encontrada explica: qué es, por qué es un riesgo, y cómo corregirla.

## fortify-remediation
Revisa el archivo activo e identifica problemas detectables por Fortify Static Code Analyzer:
inyecciones SQL, XSS, manejo inseguro de credenciales, etc.

## calidad-de-tests
Evalúa la calidad de los tests del archivo activo. Verifica:
- Que sigan el patrón Triple AAA (Arrange, Act, Assert)
- Que los nombres sean descriptivos
- Que no haya lógica de negocio en los tests
```

Use `@company /prompts` to list them, `@company /prompts <name>` to apply one.

---

## Requirements

- VSCode 1.90+
- GitHub Copilot (Chat) extension active
- Notion or Confluence account with an integration token

---

## License

MIT
