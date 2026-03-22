import { resolveWithCache, clearCache, CacheEntry } from "../notion/cache";
import { KnowledgeBlock } from "../knowledge/KnowledgeProvider";

// globalState mock: simple in-memory key-value store
function mockContext(initial: Record<string, unknown> = {}): any {
  const store: Record<string, unknown> = { ...initial };
  return {
    globalState: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: jest.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
          delete store[key];
        } else {
          store[key] = value;
        }
      }),
      keys: () => Object.keys(store),
    },
  };
}

// KnowledgeProvider mock factory
function mockClient(overrides: {
  metaLastModified?: string;
  pageBlocks?: KnowledgeBlock[];
  pageTitle?: string;
} = {}): any {
  const lastModified = overrides.metaLastModified ?? "2024-01-15T10:00:00.000Z";
  return {
    getPageMetadata: jest.fn().mockResolvedValue({
      id: "PAGE_1",
      title: overrides.pageTitle ?? "Standards Page",
      lastModified,
    }),
    getPage: jest.fn().mockResolvedValue({
      id: "PAGE_1",
      title: overrides.pageTitle ?? "Standards Page",
      blocks: overrides.pageBlocks ?? [],
    }),
  };
}

const SAMPLE_BLOCKS: KnowledgeBlock[] = [
  { type: "paragraph", text: "use camelCase for test functions" },
];

const parse = jest.fn((blocks: KnowledgeBlock[]) => [`parsed:${blocks.length}`]);

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────
// resolveWithCache
// ─────────────────────────────────────────────

