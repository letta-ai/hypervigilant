import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROHIBITED_LOCAL_TOOLS, RESERVED_LOCAL_TOOLS } from "../src/client-tools.ts";
import {
  configSchema,
  createGlobMatcher,
  type HypervigilantConfig,
  loadConfig,
  resolveConfigPath,
  serializeConfigToml,
  validateConfig,
} from "../src/config.ts";

describe("config", () => {
  describe("configSchema", () => {
    it("should apply defaults for missing optional fields", () => {
      const result = configSchema.safeParse({
        version: 1,
        project: "test",
        agentId: "agent-xxx",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include).toEqual(["**/*.md", "**/*.txt"]);
        expect(result.data.model).toBeUndefined();
        expect(result.data.exclude).toEqual([
          "**/node_modules/**",
          "**/.git/**",
          ".hypervigilant/**",
          "**/.hypervigilant/**",
        ]);
        expect(result.data.maxFileSizeBytes).toBe(1_048_576);
        expect(result.data.maxScanFiles).toBe(100);
        expect(result.data.maxScanTextBytes).toBe(65_536);
        expect(result.data.connection).toEqual({ backend: "cloud" });
        expect(result.data.batching.strategy).toBe("debounce");
        expect(result.data.batching.delayMs).toBe(500);
        expect(result.data.batching.maxWaitMs).toBe(5000);
        expect(result.data.mode).toBe("edit");
        expect(result.data.routing).toBe("project");
        expect(result.data.stateDir).toBe(".hypervigilant");
        expect(result.data.instructions).toBe("");
        expect(result.data.worktree).toEqual({
          enabled: false,
          autoCommit: true,
          branchPrefix: "hypervigilant",
        });
        expect(result.data.promptRules).toEqual([]);
        expect(result.data.tools).toEqual({ autoAllow: [], ask: [] });
      }
    });

    it("should accept a fully specified config", () => {
      const result = configSchema.safeParse({
        version: 1,
        project: "my-project",
        agentId: "agent-abc123",
        model: "auto",
        connection: {
          backend: "local",
          requestTimeoutMs: 90_000,
          startupTimeoutMs: 45_000,
        },
        include: ["**/*.ts"],
        exclude: ["**/dist/**"],
        maxFileSizeBytes: 512_000,
        maxScanFiles: 25,
        maxScanTextBytes: 32_768,
        batching: {
          strategy: "fixed-window",
          delayMs: 1000,
          maxWaitMs: 10000,
          windowMs: 3000,
        },
        mode: "edit",
        routing: "per-file",
        stateDir: ".hv-state",
        instructions: "Compare changes with SPEC.md.",
        worktree: {
          enabled: true,
          autoCommit: false,
          branchPrefix: "hv/reviews",
        },
        tools: {
          autoAllow: ["ViewImage"],
          ask: ["TodoWrite"],
        },
        promptRules: [
          {
            name: "spec-change",
            match: ["specs/**"],
            events: ["add", "change"],
            prompt: "Treat the specification as the contract.",
            conversation: "spec-review",
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.batching.strategy).toBe("fixed-window");
        expect(result.data.model).toBe("auto");
        expect(result.data.connection).toEqual({
          backend: "local",
          requestTimeoutMs: 90_000,
          startupTimeoutMs: 45_000,
        });
        expect(result.data.mode).toBe("edit");
        expect(result.data.routing).toBe("per-file");
        expect(result.data.worktree.branchPrefix).toBe("hv/reviews");
        expect(result.data.promptRules[0]?.name).toBe("spec-change");
        expect(result.data.promptRules[0]?.conversation).toBe("spec-review");
        expect(result.data.tools).toEqual({
          autoAllow: ["ViewImage"],
          ask: ["TodoWrite"],
        });
      }
    });

    it("should reject version !== 1", () => {
      const result = configSchema.safeParse({
        version: 2,
        project: "test",
        agentId: "agent-xxx",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty project name", () => {
      const result = configSchema.safeParse({
        version: 1,
        project: "",
        agentId: "agent-xxx",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty and placeholder agent IDs", () => {
      expect(configSchema.safeParse({ version: 1, project: "test", agentId: "" }).success).toBe(
        false,
      );
      const placeholder = configSchema.safeParse({
        version: 1,
        project: "test",
        agentId: "agent-REPLACE-ME",
      });
      expect(placeholder.success).toBe(false);
      if (!placeholder.success) {
        expect(placeholder.error.issues[0]?.message).toContain("real Letta agent ID");
      }
    });

    it("should reject invalid batching strategy", () => {
      const result = configSchema.safeParse({
        version: 1,
        project: "test",
        agentId: "agent-xxx",
        batching: { strategy: "invalid" },
      });
      expect(result.success).toBe(false);
    });

    it("should reject unknown fields instead of silently ignoring typos", () => {
      const result = configSchema.safeParse({
        version: 1,
        project: "test",
        agentId: "agent-xxx",
        batchingg: { strategy: "immediate" },
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid mode", () => {
      const result = configSchema.safeParse({
        version: 1,
        project: "test",
        agentId: "agent-xxx",
        mode: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("validates local and remote connection boundaries", () => {
      const base = { version: 1, project: "test", agentId: "agent-xxx" };
      expect(configSchema.safeParse({ ...base, connection: { backend: "local" } }).success).toBe(
        true,
      );
      expect(
        configSchema.safeParse({
          ...base,
          mode: "review",
          connection: {
            backend: "remote",
            url: "ws://127.0.0.1:4500",
          },
        }).success,
      ).toBe(true);
      expect(
        configSchema.safeParse({
          ...base,
          mode: "review",
          connection: {
            backend: "remote",
            url: "wss://agents.example.com",
          },
        }).success,
      ).toBe(false);
      expect(
        configSchema.safeParse({
          ...base,
          mode: "review",
          connection: {
            backend: "remote",
            url: "ws://agents.example.com",
            authTokenEnv: "APP_SERVER_TOKEN",
          },
        }).success,
      ).toBe(false);
      expect(
        configSchema.safeParse({
          ...base,
          mode: "review",
          connection: {
            backend: "remote",
            url: "wss://agents.example.com?token=secret",
            authTokenEnv: "APP_SERVER_TOKEN",
          },
        }).success,
      ).toBe(false);
      expect(
        configSchema.safeParse({
          ...base,
          connection: { backend: "remote", url: "not-a-url" },
        }).success,
      ).toBe(false);
      expect(
        configSchema.safeParse({
          ...base,
          connection: {
            backend: "remote",
            url: "ws://127.0.0.1:4500",
            authTokenEnv: "bad-name",
          },
        }).success,
      ).toBe(false);
      expect(
        configSchema.safeParse({
          ...base,
          mode: "edit",
          connection: {
            backend: "remote",
            url: "ws://127.0.0.1:4500",
            sharedFilesystem: false,
          },
        }).success,
      ).toBe(false);
      expect(
        configSchema.safeParse({
          ...base,
          mode: "edit",
          connection: {
            backend: "remote",
            url: "ws://127.0.0.1:4500",
            sharedFilesystem: true,
          },
        }).success,
      ).toBe(true);
    });

    it("should reject unsafe worktree branch prefixes", () => {
      for (const branchPrefix of ["../escape", "bad prefix", "bad//segment", "topic@{1}"]) {
        expect(
          configSchema.safeParse({
            version: 1,
            project: "test",
            agentId: "agent-xxx",
            worktree: { branchPrefix },
          }).success,
        ).toBe(false);
      }
    });

    it("should reject invalid and duplicate prompt rules", () => {
      const base = { version: 1, project: "test", agentId: "agent-xxx" };
      for (const promptRules of [
        [{ name: "blank", match: [], prompt: "Prompt" }],
        [{ name: "blank", match: ["**/*"], prompt: "   " }],
        [{ name: "event", match: ["**/*"], events: ["rename"], prompt: "Prompt" }],
        [{ name: "unknown", match: ["**/*"], prompt: "Prompt", typo: true }],
        [
          { name: "same", match: ["a/**"], prompt: "One" },
          { name: "same", match: ["b/**"], prompt: "Two" },
        ],
      ]) {
        expect(configSchema.safeParse({ ...base, promptRules }).success).toBe(false);
      }
    });

    it("validates logical conversation names and allows shared named routes", () => {
      const base = { version: 1, project: "test", agentId: "agent-xxx" };
      for (const conversation of ["", " security", "security/review", ".hidden", "a".repeat(65)]) {
        expect(
          configSchema.safeParse({
            ...base,
            promptRules: [{ name: "rule", match: ["**/*"], prompt: "Prompt", conversation }],
          }).success,
        ).toBe(false);
      }
      expect(
        configSchema.safeParse({
          ...base,
          promptRules: [
            { name: "one", match: ["a/**"], prompt: "One", conversation: "quality.v1" },
            { name: "two", match: ["b/**"], prompt: "Two", conversation: "quality.v1" },
          ],
        }).success,
      ).toBe(true);
    });

    it("validates configured client tool names and policies", () => {
      const base = { version: 1, project: "test", agentId: "agent-xxx" };
      expect(
        configSchema.safeParse({
          ...base,
          tools: { autoAllow: ["ViewImage", "TaskList"], ask: ["TodoWrite"] },
        }).success,
      ).toBe(true);

      for (const name of [
        "",
        " bad",
        "bad/tool",
        "a".repeat(129),
        ...RESERVED_LOCAL_TOOLS,
        ...PROHIBITED_LOCAL_TOOLS,
      ]) {
        expect(
          configSchema.safeParse({
            ...base,
            tools: { autoAllow: [name] },
          }).success,
        ).toBe(false);
      }

      for (const tools of [
        { autoAllow: ["ViewImage", "ViewImage"] },
        { ask: ["TodoWrite", "TodoWrite"] },
        { autoAllow: ["ViewImage"], ask: ["ViewImage"] },
        { autoAllow: [], typo: [] },
      ]) {
        expect(configSchema.safeParse({ ...base, tools }).success).toBe(false);
      }
    });
  });

  describe("validateConfig", () => {
    it("should return ok for valid config", () => {
      const result = validateConfig({
        version: 1,
        project: "test",
        agentId: "agent-xxx",
      });
      expect(result.ok).toBe(true);
    });

    it("should return errors with field paths for invalid config", () => {
      const result = validateConfig({
        version: 1,
        project: "",
        agentId: "",
        mode: "invalid",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        // Should mention field paths
        expect(result.errors.some((e) => e.includes("project"))).toBe(true);
        expect(result.errors.some((e) => e.includes("agentId"))).toBe(true);
        expect(result.errors.some((e) => e.includes("mode"))).toBe(true);
      }
    });
  });

  describe("TOML and legacy config files", () => {
    const root = join(import.meta.dirname, "tmp-config");

    beforeEach(async () => {
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("loads snake-case TOML into the internal config model", async () => {
      const path = join(root, "hypervigilant.toml");
      await writeFile(
        path,
        `version = 1
project = "demo"
agent_id = "agent-demo"
model = "auto"
include = ["SPEC.md", "src/**/*.ts"]
exclude = [".hypervigilant/**"]
max_file_size_bytes = 2048
max_scan_files = 12
max_scan_text_bytes = 4096
mode = "review"
routing = "per-file"
state_dir = ".state"
instructions = "Compare source with SPEC.md."

[connection]
backend = "local"
request_timeout_ms = 90000
startup_timeout_ms = 45000

[batching]
strategy = "fixed-window"
delay_ms = 10
max_wait_ms = 20
window_ms = 30

[tools]
auto_allow = ["ViewImage"]
ask = ["TodoWrite"]

[worktree]
enabled = true
auto_commit = false
branch_prefix = "hv/reviews"

[[prompt_rules]]
name = "spec-change"
match = ["SPEC.md"]
events = ["change"]
prompt = "Treat SPEC.md as the contract."
conversation = "spec-review"
`,
      );

      const config = await loadConfig(path);
      expect(config.agentId).toBe("agent-demo");
      expect(config.model).toBe("auto");
      expect(config.maxFileSizeBytes).toBe(2048);
      expect(config.maxScanFiles).toBe(12);
      expect(config.maxScanTextBytes).toBe(4096);
      expect(config.stateDir).toBe(".state");
      expect(config.connection).toEqual({
        backend: "local",
        requestTimeoutMs: 90_000,
        startupTimeoutMs: 45_000,
      });
      expect(config.batching).toEqual({
        strategy: "fixed-window",
        delayMs: 10,
        maxWaitMs: 20,
        windowMs: 30,
      });
      expect(config.instructions).toBe("Compare source with SPEC.md.");
      expect(config.tools).toEqual({
        autoAllow: ["ViewImage"],
        ask: ["TodoWrite"],
      });
      expect(config.worktree).toEqual({
        enabled: true,
        autoCommit: false,
        branchPrefix: "hv/reviews",
      });
      expect(config.promptRules).toEqual([
        {
          name: "spec-change",
          match: ["SPEC.md"],
          events: ["change"],
          prompt: "Treat SPEC.md as the contract.",
          conversation: "spec-review",
        },
      ]);
    });

    it("serializes a config that loads without changing values", async () => {
      const config = configSchema.parse({
        version: 1,
        project: "quoted project",
        agentId: "agent-roundtrip",
        model: "auto",
        instructions: "Check SPEC.md.\nReport drift.",
        tools: { autoAllow: ["ViewImage"], ask: ["TodoWrite"] },
        promptRules: [
          {
            name: "source-review",
            match: ["src/**/*.ts"],
            prompt: "Read SPEC.md.\nRepair contract drift.",
            conversation: "source-review",
          },
        ],
      });
      const path = join(root, "hypervigilant.toml");
      const serialized = serializeConfigToml(config);
      await writeFile(path, serialized);
      expect(await loadConfig(path)).toEqual(config);
      expect(serialized).toContain('agent_id = "agent-roundtrip"');
      expect(serialized).toContain('model = "auto"');
      expect(serialized).toContain("[connection]");
      expect(serialized).toContain('backend = "cloud"');
      expect(serialized).toContain("[batching]");
      expect(serialized).toContain("[tools]");
      expect(serialized).toContain('auto_allow = ["ViewImage"]');
      expect(serialized).toContain("[worktree]");
      expect(serialized).toContain("[[prompt_rules]]");
    });

    it("reports invalid TOML and unknown keys", async () => {
      const invalidPath = join(root, "invalid.toml");
      await writeFile(invalidPath, 'project = "unterminated\n');
      expect(loadConfig(invalidPath)).rejects.toThrow("not valid TOML");

      const unknownPath = join(root, "unknown.toml");
      await writeFile(
        unknownPath,
        'version = 1\nproject = "demo"\nagent_id = "agent-demo"\nagentId = "typo"\n',
      );
      expect(loadConfig(unknownPath)).rejects.toThrow('Unknown TOML key "agentId"');

      await writeFile(
        unknownPath,
        'version = 1\nproject = "demo"\nagent_id = "agent-demo"\n\n[worktree]\nauto_merge = true\n',
      );
      expect(loadConfig(unknownPath)).rejects.toThrow('Unknown TOML key "worktree.auto_merge"');

      await writeFile(
        unknownPath,
        'version = 1\nproject = "demo"\nagent_id = "agent-demo"\n\n[[prompt_rules]]\nname = "rule"\nmatch = ["**/*"]\nprompt = "Prompt"\npermission = "yolo"\n',
      );
      expect(loadConfig(unknownPath)).rejects.toThrow(
        'Unknown TOML key "prompt_rules.0.permission"',
      );

      await writeFile(
        unknownPath,
        'version = 1\nproject = "demo"\nagent_id = "agent-demo"\n\n[tools]\nalways_allow = ["ViewImage"]\n',
      );
      expect(loadConfig(unknownPath)).rejects.toThrow('Unknown TOML key "tools.always_allow"');

      await writeFile(
        unknownPath,
        'version = 1\nproject = "demo"\nagent_id = "agent-demo"\n\n[connection]\nbackend = "local"\ntoken = "secret"\n',
      );
      expect(loadConfig(unknownPath)).rejects.toThrow('Unknown TOML key "connection.token"');
    });

    it("loads legacy JSON and prefers TOML during default resolution", async () => {
      const legacyPath = join(root, "hypervigilant.json");
      await writeFile(
        legacyPath,
        JSON.stringify({ version: 1, project: "legacy", agentId: "agent-legacy" }),
      );
      const legacyConfig = await loadConfig(legacyPath);
      expect(legacyConfig.project).toBe("legacy");
      expect(legacyConfig.connection).toEqual({ backend: "cloud" });
      expect(legacyConfig.tools).toEqual({ autoAllow: [], ask: [] });
      expect(resolveConfigPath(root)).toEqual({ path: legacyPath, legacy: true });

      const tomlPath = join(root, "hypervigilant.toml");
      await writeFile(tomlPath, 'version = 1\nproject = "toml"\nagent_id = "agent-toml"\n');
      expect(resolveConfigPath(root)).toEqual({ path: tomlPath, legacy: false });
    });
  });

  describe("createGlobMatcher", () => {
    const config: Pick<HypervigilantConfig, "include" | "exclude"> = {
      include: ["**/*.md", "**/*.txt"],
      exclude: ["**/node_modules/**"],
    };
    const matcher = createGlobMatcher(config);

    it("should match included files", () => {
      expect(matcher.matches("docs/README.md")).toBe(true);
      expect(matcher.matches("notes.txt")).toBe(true);
      expect(matcher.matches("src/guide.md")).toBe(true);
    });

    it("should not match excluded files", () => {
      expect(matcher.matches("node_modules/pkg/README.md")).toBe(false);
    });

    it("should not match non-included extensions", () => {
      expect(matcher.matches("src/index.ts")).toBe(false);
    });

    it("should handle dot files", () => {
      const matcherWithDot = createGlobMatcher({
        include: ["**/*.md"],
        exclude: [],
      });
      expect(matcherWithDot.matches(".github/README.md")).toBe(true);
    });

    it("should handle backslash paths by normalizing", () => {
      expect(matcher.matches("docs\\README.md")).toBe(true);
    });
  });
});
