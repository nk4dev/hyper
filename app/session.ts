import { EventEmitter } from "events";
import { dirname } from "path";
import { StringDecoder } from "string_decoder";

// `default-shell` is ESM-only in newer versions and can't be required by
// CommonJS at module load time. Use a synchronous environment-based
// fallback so the main process doesn't crash when the module isn't
// available or is ESM-only.
const getDefaultShell = (): string => {
  if (process.platform === "win32") {
    return (process.env.COMSPEC as string) || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
};
import type { IPty, IWindowsPtyForkOptions, spawn as npSpawn } from "node-pty";
/**
 * `os-locale` is ESM-only in newer versions and can throw when `require`d at
 * module load time. Provide a synchronous fallback that attempts to require
 * `os-locale` lazily and falls back to environment variables if not available.
 */
const getOsLocaleSync = (): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("os-locale");
    // If the module provides a sync() function, use it.
    if (mod && typeof mod.sync === "function") {
      try {
        const val = mod.sync();
        if (val) return String(val);
      } catch (e) {
        // ignore and fall through to env fallback
      }
    }
    // If `mod` itself is a function but async-only, we can't call it synchronously.
  } catch (err) {
    // require failed (likely because the package is ESM-only) — fall back below
  }

  // Fallback: try common environment variables and normalize to the expected format (en_US)
  const env =
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    "en_US";
  return String(env).split(".")[0].replace(/-/, "_");
};
/**
 * `shell-env` may be ESM-only in newer versions and cannot be required at
 * module load time. Provide a small sync helper that attempts to require
 * `shell-env` lazily and falls back to the current process.env when not
 * available.
 */
const shellEnvSync = (shell?: string) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("shell-env");
    if (mod && typeof mod.sync === "function") {
      try {
        const env = mod.sync(shell);
        if (env) return env;
      } catch (e) {
        // ignore and fall through to fallback
      }
    }
  } catch (err) {
    // require failed (likely because the package is ESM-only) — fall back below
  }
  return process.env;
};

import * as config from "./config";
import { cliScriptPath } from "./config/paths";
import { productName, version } from "./package.json";
import { getDecoratedEnv } from "./plugins";
import { getFallBackShellConfig } from "./utils/shell-fallback";

const createNodePtyError = () =>
  new Error(
    "`node-pty` failed to load. Typically this means that it was built incorrectly. Please check the `readme.md` to more info.",
  );

let spawn: typeof npSpawn;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  spawn = require("node-pty").spawn;
} catch (err) {
  throw createNodePtyError();
}

const useConpty = config.getConfig().useConpty;

// Max duration to batch session data before sending it to the renderer process.
const BATCH_DURATION_MS = 16;

// Max size of a session data batch. Note that this value can be exceeded by ~4k
// (chunk sizes seem to be 4k at the most)
const BATCH_MAX_SIZE = 200 * 1024;

// Data coming from the pty is sent to the renderer process for further
// vt parsing and rendering. This class batches data to minimize the number of
// IPC calls. It also reduces GC pressure and CPU cost: each chunk is prefixed
// with the window ID which is then stripped on the renderer process and this
// overhead is reduced with batching.
class DataBatcher extends EventEmitter {
  uid: string;
  decoder: StringDecoder;
  data!: string;
  timeout!: NodeJS.Timeout | null;
  constructor(uid: string) {
    super();
    this.uid = uid;
    this.decoder = new StringDecoder("utf8");

    this.reset();
  }

  reset() {
    this.data = this.uid;
    this.timeout = null;
  }

  write(chunk: Buffer | string) {
    if (this.data.length + chunk.length >= BATCH_MAX_SIZE) {
      // We've reached the max batch size. Flush it and start another one
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      this.flush();
    }

    this.data += typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    if (!this.timeout) {
      this.timeout = setTimeout(() => this.flush(), BATCH_DURATION_MS);
    }
  }

  flush() {
    // Reset before emitting to allow for potential reentrancy
    const data = this.data;
    this.reset();

    this.emit("flush", data);
  }
}

interface SessionOptions {
  uid: string;
  rows?: number;
  cols?: number;
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  profile: string;
}
export default class Session extends EventEmitter {
  pty: IPty | null;
  batcher: DataBatcher | null;
  shell: string | null;
  ended: boolean;
  initTimestamp: number;
  profile!: string;
  constructor(options: SessionOptions) {
    super();
    this.pty = null;
    this.batcher = null;
    this.shell = null;
    this.ended = false;
    this.initTimestamp = new Date().getTime();
    this.init(options);
  }

