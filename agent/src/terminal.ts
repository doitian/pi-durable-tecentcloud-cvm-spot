import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Writable } from "node:stream";

/**
 * Runs a command on a pseudo-terminal and relays it over pipes: stdin to the terminal, the terminal to stdout, and
 * "<cols> <rows>" lines on fd 3 to window resizes. Node has no PTY of its own and the VM image already has Python.
 * Closing stdin hangs up the command, which for a tmux client means detaching.
 */
export const PTY_BRIDGE = `
import fcntl, os, pty, select, signal, struct, sys, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

def resize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

def write_all(target, data):
    while data:
        data = data[os.write(target, data):]

resize(cols, rows)
control = b""
watched = [fd, 0, 3]
while True:
    try:
        ready = select.select(watched, [], [])[0]
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            break
        write_all(fd, data)
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            watched.remove(3)
        control += data
        while b"\\n" in control:
            line, control = control.split(b"\\n", 1)
            parts = line.split()
            if len(parts) == 2:
                resize(int(parts[0]), int(parts[1]))
try:
    os.kill(pid, signal.SIGHUP)
except ProcessLookupError:
    pass
status = os.waitpid(pid, 0)[1]
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 0)
`;

/** Largest output message; Cloudflare caps WebSocket messages at 1 MiB and base64 adds a third. */
const MAX_CHUNK_BYTES = 256 * 1024;

export interface TerminalSink {
	output(termId: string, data: string): void;
	exit(termId: string, code: number | null, error?: string): void;
}

interface OpenTerminal {
	child: ChildProcess;
	pending: Buffer[];
	timer: NodeJS.Timeout | undefined;
}

/** Browser shells, each a tmux client: closing one detaches, and its tmux session lives until the VM goes. */
export class Terminals {
	private readonly open = new Map<string, OpenTerminal>();

	constructor(private readonly sink: TerminalSink) {}

	start(termId: string, tmuxSession: string, cwd: string, cols: number, rows: number): void {
		mkdirSync(cwd, { recursive: true });
		const child = spawn(
			"python3",
			["-c", PTY_BRIDGE, String(cols), String(rows), "--", "tmux", "-u", "new-session", "-A", "-s", tmuxSession, "-c", cwd],
			{
				cwd,
				env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "C.UTF-8" },
				stdio: ["pipe", "pipe", "pipe", "pipe"],
			},
		);
		const terminal: OpenTerminal = { child, pending: [], timer: undefined };
		this.open.set(termId, terminal);
		const flush = () => {
			terminal.timer = undefined;
			const data = Buffer.concat(terminal.pending.splice(0));
			for (let offset = 0; offset < data.length; offset += MAX_CHUNK_BYTES) {
				this.sink.output(termId, data.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64"));
			}
		};
		// Coalesce bursts so a fast-scrolling command does not become thousands of tiny messages.
		child.stdout!.on("data", (chunk: Buffer) => {
			terminal.pending.push(chunk);
			terminal.timer ??= setTimeout(flush, 8);
		});
		let stderr = "";
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		child.on("error", (error) => {
			this.open.delete(termId);
			this.sink.exit(termId, null, error.message);
		});
		child.on("exit", (code) => {
			clearTimeout(terminal.timer);
			flush();
			this.open.delete(termId);
			this.sink.exit(termId, code, code ? stderr.trim() || undefined : undefined);
		});
	}

	input(termId: string, data: string): void {
		this.open.get(termId)?.child.stdin?.write(Buffer.from(data, "base64"));
	}

	resize(termId: string, cols: number, rows: number): void {
		(this.open.get(termId)?.child.stdio[3] as Writable | undefined)?.write(`${cols} ${rows}\n`);
	}

	close(termId: string): void {
		this.open.get(termId)?.child.stdin?.end();
	}

	closeAll(): void {
		for (const termId of this.open.keys()) this.close(termId);
	}
}
