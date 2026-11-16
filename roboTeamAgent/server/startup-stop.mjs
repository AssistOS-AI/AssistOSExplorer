// Ploinky's targeted restart sends TERM and takes only exit status 0 as the acknowledgement that the drain completed.
// Until the service listens it has accepted no request and observes no task, so a stop that arrives then has nothing
// to drain and is acknowledged at once. Left to the default action the process would end by signal, which Ploinky
// never takes as an acknowledgement: the restart is refused and the agent stays unavailable until an operator
// accepts the refusal.
export function acknowledgeStopsUntilListening(target = process) {
    const acknowledge = () => target.exit(0);
    target.on('SIGINT', acknowledge);
    target.on('SIGTERM', acknowledge);
    // The service's own shutdown takes over; the two handlers are never installed together.
    return function handOver(shutdown) {
        target.off('SIGINT', acknowledge);
        target.off('SIGTERM', acknowledge);
        target.on('SIGINT', shutdown);
        target.on('SIGTERM', shutdown);
    };
}
