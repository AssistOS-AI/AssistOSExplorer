const result = await fetch(`http://127.0.0.1:${Number(process.env.ROBOWORK_SERVICE_PORT || 3001)}/health`, { signal: AbortSignal.timeout(500) });
if (!result.ok || !(await result.json()).ok) process.exitCode = 1;
