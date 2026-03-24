import dotenv from "dotenv";
import { Worker } from "bullmq";
import { ApiVersion } from "@shopify/shopify-api";
import shopify from "../lib/shopify.js";
import {
    createGmailTransporter,
    createOutlookTransporter,
} from "../lib/mail.js";
import db from "../lib/prisma.js";
import redis from "../lib/redis.js";
import renderTemplate from "../lib/template.js";
import {
    buildAddress,
    buildName,
    getIntervalMs,
    formatPhoneNumber,
    getWhatsappDeviceStatus,
    interpolateVariables,
} from "../utils.js";
import { retryQueue } from "../queue.js";

dotenv.config();

const retryWorker = new Worker(
    "retryQueue",
    async (job) => {
        const { shop, orderId, action } = job.data;

        console.log("Job data: ", action, shop);


        const session = await db.session.findFirst({ where: { shop } });
        console.log("DB session in retry worker:", session);
        if (!session) throw new Error("Session not found");

        const client = new shopify.clients.Graphql({
            session,
            apiVersion: ApiVersion.April26,
        });

        const gid = `gid://shopify/Order/${orderId}`;

        if (action === "send_reminder") {
            console.log("In remainder");

            const order = await db.order.findUnique({
                where: {
                    shop_order_id: { shop, order_id: orderId.toString() },
                },
            });

            const shopconfig = await db.shopconfig.findUnique({
                where: { shop },
            });

            const addressLink = await db.orderaddresslink.findFirst({
                where: { order_id: order.id },
                orderBy: { created_at: "desc" },
            });

            if (!addressLink) {
                console.error(`Token not found for order ${order.id}`);
                return { message: "Failed: No token found for this order." };
            }
            const token = addressLink.token;

            if (
                !order ||
                order.address_status !== "AWAITING_CUSTOMER_RESPONSE" ||
                order.retry_count >= shopconfig.max_retry_limit
            ) {
                return {
                    message:
                        "Retry cycle stopped: Order completed or limit reached.",
                };
            }

            console.log("Order: ", order);
            console.log("Order: ", addressLink);

            const orderDetails = await client.request(
                `query getOrderDetails($id: ID!) {
            shop {
                name
            }
            order(id: $id) {
                name
                email
                phone 
                customer {
                    firstName
                    lastName
                    email
                    phone
                }
                shippingAddress {
                    firstName
                    lastName    
                    address1
                    address2
                    city
                    province
                    zip
                    country
                }
            }
        }`,
                {
                    variables: { id: gid },
                }
            );

            const store_name = orderDetails.data?.shop?.name;
            const order_number = orderDetails.data?.order?.name;
            const current_address = buildAddress(
                orderDetails.data?.order?.shippingAddress
            );
            const customer_name = buildName(orderDetails.data?.order);
            const customer_email =
                orderDetails.data?.order?.email ||
                orderDetails.data?.order?.customer?.email ||
                null;
            const customer_phone =
                orderDetails.data?.order?.phone ||
                orderDetails.data?.order?.shippingAddress?.phone ||
                orderDetails.data?.order?.customer?.phone ||
                null;
            const update_address_link = `${process.env.APP_BASE_URL}/address-update/${token}`;

            const variables = {
                customer_name,
                order_number,
                store_name,
                update_address_link,
                current_address,
            };

            const shopnotification = await db.shopnotification.findUnique({
                where: { shop },
            });

            if (shopnotification.notification_type === "WHATSAPP") {
                if (!customer_phone) {
                    // Log it and skip — don't throw, don't crash the job
                    console.warn(
                        `No phone number for order ${orderId}, skipping WhatsApp notification`
                    );
                    return;
                }

                const device = await db.device.findUnique({ where: { shop } });
                if (!device) {
                    throw new Error("No WhatsApp device found for this shop");
                }

                const data = await getWhatsappDeviceStatus(device.sessionId);

                if (!data.success) {
                    // Sync DB status to DISCONNECTED
                    await db.device.update({
                        where: { shop },
                        data: { status: "DISCONNECTED" },
                    });
                    throw new Error("WhatsApp device is not connected");
                }

                const msg = interpolateVariables(
                    shopnotification.whatsapp_template,
                    variables
                );

                // Send message via external WhatsApp API
                const sendRes = await fetch(
                    `${process.env.WHATSAPP_API_BASE}/send-message`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            apikey: device.sessionId,
                            to: formatPhoneNumber(customer_phone),
                            msg,
                        }),
                    }
                );

                const sendData = await sendRes.json();
                if (!sendData.success) {
                    throw new Error(
                        sendData.message || "Failed to send WhatsApp message"
                    );
                }
            }

            if (shopnotification.notification_type === "EMAIL") {
                if (!customer_email) {
                    console.warn(
                        `No email for order ${orderId}, skipping EMAIL notification`
                    );
                    return;
                }

                const subject = renderTemplate(
                    shopnotification.email_subject,
                    variables
                );
                const body = renderTemplate(
                    shopnotification.email_body,
                    variables
                );

                const shopemailconfig = await db.shopemailconfig.findUnique({
                    where: { shop },
                });
                const config = JSON.parse(shopemailconfig.config);

                try {
                    if (config.provider === "default") {
                    }

                    if (config.provider === "google") {
                        const { transporter, from } =
                            createGmailTransporter(config);

                        await transporter.sendMail({
                            from: from,
                            to: customer_email,
                            subject: subject,
                            text: body,
                        });
                    }

                    if (config.provider === "sendgrid") {
                    }

                    if (config.provider === "outlook") {
                        const { transporter, from } =
                            createOutlookTransporter(config);

                        await transporter.sendMail({
                            from: from,
                            to: customer_email,
                            subject: subject,
                            text: body,
                        });
                    }
                } catch (error) {
                    console.error(
                        `Failed to send email for order ${orderId}:`,
                        error.message
                    );
                    throw error;
                }
            }

            await db.order.update({
                where: { id: order.id },
                data: { retry_count: { increment: 1 } },
            });

            if (order.retry_count + 1 < shopconfig.max_retry_limit) {
                const delayMs = getIntervalMs(
                    shopconfig.reminder_interval_amount,
                    shopconfig.reminder_interval_unit
                );

                await retryQueue.add(
                    "send_reminder",
                    { ...job.data, action: "send_reminder" },
                    {
                        delay: delayMs,
                        attempts: 3,
                        backoff: {
                            type: "exponential",
                            delay: 10000, // Wait 10s, then 20s, then 40s
                        },
                        removeOnComplete: true,
                        removeOnFail: false,
                    }
                );

                console.log("Job Added Again IN IF CONDITION");
            }
            return { message: `Reminder ${order.retry_count + 1} sent.` };
        }
    },
    { connection: redis, concurrency: 50 }
);

retryWorker.on("completed", (job) => {
    console.log(`${job.id} has completed!`);
});

retryWorker.on("failed", (job, err) => {
    console.log(`${job.id} has failed with ${err.message}`);
});
