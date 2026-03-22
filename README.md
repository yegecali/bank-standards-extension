# Bank Standards Extension

VSCode extension that connects to your bank's knowledge base (Notion or Confluence) to enforce coding standards, validate naming conventions, scaffold projects, and apply a library of saved prompts — all via a built-in AI agent.

---

## Requirements

- VS Code `1.90.0` or higher
- GitHub Copilot extension (active subscription) — required for the `@bank` agent
- A Notion integration token **or** Confluence API credentials

---

## Installation

1. Open VS Code
2. Go to **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **Bank Standards Extension**
4. Click **Install**

---

## Configuration

Open your VS Code settings (`Ctrl+,`) and search for `companyStandards`, or add the following to your `settings.json`.

### Option A — Notion

```json
{
  "companyStandards.knowledgeSource": "notion",
  "companyStandards.notionToken": "secret_xxxxxxxxxxxxxxxxxxxx",
  "companyStandards.pagesMap": {
    "standards": "<notion-page-id>",
    "project":   "<notion-page-id>",
    "testing":   "<notion-page-id>",
    "prompts":   "<notion-page-id>"
  }
}
```

#### How to get a Notion integration token

1. Go to [notion.so/my-integrations](https://notion.so/my-integrations)
2. Click **+ New integration**
3. Copy the **Internal Integration Token** (`secret_...`)

#### How to get a Notion Page ID

From the page URL:
```
https://notion.so/My-Page-Title-<PAGE_ID>
                                 ^^^^^^^^
```
Copy the last segment (32-char UUID, with or without hyphens).

#### How to connect your integration to a page

1. Open the Notion page
2. Click `•••` (top-right menu)
3. **Connections → Add connection** → select your integration
4. Repeat for each page in `pagesMap`

---

### Option B — Confluence

```json
{
  "companyStandards.knowledgeSource": "confluence",
  "companyStandards.confluenceUrl":   "https://yourbank.atlassian.net",
  "companyStandards.confluenceEmail": "you@yourbank.com",
  "companyStandards.confluenceToken": "<atlassian-api-token>",
  "companyStandards.pagesMap": {
    "standards": "123456789",
    "project":   "987654321",
    "testing":   "111222333",
    "prompts":   "444555666"
  }
}
```

#### How to get a Confluence API token

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Copy the generated token

#### How to get a Confluence Page ID

From the page URL:
```
https://yourbank.atlassian.net/wiki/spaces/SPACE/pages/123456789/Page+Title
                                                        ^^^^^^^^^
```
Copy the numeric segment.

---

### Option C — Multiple specialties (frontend / backend / qa)

If your teams have separate documentation pages per specialty, use `specialtiesMap` instead of `pagesMap`:

```json
{
  "companyStandards.knowledgeSource": "notion",
  "companyStandards.notionToken": "secret_xxxxxxxxxxxxxxxxxxxx",
  "companyStandards.specialty": "backend",
  "companyStandards.specialtiesMap": {
    "backend": {
      "standards": "<notion-page-id>",
      "testing":   "<notion-page-id>",
      "project":   "<notion-page-id>",
      "prompts":   "<notion-page-id>"
    },
    "frontend": {
      "standards": "<notion-page-id>",
      "testing":   "<notion-page-id>",
      "prompts":   "<notion-page-id>"
    },
    "qa": {
      "testing": "<notion-page-id>",
      "prompts": "<notion-page-id>"
    }
  }
}
```

Each specialty only needs to define the page types it uses — missing keys fall back to `pagesMap`.

#### Switching specialty

```
@bank /specialty              ← list all configured specialties
@bank /specialty frontend     ← switch to frontend
@bank /specialty qa           ← switch to qa
```

Or update `companyStandards.specialty` in settings directly.

---

### All settings

| Setting | Type | Description |
|---|---|---|
| `knowledgeSource` | `"notion"` \| `"confluence"` | Knowledge backend to use |
| `notionToken` | `string` | Notion integration token |
| `confluenceUrl` | `string` | Confluence Cloud base URL |
| `confluenceEmail` | `string` | Atlassian account email |
| `confluenceToken` | `string` | Atlassian API token |
| `specialty` | `string` | Active specialty (`backend`, `frontend`, `qa`, …). Default: `backend` |
| `specialtiesMap` | `object` | Per-specialty page IDs (preferred over `pagesMap`) |
| `pagesMap.standards` | `string` | Page ID with naming convention rules |
| `pagesMap.project` | `string` | Page ID with project template |
| `pagesMap.testing` | `string` | Page ID with test standards |
| `pagesMap.prompts` | `string` | Page ID with the prompt library |

---

## Features

### Inline diagnostics

Automatically validates naming conventions on file **open** and **save** for TypeScript, JavaScript, TSX, JSX, and Java.

| Pattern | Convention | Example |
|---|---|---|
| Functions / arrow functions | `camelCase` | `getUserData` |
| Variables (`let`, `var`) | `camelCase` | `userName` |
| Classes | `PascalCase` | `UserService` |
| Constants (`const`) | `UPPER_SNAKE` | `MAX_RETRIES` |
| Jest tests (`it`, `test`) | `camelCase` | `shouldReturnUser` |
| Java methods | `camelCase` | `findUserById` |
| JUnit `@Test` methods | `camelCase` | `shouldThrowWhenNull` |

Click the lightbulb (`Ctrl+.`) on a violation to **Fix this occurrence** or **Fix all in file**.

### @bank agent

Chat participant available in GitHub Copilot Chat:

```
@bank /standards          ← naming conventions
@bank /review             ← review active file against bank standards
@bank /create             ← scaffold a Maven + Java 21 + Quarkus project
@bank /prompts            ← list saved prompts
@bank /prompts <name>     ← apply a saved prompt
@bank /specialty          ← list or switch specialty
```

### LM Tools (agent mode)

Three tools Copilot can invoke automatically — no `@bank` required:

| Tool | Trigger | Reference |
|---|---|---|
| `bank_get_standards` | Questions about naming rules | `#companyStandards` |
| `bank_review_test` | Test file review requests | `#bankReview` |
| `bank_create_project` | Project creation requests | `#bankCreate` |

### Commands (Command Palette)

| Command | Description |
|---|---|
| `Bank: Refresh Standards from Notion` | Clears cache and reloads rules |
| `Bank: New Project Guide` | Opens the project guide webview |

---

## Prompt Library page format

Create a Notion/Confluence page and add it to `pagesMap.prompts`. Each prompt is a section:

```
## review
Revisa el código del archivo activo contra los estándares de nomenclatura.

```
Analiza el siguiente código línea por línea.
Para cada violación: número de línea, regla violada y corrección sugerida.
Al final muestra un checklist ✅/❌ por cada regla.
```

## aaa-pattern
Verifica que el test sigue el patrón Arrange-Act-Assert.

```
Analiza el test línea por línea e identifica Arrange, Act y Assert.
Si alguna sección falta, indica la línea exacta y cómo corregirla.
```
```

Format: `## <name>` → description paragraph → code block with the prompt template.

---

## License

MIT