  init({
    uid,
    rows,
    cols,
    cwd,
    shell: _shell,
    shellArgs: _shellArgs,
    profile,
  }: SessionOptions) {
    this.profile = profile;
    const envFromConfig = config.getProfileConfig(profile).env || {};
    const defaultShellArgs = ["--login"];

    const shell = _shell || getDefaultShell();
    const shellArgs = _shellArgs || defaultShellArgs;

    const cleanEnv =
      process.env["APPIMAGE"] && process.env["APPDIR"]
        ? shellEnvSync(shell)
        : process.env;
    const baseEnv: Record<string, string> = {
      ...cleanEnv,
      LANG: `${getOsLocaleSync().replace(/-/, "_")}.UTF-8`,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: productName,
      TERM_PROGRAM_VERSION: version,
      ...envFromConfig,
    };
    // path to AppImage mount point is added to PATH environment variable automatically
    // which conflicts with the cli
    if (baseEnv["APPIMAGE"] && baseEnv["APPDIR"]) {
      baseEnv["PATH"] = [dirname(cliScriptPath)]
        .concat(
          (baseEnv["PATH"] || "")
            .split(":")
            .filter((val) => !val.startsWith(baseEnv["APPDIR"])),
        )
        .join(":");
    }

    // Electron has a default value for process.env.GOOGLE_API_KEY
    // We don't want to leak this to the shell
    // See https://github.com/vercel/hyper/issues/696
    if (
      baseEnv.GOOGLE_API_KEY &&
      process.env.GOOGLE_API_KEY === baseEnv.GOOGLE_API_KEY
    ) {
      delete baseEnv.GOOGLE_API_KEY;
    }

    const options: IWindowsPtyForkOptions = {
      cols,
      rows,
      cwd,
      env: getDecoratedEnv(baseEnv),
    };

    // if config do not set the useConpty, it will be judged by the node-pty
    if (typeof useConpty === "boolean") {
      options.useConpty = useConpty;
    }

    try {
      this.pty = spawn(shell, shellArgs, options);
    } catch (_err) {
      const err = _err as { message: string };
      if (/is not a function/.test(err.message)) {
        throw createNodePtyError();
      } else {
        throw err;
      }
    }

    this.batcher = new DataBatcher(uid);
    this.pty.onData((chunk) => {
      if (this.ended) {
        return;
      }
      this.batcher?.write(chunk);
    });

    this.batcher.on("flush", (data: string) => {
      this.emit("data", data);
    });

    this.pty.onExit((e) => {
      if (!this.ended) {
        // fall back to default shell config if the shell exits within 1 sec with non zero exit code
        // this will inform users in case there are errors in the config instead of instant exit
        const runDuration = new Date().getTime() - this.initTimestamp;
        if (e.exitCode > 0 && runDuration < 1000) {
          const fallBackShellConfig = getFallBackShellConfig(
            shell,
            shellArgs,
            getDefaultShell(),
            defaultShellArgs,
          );
          if (fallBackShellConfig) {
            const msg = `
shell exited in ${runDuration} ms with exit code ${e.exitCode}
please check the shell config: ${JSON.stringify({ shell, shellArgs }, undefined, 2)}
using fallback shell config: ${JSON.stringify(fallBackShellConfig, undefined, 2)}
`;
            console.warn(msg);
            this.batcher?.write(msg.replace(/\n/g, "\r\n"));
            this.init({
              uid,
              rows,
              cols,
              cwd,
              shell: fallBackShellConfig.shell,
              shellArgs: fallBackShellConfig.shellArgs,
              profile,
            });
          } else {
            const msg = `
shell exited in ${runDuration} ms with exit code ${e.exitCode}
No fallback available, please check the shell config.
`;
            console.warn(msg);
            this.batcher?.write(msg.replace(/\n/g, "\r\n"));
          }
        } else {
          this.ended = true;
          this.emit("exit");
        }
      }
    });

    this.shell = shell;
  }

  exit() {
    this.destroy();
  }

  write(data: string) {
    if (this.pty) {
      this.pty.write(data);
    } else {
      console.warn("Warning: Attempted to write to a session with no pty");
    }
  }

  resize({ cols, rows }: { cols: number; rows: number }) {
    if (this.pty) {
      try {
        this.pty.resize(cols, rows);
      } catch (_err) {
        const err = _err as { stack: any };
        console.error(err.stack);
      }
    } else {
      console.warn("Warning: Attempted to resize a session with no pty");
    }
  }

  destroy() {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch (_err) {
        const err = _err as { stack: any };
        console.error("exit error", err.stack);
      }
    } else {
      console.warn("Warning: Attempted to destroy a session with no pty");
    }
    this.emit("exit");
    this.ended = true;
  }
}
