import { matchesConvention, suggestFix } from "../standards/rules";

describe("matchesConvention", () => {
  describe("camelCase", () => {
    it("accepts valid camelCase identifiers", () => {
      expect(matchesConvention("myFunction", "camelCase")).toBe(true);
      expect(matchesConvention("getUserName", "camelCase")).toBe(true);
      expect(matchesConvention("value", "camelCase")).toBe(true);
    });

    it("rejects snake_case", () => {
      expect(matchesConvention("my_function", "camelCase")).toBe(false);
      expect(matchesConvention("get_user_name", "camelCase")).toBe(false);
    });

    it("rejects PascalCase", () => {
      expect(matchesConvention("MyFunction", "camelCase")).toBe(false);
    });
  });

  describe("PascalCase", () => {
    it("accepts valid PascalCase identifiers", () => {
      expect(matchesConvention("MyClass", "PascalCase")).toBe(true);
      expect(matchesConvention("UserService", "PascalCase")).toBe(true);
    });

    it("rejects camelCase", () => {
      expect(matchesConvention("myClass", "PascalCase")).toBe(false);
    });

    it("rejects snake_case", () => {
      expect(matchesConvention("my_class", "PascalCase")).toBe(false);
    });
  });

  describe("snake_case", () => {
    it("accepts valid snake_case identifiers", () => {
      expect(matchesConvention("my_variable", "snake_case")).toBe(true);
      expect(matchesConvention("user_id", "snake_case")).toBe(true);
    });

    it("rejects camelCase", () => {
      expect(matchesConvention("myVariable", "snake_case")).toBe(false);
    });
  });

  describe("UPPER_SNAKE", () => {
    it("accepts valid UPPER_SNAKE identifiers", () => {
      expect(matchesConvention("MAX_RETRIES", "UPPER_SNAKE")).toBe(true);
      expect(matchesConvention("API_BASE_URL", "UPPER_SNAKE")).toBe(true);
    });

    it("rejects lowercase", () => {
      expect(matchesConvention("max_retries", "UPPER_SNAKE")).toBe(false);
      expect(matchesConvention("maxRetries", "UPPER_SNAKE")).toBe(false);
    });
  });

  describe("kebab-case", () => {
    it("accepts valid kebab-case identifiers", () => {
      expect(matchesConvention("my-component", "kebab-case")).toBe(true);
      expect(matchesConvention("user-profile", "kebab-case")).toBe(true);
    });

    it("rejects underscores", () => {
      expect(matchesConvention("my_component", "kebab-case")).toBe(false);
    });
  });
});

describe("suggestFix", () => {
  it("converts snake_case to camelCase", () => {
    expect(suggestFix("my_test_function", "camelCase")).toBe("myTestFunction");
    expect(suggestFix("get_user_name", "camelCase")).toBe("getUserName");
    expect(suggestFix("user_should_login", "camelCase")).toBe("userShouldLogin");
  });

  it("converts camelCase to snake_case", () => {
    expect(suggestFix("myTestFunction", "snake_case")).toBe("my_test_function");
    expect(suggestFix("getUserName", "snake_case")).toBe("get_user_name");
  });

  it("converts snake_case to PascalCase", () => {
    expect(suggestFix("user_service", "PascalCase")).toBe("UserService");
    expect(suggestFix("my_class", "PascalCase")).toBe("MyClass");
  });

  it("converts camelCase to UPPER_SNAKE", () => {
    expect(suggestFix("maxRetries", "UPPER_SNAKE")).toBe("MAX_RETRIES");
  });

  it("converts snake_case to kebab-case", () => {
    expect(suggestFix("my_component", "kebab-case")).toBe("my-component");
  });
});
