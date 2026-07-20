export function processGroupExists(pid, kill = process.kill) {
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export async function waitForProcessGroupExit(pid, options = {}) {
  const kill = options.kill ?? process.kill;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (processGroupExists(pid, kill)) await delay(25);
}
