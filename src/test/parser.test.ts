import { parseNamingRules, parseProjectSteps, parsePromptLibrary, blocksToMarkdown } from "../notion/parser";
import { KnowledgeBlock } from "../knowledge/KnowledgeProvider";

// ─── parseNamingRules ────────────────────────────────────────────────────────

describe("parseNamingRules", () => {
  it("parses table rows into naming rules", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "table", hasColumnHeader: true },
      { type: "table_row", cells: ["Context", "Convention", "Description"] }, // header row
      { type: "table_row", cells: ["functions", "camelCase", "Use camelCase for functions"] },
      { type: "table_row", cells: ["classes", "PascalCase", "Use PascalCase for classes"] },
      { type: "table_row", cells: ["constants", "UPPER_SNAKE", "Use UPPER_SNAKE for constants"] },
    ];
    const rules = parseNamingRules(blocks);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ context: "functions", convention: "camelCase", description: "Use camelCase for functions" });
    expect(rules[1]).toEqual({ context: "classes", convention: "PascalCase", description: "Use PascalCase for classes" });
    expect(rules[2]).toEqual({ context: "constants", convention: "UPPER_SNAKE", description: "Use UPPER_SNAKE for constants" });
  });

  it("skips table rows with fewer than 3 cells", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "table", hasColumnHeader: false },
      { type: "table_row", cells: ["functions", "camelCase"] }, // only 2 cells
    ];
    expect(parseNamingRules(blocks)).toHaveLength(0);
  });

  it("skips rows with unrecognized convention", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "table", hasColumnHeader: false },
      { type: "table_row", cells: ["functions", "unknownStyle", "desc"] },
    ];
    expect(parseNamingRules(blocks)).toHaveLength(0);
  });

  it("parses inline paragraph rules", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "paragraph", text: "use camelCase for test functions. use PascalCase for service classes." },
    ];
    const rules = parseNamingRules(blocks);
    expect(rules).toHaveLength(2);
    expect(rules[0].convention).toBe("camelCase");
    expect(rules[0].context).toBe("test functions");
    expect(rules[1].convention).toBe("PascalCase");
  });

  it("returns empty array for empty blocks", () => {
    expect(parseNamingRules([])).toEqual([]);
  });

  it("detects all supported conventions in table rows", () => {
    const conventions = ["camelCase", "PascalCase", "UPPER_SNAKE", "kebab-case", "snake_case"];
    for (const conv of conventions) {
      const blocks: KnowledgeBlock[] = [
        { type: "table", hasColumnHeader: false },
        { type: "table_row", cells: ["ctx", conv, "desc"] },
      ];
      const rules = parseNamingRules(blocks);
      expect(rules).toHaveLength(1);
      expect(rules[0].convention).toBe(conv);
    }
  });
});

// ─── parseProjectSteps ───────────────────────────────────────────────────────

describe("parseProjectSteps", () => {
  it("extracts numbered blocks as project steps", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "numbered", text: "Setup Maven: configure pom.xml" },
      { type: "numbered", text: "Add Quarkus extensions" },
      { type: "paragraph", text: "Some note" }, // ignored
    ];
    const steps = parseProjectSteps(blocks);
    expect(steps).toHaveLength(2);
    expect(steps[0].order).toBe(1);
    expect(steps[0].title).toBe("Setup Maven");
    expect(steps[1].order).toBe(2);
    expect(steps[1].title).toBe("Add Quarkus extensions");
  });

  it("returns empty array when no numbered blocks", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "paragraph", text: "intro" },
      { type: "bullet", text: "item" },
    ];
    expect(parseProjectSteps(blocks)).toEqual([]);
  });
});

// ─── parsePromptLibrary ──────────────────────────────────────────────────────

describe("parsePromptLibrary", () => {
  it("parses heading2 + paragraph + code sections into prompts", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "heading2", text: "review" },
      { type: "paragraph", text: "Revisa el código activo" },
      { type: "code", text: "Analiza el código línea por línea." },
      { type: "heading2", text: "aaa-pattern" },
      { type: "paragraph", text: "Verifica el patrón AAA" },
      { type: "code", text: "Identifica Arrange, Act, Assert." },
    ];
    const prompts = parsePromptLibrary(blocks);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].name).toBe("review");
    expect(prompts[0].description).toBe("Revisa el código activo");
    expect(prompts[0].template).toBe("Analiza el código línea por línea.");
    expect(prompts[1].name).toBe("aaa-pattern");
  });

  it("normalizes prompt names to lowercase-with-hyphens", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "heading2", text: "Code Review" },
      { type: "code", text: "template" },
    ];
    const prompts = parsePromptLibrary(blocks);
    expect(prompts[0].name).toBe("code-review");
  });

  it("skips sections without a template (no code block)", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "heading2", text: "no-template" },
      { type: "paragraph", text: "only description, no code block" },
    ];
    expect(parsePromptLibrary(blocks)).toHaveLength(0);
  });

  it("uses first 80 chars of template as description when no paragraph", () => {
    const longTemplate = "A".repeat(100);
    const blocks: KnowledgeBlock[] = [
      { type: "heading2", text: "auto-desc" },
      { type: "code", text: longTemplate },
    ];
    const prompts = parsePromptLibrary(blocks);
    expect(prompts[0].description).toBe("A".repeat(80));
  });

  it("returns empty array for empty blocks", () => {
    expect(parsePromptLibrary([])).toEqual([]);
  });
});

// ─── blocksToMarkdown ────────────────────────────────────────────────────────

describe("blocksToMarkdown", () => {
  it("converts headings correctly", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "heading1", text: "Title" },
      { type: "heading2", text: "Section" },
      { type: "heading3", text: "Subsection" },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("# Title");
    expect(md).toContain("## Section");
    expect(md).toContain("### Subsection");
  });

  it("converts lists correctly", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "bullet", text: "item one" },
      { type: "numbered", text: "step one" },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("- item one");
    expect(md).toContain("1. step one");
  });

  it("wraps code blocks in fenced markdown", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "code", text: "const x = 1;", language: "typescript" },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("```typescript");
    expect(md).toContain("const x = 1;");
    expect(md).toContain("```");
  });

  it("renders table rows as pipe-separated text", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "table_row", cells: ["functions", "camelCase", "use for functions"] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("functions | camelCase | use for functions");
  });

  it("adds dividers for divider blocks", () => {
    const blocks: KnowledgeBlock[] = [{ type: "divider" }];
    expect(blocksToMarkdown(blocks)).toContain("---");
  });

  it("skips blocks with no text content", () => {
    const blocks: KnowledgeBlock[] = [
      { type: "paragraph", text: "" },
      { type: "paragraph" },
    ];
    expect(blocksToMarkdown(blocks)).toBe("");
  });
});
