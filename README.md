# Company Coding Standard

VSCode extension that connects to your company's knowledge base (Notion or Confluence) to enforce coding standards, validate naming conventions, scaffold projects, generate tests, create documentation, and manage Jira issues — all via a built-in AI agent.

---

## Requirements

- VS Code `1.90.0` or higher
- GitHub Copilot extension (active subscription) — required for the `@bank` agent
- A Notion integration token **or** Confluence API credentials
- *(Optional)* Jira Cloud credentials for `/jira` and `/new-feature` commands

---

## Installation

1. Open VS Code
2. Go to **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **Company Coding Standard**
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
  "companyStandards.confluenceUrl":   "https://yourcompany.atlassian.net",
  "companyStandards.confluenceEmail": "you@yourcompany.com",
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
https://yourcompany.atlassian.net/wiki/spaces/SPACE/pages/123456789/Page+Title
                                                           ^^^^^^^^^
```
Copy the numeric segment.

> **Tip:** Run `Bank: Setup Confluence Space` from the Command Palette for a guided wizard that lists your spaces and maps pages automatically.

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

---

### Option D — Jira integration

Required for `/jira` and `/new-feature` commands:

```json
{
  "companyStandards.jiraUrl":     "https://yourcompany.atlassian.net",
  "companyStandards.jiraEmail":   "you@yourcompany.com",
  "companyStandards.jiraToken":   "<atlassian-api-token>",
  "companyStandards.jiraProject": "BANK"
}
```

`jiraProject` accepts a single project key or an array:
```json
"companyStandards.jiraProject": ["BANK", "PLAT", "INFRA"]
```

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
| `jiraUrl` | `string` | Jira Cloud base URL |
| `jiraEmail` | `string` | Atlassian account email for Jira |
| `jiraToken` | `string` | Atlassian API token for Jira |
| `jiraProject` | `string \| string[]` | Jira project key(s) to query |

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

---

### @bank agent — all commands

Open GitHub Copilot Chat and type `@bank`:

#### Knowledge commands

| Command | Description |
|---|---|
| `@bank /standards` | Show naming conventions from knowledge base |
| `@bank /review` | Review active file against company standards |
| `@bank /create` | Scaffold a Maven + Java 21 + Quarkus project |
| `@bank /specialty` | List all configured specialties |
| `@bank /specialty <name>` | Switch active specialty (frontend, backend, qa…) |

#### Code generation commands

| Command | Description |
|---|---|
| `@bank /generate-test` | Generate unit tests for the active file following company test standards (AAA pattern) |
| `@bank /docs` | Add JSDoc/JavaDoc comments to the active file following company documentation standards |
| `@bank /commit` | Generate a Conventional Commits message based on staged git changes |

#### Prompt library commands

| Command | Description |
|---|---|
| `@bank /prompts` | List all saved prompts from the knowledge base |
| `@bank /prompts <name>` | Apply a saved prompt to the active file |

#### Jira commands

| Command | Description |
|---|---|
| `@bank /jira` | List and pick from open Jira issues across configured projects |
| `@bank /jira PROJ-123` | Show full detail of a specific issue (subtasks, time metrics) |
| `@bank /jira subtasks PROJ-123` | List all subtasks of an issue |
| `@bank /jira create PROJ-123` | Create a new subtask under a parent issue |
| `@bank /new-feature` | Guided 8-step workflow: pick story → plan → implement with company standards |
| `@bank /new-feature PROJ-123` | Start new-feature flow from a specific issue |

---

### /new-feature workflow

The `/new-feature` command orchestrates a complete implementation flow:

1. Lists open Jira stories → user picks one
2. Displays full issue detail (description, priority, story points)
3. LLM generates an implementation plan (components, endpoints, tests needed)
4. User confirms to proceed
5. Loads company standards for the active specialty
6. LLM streams step-by-step implementation guidance applying company conventions
7. Suggests a Conventional Commits message: `feat(proj): summary — ISSUE-KEY`

---

### LM Tools (agent mode)

Three tools Copilot can invoke automatically — no `@bank` required:

| Tool | Trigger | Reference |
|---|---|---|
| `bank_get_standards` | Questions about naming rules | `#companyStandards` |
| `bank_review_test` | Test file review requests | `#bankReview` |
| `bank_create_project` | Project creation requests | `#bankCreate` |

---

### Commands (Command Palette)

| Command | Description |
|---|---|
| `Bank: Refresh Standards from Notion` | Clears cache and reloads rules |
| `Bank: New Project Guide` | Opens the project guide webview |
| `Bank: Setup Confluence Space` | Guided wizard to select Confluence space and map pages |

---

## Prompt Library page format

Create a Notion/Confluence page and add it to `pagesMap.prompts` or `specialtiesMap.<specialty>.prompts`.

Each prompt is a **Heading 2** followed by a description paragraph and the prompt text:

```
## sonar-vulnerabilidades
Analiza el código buscando vulnerabilidades que detectaría SonarQube.

Actúa como SonarQube y revisa el siguiente código.
Para cada issue indica: línea, regla, severidad y corrección.
Severidades: BLOCKER / CRITICAL / MAJOR / MINOR / INFO
Al final muestra un resumen total.

---

## aaa-pattern
Verifica que los tests siguen el patrón Arrange-Act-Assert.

Analiza cada método de test e identifica Arrange, Act y Assert.
Si alguna sección falta, indica la línea exacta y cómo corregirla.
```

**Rules:**
- Use **Heading 2** (`##`) to name each prompt — the slug is auto-generated (e.g. `"Prompts: sonar-xxx"` → `"sonar-xxx"`)
- First paragraph = description shown in the catalog
- Remaining paragraphs and bullets = prompt template sent to the LLM
- A **Code Block** macro works too, and takes priority over plain paragraphs

**Invoke:**
```
@bank /prompts                         ← list catalog
@bank /prompts sonar-vulnerabilidades  ← apply prompt on active file
@bank /prompts aaa                     ← partial match → aaa-pattern
```

---

## Logs & Debugging

All HTTP calls, prompt parsing, and model resolution are logged to the **Output Channel**:

1. Open **View → Output**
2. Select **Company Coding Standard** in the dropdown

Useful for diagnosing Confluence/Notion connectivity, prompt detection issues, and Jira API errors.

---

## License

MIT