describe("resolveWithCache", () => {
  describe("no cache entry", () => {
    it("fetches full page and returns fromCache=false", async () => {
      const ctx = mockContext();
      const client = mockClient();

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.fromCache).toBe(false);
      expect(client.getPageMetadata).toHaveBeenCalledTimes(1);
      expect(client.getPage).toHaveBeenCalledTimes(1);
    });

    it("stores entry in globalState after fetch", async () => {
      const ctx = mockContext();
      const client = mockClient({ metaLastModified: "2024-01-15T10:00:00.000Z" });

      await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(ctx.globalState.update).toHaveBeenCalledWith(
        "companyStandards.cache.PAGE_1",
        expect.objectContaining({
          pageId: "PAGE_1",
          lastModified: "2024-01-15T10:00:00.000Z",
        })
      );
    });

    it("returns parsed data from the fetched blocks", async () => {
      const ctx = mockContext();
      const client = mockClient({ pageBlocks: SAMPLE_BLOCKS });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.data).toEqual([`parsed:${SAMPLE_BLOCKS.length}`]);
    });
  });

  describe("cache hit — page unchanged", () => {
    const DATE = "2024-01-15T10:00:00.000Z";

    function contextWithEntry(data: unknown = ["cached-rule"]) {
      const entry: CacheEntry<unknown> = {
        pageId: "PAGE_1",
        pageTitle: "Standards Page",
        lastModified: DATE,
        data,
      };
      return mockContext({ "companyStandards.cache.PAGE_1": entry });
    }

    it("returns fromCache=true when date matches", async () => {
      const ctx = contextWithEntry();
      const client = mockClient({ metaLastModified: DATE });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.fromCache).toBe(true);
    });

    it("returns cached data without calling getPage", async () => {
      const ctx = contextWithEntry(["rule-A", "rule-B"]);
      const client = mockClient({ metaLastModified: DATE });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.data).toEqual(["rule-A", "rule-B"]);
      expect(client.getPage).not.toHaveBeenCalled();
    });

    it("still calls getPageMetadata exactly once", async () => {
      const ctx = contextWithEntry();
      const client = mockClient({ metaLastModified: DATE });

      await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(client.getPageMetadata).toHaveBeenCalledTimes(1);
    });

    it("does not overwrite globalState on cache hit", async () => {
      const ctx = contextWithEntry();
      const client = mockClient({ metaLastModified: DATE });

      await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(ctx.globalState.update).not.toHaveBeenCalled();
    });
  });

  describe("cache stale — page updated", () => {
    const OLD_DATE = "2024-01-10T08:00:00.000Z";
    const NEW_DATE = "2024-01-20T15:30:00.000Z";

    function contextWithStaleEntry() {
      const entry: CacheEntry<string[]> = {
        pageId: "PAGE_1",
        pageTitle: "Standards Page",
        lastModified: OLD_DATE,
        data: ["old-rule"],
      };
      return mockContext({ "companyStandards.cache.PAGE_1": entry });
    }

    it("returns fromCache=false when dates differ", async () => {
      const ctx = contextWithStaleEntry();
      const client = mockClient({ metaLastModified: NEW_DATE });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.fromCache).toBe(false);
    });

    it("fetches full page when cache is stale", async () => {
      const ctx = contextWithStaleEntry();
      const client = mockClient({ metaLastModified: NEW_DATE });

      await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(client.getPage).toHaveBeenCalledTimes(1);
    });

    it("overwrites globalState with new date", async () => {
      const ctx = contextWithStaleEntry();
      const client = mockClient({ metaLastModified: NEW_DATE, pageBlocks: SAMPLE_BLOCKS });

      await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(ctx.globalState.update).toHaveBeenCalledWith(
        "companyStandards.cache.PAGE_1",
        expect.objectContaining({ lastModified: NEW_DATE })
      );
    });

    it("does NOT return stale data — returns freshly parsed data", async () => {
      const ctx = contextWithStaleEntry();
      const client = mockClient({ metaLastModified: NEW_DATE, pageBlocks: SAMPLE_BLOCKS });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.data).not.toEqual(["old-rule"]);
      expect(result.data).toEqual([`parsed:${SAMPLE_BLOCKS.length}`]);
    });
  });

  describe("pageTitle", () => {
    it("returns title from metadata on cache hit", async () => {
      const entry: CacheEntry<string[]> = {
        pageId: "PAGE_1",
        pageTitle: "Old Title",
        lastModified: "2024-01-15T10:00:00.000Z",
        data: [],
      };
      const ctx = mockContext({ "companyStandards.cache.PAGE_1": entry });
      const client = mockClient({
        metaLastModified: "2024-01-15T10:00:00.000Z",
        pageTitle: "Current Title",
      });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.pageTitle).toBe("Current Title");
    });

    it("returns title from full page on cache miss", async () => {
      const ctx = mockContext();
      const client = mockClient({ pageTitle: "Fresh Page Title" });

      const result = await resolveWithCache(ctx, "PAGE_1", client, parse, "test");

      expect(result.pageTitle).toBe("Fresh Page Title");
    });
  });
});

// ─────────────────────────────────────────────
// clearCache
// ─────────────────────────────────────────────

describe("clearCache", () => {
  it("removes all companyStandards.cache.* keys", async () => {
    const ctx = mockContext({
      "companyStandards.cache.PAGE_1": { data: [] },
      "companyStandards.cache.PAGE_2": { data: [] },
    });

    await clearCache(ctx);

    expect(ctx.globalState.update).toHaveBeenCalledWith("companyStandards.cache.PAGE_1", undefined);
    expect(ctx.globalState.update).toHaveBeenCalledWith("companyStandards.cache.PAGE_2", undefined);
    expect(ctx.globalState.update).toHaveBeenCalledTimes(2);
  });

  it("does not touch unrelated globalState keys", async () => {
    const ctx = mockContext({
      "companyStandards.cache.PAGE_1": { data: [] },
      "someOtherExtension.setting": true,
    });

    await clearCache(ctx);

    expect(ctx.globalState.update).not.toHaveBeenCalledWith(
      "someOtherExtension.setting",
      expect.anything()
    );
  });

  it("does nothing when there are no cache entries", async () => {
    const ctx = mockContext({ "someOtherExtension.setting": true });

    await clearCache(ctx);

    expect(ctx.globalState.update).not.toHaveBeenCalled();
  });
});
