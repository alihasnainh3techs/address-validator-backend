export function getIntervalMs(amount, unit) {
    switch (unit) {
        case "MINUTES":
            return amount * 60 * 1000;
        case "HOURS":
            return amount * 60 * 60 * 1000;
        case "DAYS":
            return amount * 24 * 60 * 60 * 1000;
        default:
            return amount * 60 * 60 * 1000;
    }
}

export function buildAddress(shippingAddress) {
    if (!shippingAddress) return "No address provided";

    const parts = [
        shippingAddress.address1,
        shippingAddress.address2,
        shippingAddress.city,
        shippingAddress.province,
        shippingAddress.zip,
        shippingAddress.country,
    ];
    return parts.filter(Boolean).join(" ").trim();
}

export function buildName(order) {
    const firstName =
        order.shippingAddress?.firstName ||
        order.customer?.firstName ||
        "Customer";

    const lastName =
        order.shippingAddress?.lastName || order.customer?.lastName || "";

    return `${firstName} ${lastName}`.trim();
}

export function interpolateVariables(template, variables) {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
        return variables[key] !== undefined ? variables[key] : `{{${key}}}`;
    });
}

export async function getWhatsappDeviceStatus(sessionId) {
    const response = await fetch(
        `${process.env.WHATSAPP_API_BASE}/get-device-status?apikey=${sessionId}`,
        { method: "GET", headers: { "Content-Type": "application/json" } }
    );

    const data = await response.json();
    return data;
}

export function formatPhoneNumber(phone) {
    if (!phone) return null;

    return phone.replace(/\D/g, "");
}
