import dotenv from "dotenv";
import crypto from "crypto";
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
    formatPhoneNumber,
    buildAddress,
    buildName,
    getIntervalMs,
    getWhatsappDeviceStatus,
    interpolateVariables,
    getValidSession
} from "../utils.js";
import { retryQueue } from "../queue.js";

dotenv.config();

const worker = new Worker(
    "orderAddressQueue",
    async (job) => {
        const { shop, orderId, customer, name, failedChecks, action } =
            job.data;

        // const session = await db.session.findFirst({ where: { shop } });
        // console.log("DB session in worker:", session);
        // if (!session) {
        //     throw new Error("Session not found");
        // };

        const session = await getValidSession(shop);

        const client = new shopify.clients.Graphql({
            session,
            apiVersion: ApiVersion.April26,
        });

        const shoptags = await db.shoptags.findUnique({ where: { shop } });

        const gid = `gid://shopify/Order/${orderId}`;

        if (action === "address_verified") {
            const response = await client.request(
                `mutation addTags($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                    userErrors { field message }
                }
            }`,
                {
                    variables: { id: gid, tags: [shoptags.verified_tag] },
                }
            );

            if (response.data?.tagsAdd?.userErrors?.length > 0) {
                const errorMsg = response.data.tagsAdd.userErrors
                    .map((e) => e.message)
                    .join(", ");
                throw new Error(`Shopify GraphQL Error: ${errorMsg}`);
            }

            return await db.order.upsert({
                where: {
                    shop_order_id: {
                        shop: shop,
                        order_id: orderId.toString(),
                    },
                },
                update: {
                    address_status: "COMPLETE",
                    updated_at: new Date(),
                },
                create: {
                    shop,
                    order_id: orderId.toString(),
                    customer,
                    name,
                    address_status: "COMPLETE",
                    updated_at: new Date(),
                },
            });
        }

        if (action === "address_incomplete") {
            const response = await client.request(
                `mutation addTags($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                    userErrors { field message }
                }
            }`,
                {
                    variables: { id: gid, tags: [shoptags.incomplete_tag] },
                }
            );

            if (response.data?.tagsAdd?.userErrors?.length > 0) {
                const errorMsg = response.data.tagsAdd.userErrors
                    .map((e) => e.message)
                    .join(", ");
                throw new Error(`Shopify GraphQL Error: ${errorMsg}`);
            }

            const order = await db.order.upsert({
                where: {
                    shop_order_id: {
                        shop: shop,
                        order_id: orderId.toString(),
                    },
                },
                update: {
                    address_status: "INCOMPLETE",
                    updated_at: new Date(),
                },
                create: {
                    shop,
                    order_id: orderId.toString(),
                    customer,
                    name,
                    failed_rules: JSON.stringify(failedChecks),
                    address_status: "INCOMPLETE",
                    updated_at: new Date(),
                },
            });

            const token = crypto.randomBytes(24).toString("hex");

            await db.orderaddresslink.create({
                data: {
                    order_id: order.id,
                    token,
                    created_at: new Date(),
                },
            });

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
                    phone    
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

            const swapTagsResponse = await client.request(
                `mutation swapTags($id: ID!, $removeTags: [String!]!, $addTags: [String!]!) {
            tagsRemove(id: $id, tags: $removeTags) {
                userErrors { field message }
            }
            tagsAdd(id: $id, tags: $addTags) {
                userErrors { field message }
            }
        }`,
                {
                    variables: {
                        id: gid,
                        removeTags: [shoptags.incomplete_tag],
                        addTags: [shoptags.awaiting_update_tag],
                    },
                }
            );

            if (swapTagsResponse.data?.tagsRemove?.userErrors?.length > 0) {
                const errorMsg = swapTagsResponse.data.tagsRemove.userErrors
                    .map((e) => e.message)
                    .join(", ");
                throw new Error(`Shopify Tag Remove Error: ${errorMsg}`);
            }

            if (swapTagsResponse.data?.tagsAdd?.userErrors?.length > 0) {
                const errorMsg = swapTagsResponse.data.tagsAdd.userErrors
                    .map((e) => e.message)
                    .join(", ");
                throw new Error(`Shopify Tag Add Error: ${errorMsg}`);
            }

            await db.order.update({
                where: {
                    shop_order_id: {
                        shop: shop,
                        order_id: orderId.toString(),
                    },
                },
                data: {
                    address_status: "AWAITING_CUSTOMER_RESPONSE",
                    updated_at: new Date(),
                },
            });

            const config = await db.shopconfig.findUnique({ where: { shop } });
            if (config.max_retry_limit > 0) {
                const delayMs = getIntervalMs(
                    config.reminder_interval_amount,
                    config.reminder_interval_unit
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
                console.log("Retry job queued");
            }
        }
    },
    { connection: redis, concurrency: 50 }
);

worker.on("completed", (job) => {
    console.log(`${job.id} has completed!`);
});

worker.on("failed", (job, err) => {
    console.log(`${job.id} has failed with ${err.message}`);
});
