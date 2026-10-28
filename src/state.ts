import { homedir } from "node:os";
import * as path from "node:path";

export function stateDirectory(directory?: string): string {
  const value = directory ?? process.env.LAZYHB_STATE_DIR ??
    (process.platform === "darwin"
      ? path.join(homedir(), "Library/Application Support/lazyhb")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? path.join(homedir(), "AppData/Roaming"), "lazyhb")
        : path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local/state"), "lazyhb"));
  return path.resolve(value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);
}
