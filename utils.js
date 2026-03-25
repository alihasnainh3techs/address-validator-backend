import db from "./lib/prisma.js";

export async function getValidSession(shop) {
    // 1. Fetch offline session from DB
    let session = await db.session.findFirst({
        where: { shop, isOnline: false },
    });

    if (!session) {
        throw new Error("No offline session found for shop: " + shop);
    }

    const now = new Date();

    // 2. Check if refresh token has expired
    if (session.refreshTokenExpires && now >= new Date(session.refreshTokenExpires)) {
        throw new Error(
            `Refresh token expired for shop ${shop}. Merchant must re-open the app to re-authorize.`,
        );
    }

    // 3. Check if access token is expired or about to expire within 5 minutes
    const bufferMs = 5 * 60 * 1000;
    const isAccessTokenExpired =
        session.expires &&
        new Date(session.expires).getTime() <= now.getTime() + bufferMs;

    if (isAccessTokenExpired) {
        console.log(`Access token expired/expiring for ${shop}, refreshing...`);

        try {
            const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: process.env.SHOPIFY_API_KEY,
                    client_secret: process.env.SHOPIFY_API_SECRET,
                    grant_type: "refresh_token",
                    refresh_token: session.refreshToken,
                }),
            });

            const data = await response.json();

            console.log("Data: ", data);

            if (!response.ok) {
                throw new Error(
                    `Refresh failed for ${shop}: ${data.error_description || data.error}`,
                );
            }

            if (!data.access_token) {
                throw new Error(`Refresh response missing access_token for shop ${shop}`);
            }

            // 4. Update the Database with NEW tokens
            const updated = await db.session.update({
                where: { id: session.id },
                data: {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token ?? session.refreshToken,
                    expires: new Date(Date.now() + data.expires_in * 1000),
                    refreshTokenExpires: new Date(Date.now() + data.refresh_token_expires_in * 1000),
                    scope: data.scope ?? session.scope,
                },
            });

            session = updated;
            console.log(`Token refreshed successfully for ${shop}.`);
        } catch (error) {
            console.error("Critical error refreshing token for", shop, ":", error);
            // Surface the error so caller can decide how to handle (e.g., mark job as needs re-auth)
            throw error;
        }
    }

    return session;
}

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
