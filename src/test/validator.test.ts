import { findViolations } from "../standards/validator";
import { NamingRule } from "../knowledge/parser";
import { mockDocument } from "./helpers/mockDocument";

const camelCaseTestRule: NamingRule = {
  context: "test functions",
  convention: "camelCase",
  description: "Test functions must use camelCase",
};

const camelCaseFunctionRule: NamingRule = {
  context: "functions",
  convention: "camelCase",
  description: "Functions must use camelCase",
};

const pascalCaseClassRule: NamingRule = {
  context: "classes",
  convention: "PascalCase",
  description: "Classes must use PascalCase",
};

describe("findViolations", () => {
  it("returns no violations when rules are empty", () => {
    const doc = mockDocument(`function my_func() {}`);
    expect(findViolations(doc, [])).toHaveLength(0);
  });

  it("detects snake_case function violating camelCase rule", () => {
    const doc = mockDocument(`function get_user_name() {}`);
    const violations = findViolations(doc, [camelCaseFunctionRule]);
    expect(violations).toHaveLength(1);
    expect(violations[0].name).toBe("get_user_name");
    expect(violations[0].suggestion).toBe("getUserName");
    expect(violations[0].rule.convention).toBe("camelCase");
  });

  it("does not flag a valid camelCase function", () => {
    const doc = mockDocument(`function getUserName() {}`);
    const violations = findViolations(doc, [camelCaseFunctionRule]);
    expect(violations).toHaveLength(0);
  });

  it("detects snake_case Jest test name", () => {
    const doc = mockDocument(`test('user_should_login', () => {});`);
    const violations = findViolations(doc, [camelCaseTestRule]);
    expect(violations).toHaveLength(1);
    expect(violations[0].name).toBe("user_should_login");
    expect(violations[0].suggestion).toBe("userShouldLogin");
  });

  it("detects snake_case in it() block", () => {
    const doc = mockDocument(`it('payment_should_fail', () => {});`);
    const violations = findViolations(doc, [camelCaseTestRule]);
    expect(violations).toHaveLength(1);
    expect(violations[0].name).toBe("payment_should_fail");
  });

  it("does not flag a valid camelCase test name", () => {
    const doc = mockDocument(`it('userShouldLogin', () => {});`);
    const violations = findViolations(doc, [camelCaseTestRule]);
    expect(violations).toHaveLength(0);
  });

  it("detects snake_case class violating PascalCase rule", () => {
    const doc = mockDocument(`class user_service {}`);
    const violations = findViolations(doc, [pascalCaseClassRule]);
    expect(violations).toHaveLength(1);
    expect(violations[0].name).toBe("user_service");
    expect(violations[0].suggestion).toBe("UserService");
  });

  it("detects multiple violations across rules", () => {
    const doc = mockDocument(`
      function get_user() {}
      class user_service {}
    `);
    const violations = findViolations(doc, [camelCaseFunctionRule, pascalCaseClassRule]);
    const names = violations.map((v) => v.name);
    expect(names).toContain("get_user");
    expect(names).toContain("user_service");
  });

  it("detects Java-style JUnit test method", () => {
    const doc = mockDocument(
      `@Test\nvoid user_should_login() {}`,
      "java"
    );
    const violations = findViolations(doc, [camelCaseTestRule]);
    expect(violations.some((v) => v.name === "user_should_login")).toBe(true);
  });

  it("detects arrow function violating camelCase", () => {
    const doc = mockDocument(`const get_data = () => {};`);
    const violations = findViolations(doc, [camelCaseFunctionRule]);
    expect(violations.some((v) => v.name === "get_data")).toBe(true);
  });
});
