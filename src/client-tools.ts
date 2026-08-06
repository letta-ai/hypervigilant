export const LOCAL_READ_TOOLS = ["Read", "LS", "Glob", "Grep"] as const;
export const LOCAL_MUTATION_TOOLS = ["Edit", "Write"] as const;
export const RESERVED_LOCAL_TOOLS = [...LOCAL_READ_TOOLS, ...LOCAL_MUTATION_TOOLS] as const;
export const PROHIBITED_LOCAL_TOOLS = [
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "KillBash",
  "shell_command",
  "ShellCommand",
  "exec_command",
  "write_stdin",
  "shell",
  "Shell",
  "run_shell_command",
  "RunShellCommand",
  "Task",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "EnterWorktree",
  "MultiEdit",
  "apply_patch",
  "ApplyPatch",
  "replace",
  "Replace",
  "write_file_gemini",
  "write_file",
  "WriteFileGemini",
  "memory",
  "memory_apply_patch",
] as const;

export interface ClientToolsConfig {
  autoAllow: string[];
  ask: string[];
}

export type ConfiguredClientToolPolicy = "auto_allow" | "ask";

export function configuredClientToolNames(config: ClientToolsConfig): string[] {
  return [...config.autoAllow, ...config.ask];
}

export function configuredClientToolPolicy(
  config: ClientToolsConfig,
  toolName: string,
): ConfiguredClientToolPolicy | null {
  if (config.autoAllow.includes(toolName)) return "auto_allow";
  if (config.ask.includes(toolName)) return "ask";
  return null;
}
