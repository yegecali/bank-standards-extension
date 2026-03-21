import { detectSpecialtyFromPrompt } from "../agent/specialtyResolver";

// resolvePageId and getActiveSpecialty require vscode workspace config —
// tested indirectly; detectSpecialtyFromPrompt is pure and fully testable.

describe("detectSpecialtyFromPrompt", () => {
  const specialties = ["frontend", "backend", "qa"];

  it("detects exact specialty name in prompt", () => {
    expect(detectSpecialtyFromPrompt("revisa este test de frontend", specialties)).toBe("frontend");
    expect(detectSpecialtyFromPrompt("standards for backend", specialties)).toBe("backend");
    expect(detectSpecialtyFromPrompt("qa testing patterns", specialties)).toBe("qa");
  });

  it("is case-insensitive", () => {
    expect(detectSpecialtyFromPrompt("Frontend standards", specialties)).toBe("frontend");
    expect(detectSpecialtyFromPrompt("BACKEND naming", specialties)).toBe("backend");
    expect(detectSpecialtyFromPrompt("QA review", specialties)).toBe("qa");
  });

  it("returns undefined when no specialty mentioned", () => {
    expect(detectSpecialtyFromPrompt("how do I name variables?", specialties)).toBeUndefined();
    expect(detectSpecialtyFromPrompt("create a new project", specialties)).toBeUndefined();
    expect(detectSpecialtyFromPrompt("", specialties)).toBeUndefined();
  });

  it("returns undefined when specialties list is empty", () => {
    expect(detectSpecialtyFromPrompt("frontend backend qa", [])).toBeUndefined();
  });

  it("returns the first matching specialty when multiple are mentioned", () => {
    // "frontend" comes before "backend" in the array
    const result = detectSpecialtyFromPrompt("frontend and backend standards", specialties);
    expect(result).toBe("frontend");
  });

  it("does not match specialty as substring of a different word", () => {
    // "qa" is not a substring of "quarkus" (q-u-a-r-k-u-s) — no match
    const result = detectSpecialtyFromPrompt("create quarkus project", ["qa"]);
    expect(result).toBeUndefined();
  });

  it("handles custom specialty names", () => {
    const custom = ["mobile", "data-engineering", "devops"];
    expect(detectSpecialtyFromPrompt("mobile app standards", custom)).toBe("mobile");
    expect(detectSpecialtyFromPrompt("devops pipeline review", custom)).toBe("devops");
  });
});
