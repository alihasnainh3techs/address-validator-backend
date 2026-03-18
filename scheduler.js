import nodeCron from "node-cron";
import { getIntervalMs } from "./utils.js";
import { orderAddressQueue } from "./queue.js";
import db from "./lib/prisma.js";

nodeCron.schedule("* * * * *", async () => {
    console.log("Checking for orders needing reminders...");

    try {
        // Fetch all waiting orders with their shop config in one query
        const orders = await db.order.findMany({
            where: { address_status: "AWAITING_CUSTOMER_RESPONSE" },
        });

        if (!orders.length) return;

        // Get unique shops and fetch all their configs at once
        const uniqueShops = [...new Set(orders.map(o => o.shop))];
        const shopConfigs = await db.shopconfig.findMany({
            where: { shop: { in: uniqueShops } }
        });

        // Map for quick lookup
        const configByShop = Object.fromEntries(shopConfigs.map(c => [c.shop, c]));

        for (const order of orders) {
            const shopConfig = configByShop[order.shop];
            if (!shopConfig) continue;

            // Stop if retry limit reached
            if (order.retry_count >= shopConfig.max_retry_limit) continue;

            const intervalMs = getIntervalMs(
                shopConfig.reminder_interval_amount,
                shopConfig.reminder_interval_unit
            );

            const timeSinceLastUpdate = Date.now() - new Date(order.updated_at).getTime();
            if (timeSinceLastUpdate < intervalMs) continue;

            await orderAddressQueue.add("resend-notification", {
                shop: order.shop,
                orderId: order.order_id,
                customer: order.customer,
                name: order.name,
                failedChecks: JSON.parse(order.failed_rules || "[]"),
                action: "resend_notification",
            });

            console.log(`Queued reminder for ${order.name} (shop: ${order.shop}, attempt ${order.retry_count + 1}/${shopConfig.max_retry_limit})`);
        }
    } catch (err) {
        console.error("Scheduler error:", err);
    }
});