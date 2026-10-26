import { execFile } from "node:child_process";

// Best-effort macOS window handling for headed runs. Playwright can create a
// new Chrome tab/window that steals focus even when --start-minimized is set.
// Missing Accessibility/AppleScript permission must never fail the test run.
export function minimizeChromeWindow() {
  if (process.platform !== "darwin") return;
  const script = `
tell application "Google Chrome"
  if (count of windows) > 0 then
    set miniaturized of front window to true
  end if
end tell`;
  execFile("osascript", ["-e", script], { timeout: 3000 }, () => {});
}

export function scheduleChromeMinimize(delayMs = 250) {
  if (process.platform !== "darwin") return;
  const timer = setTimeout(() => minimizeChromeWindow(), delayMs);
  timer.unref?.();
}

export function keepChromeMinimized(context) {
  if (process.platform !== "darwin") return;
  context.on("page", () => scheduleChromeMinimize());
  scheduleChromeMinimize(400);
}
