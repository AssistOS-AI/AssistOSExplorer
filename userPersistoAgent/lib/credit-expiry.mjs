const permanent = Number.POSITIVE_INFINITY;

// Rebuild reservation allocations from the journal. Awards and purchases
// with no expiration remain available until spent.
export function replayCreditLots(entries) {
    const lots = new Map();
    const reservations = new Map();
    const spent = new Map();
    let order = 0;
    for (const entry of entries) {
        const { txId, type, amount, referenceId } = entry;
        if (type === 'grant' || type === 'purchase' || type === 'adminAdjustment'
            || (type === 'refund' && entry.restoresSpend !== 'yes')) {
            lots.set(txId, {
                id: txId, referenceId, remaining: amount, order: order++,
                deadline: entry.expiresAt ? Date.parse(entry.expiresAt) : permanent,
            });
        } else if (type === 'reserve') {
            let remaining = amount;
            const allocations = [];
            const eligible = [...lots.values()].filter(lot => lot.remaining > 0)
                .sort((a,b) => (a.deadline === b.deadline ? a.order - b.order : a.deadline - b.deadline));
            for (const lot of eligible) {
                if (!remaining) break;
                const allocated = Math.min(lot.remaining, remaining);
                lot.remaining -= allocated;
                remaining -= allocated;
                allocations.push({ lot, amount: allocated });
            }
            if (remaining) throw new Error('Credit reservation has no matching funds.');
            reservations.set(referenceId, allocations);
        } else if (type === 'spend') {
            spent.set(referenceId, reservations.get(referenceId));
            reservations.delete(referenceId);
        } else if (type === 'release' || type === 'refund') {
            const allocations = (type === 'release' ? reservations : spent).get(referenceId);
            if (!allocations) throw new Error('Credit return has no matching reservation.');
            for (const allocation of allocations) allocation.lot.remaining += allocation.amount;
            if (type === 'release') reservations.delete(referenceId);
        } else if (type === 'expire') {
            const lot = lots.get(entry.expiredLotId);
            if (!lot || lot.remaining < amount) throw new Error('Credit expiration has no matching award.');
            lot.remaining -= amount;
        }
    }
    return [...lots.values()];
}
