export function getIntervalMs(amount, unit) {
    switch (unit) {
        case "MINUTES": return amount * 60 * 1000;
        case "HOURS": return amount * 60 * 60 * 1000;
        case "DAYS": return amount * 24 * 60 * 60 * 1000;
        default: return amount * 60 * 60 * 1000;
    }
}