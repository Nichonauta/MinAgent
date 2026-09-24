import { spawn } from "node:child_process";

export function terminateProcessTree(child) {
	if (!child?.pid) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
		});
		killer.once("error", () => child.kill());
		killer.once("close", (code) => {
			if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
		});
		killer.unref();
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}
