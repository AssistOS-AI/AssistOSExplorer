const port = Number(process.env.ROBOTEAM_SERVICE_PORT || 3001);

try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(500),
    });
    process.exit(response.ok ? 0 : 1);
} catch {
    process.exit(1);
}
