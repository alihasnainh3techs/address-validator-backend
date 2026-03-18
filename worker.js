import dotenv from "dotenv";
import crypto from "crypto";
import { Worker } from "bullmq";
import { ApiVersion } from "@shopify/shopify-api";
import shopify from "./lib/shopify.js";
import transporter from "./lib/mail.js";
import db from "./lib/prisma.js";
import redis from "./lib/redis.js";
import renderTemplate from "./lib/template.js";

dotenv.config();

const worker = new Worker("orderAddressQueue", async (job) => {

    const { shop, orderId, customer, name, failedChecks, action } = job.data;

    const session = await db.session.findFirst({ where: { shop } });
    if (!session) throw new Error("Session not found");

    const client = new shopify.clients.Graphql({
        session,
        apiVersion: ApiVersion.April26
    })

    const [shoptags, shopnotification] = await Promise.all([
        db.shoptags.findUnique({ where: { shop } }),
        db.shopnotification.findUnique({ where: { shop } }),
    ]);

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
            const errorMsg = response.data.tagsAdd.userErrors.map(e => e.message).join(", ");
            throw new Error(`Shopify GraphQL Error: ${errorMsg}`);
        }

        return await db.order.upsert({
            where: {
                shop_order_id: {
                    shop: shop,
                    order_id: orderId.toString()
                }
            },
            update: { shop, updated_at: new Date() },
            create: { shop, order_id: orderId.toString(), customer, name, updated_at: new Date() }
        });
    }

    if (action === "resend_notification") {
        // Just resend the notification, no tag changes, no upsert side effects

        const dbOrder = await db.order.findUnique({
            where: { shop_order_id: { shop, order_id: orderId.toString() } },
            include: { orderaddresslink: { take: 1, orderBy: { created_at: "desc" } } }
        });

        if (!dbOrder || !dbOrder.orderaddresslink.length) {
            console.warn(`Reminder skipped: no order/token found for ${orderId}`);
            return;
        }

        const token = dbOrder.orderaddresslink[0].token;

        const orderDetailsResponse = await client.request(
            `query getOrderDetails($id: ID!) {
            shop { name }
            order(id: $id) {
                name
                email
                customer { firstName lastName email }
                shippingAddress {
                    address1 address2 city province zip country
                }
            }
        }`,
            { variables: { id: gid } }
        );

        const fetchedShop = orderDetailsResponse.data?.shop;
        const fetchedOrder = orderDetailsResponse.data?.order;
        const customerData = fetchedOrder?.customer;
        const addressData = fetchedOrder?.shippingAddress;
        const customerEmail = fetchedOrder?.email || customerData?.email;

        const fullName = [customerData?.firstName, customerData?.lastName].filter(Boolean).join(" ") || "Customer";
        const formattedAddress = addressData
            ? [addressData.address1, addressData.address2, addressData.city, addressData.province, addressData.zip, addressData.country].filter(Boolean).join(", ")
            : "No address provided";

        const updateLink = `${process.env.APP_BASE_URL}/address-update/${token}`;

        const variables = {
            customer_name: fullName,
            order_number: fetchedOrder.name,
            store_name: fetchedShop?.name || shop,
            update_address_link: updateLink,
            current_address: formattedAddress,
        };

        if (shopnotification.notification_type === "EMAIL") {
            const subject = renderTemplate(shopnotification.email_subject, variables);
            const body = renderTemplate(shopnotification.email_body, variables);

            await transporter.sendMail({
                from: "Address Validator <no-reply@alihasnain.h3techs@gmail.com>",
                to: customerEmail,
                subject,
                text: body,
            });
        }

        if (shopnotification.notification_type === "WHATSAPP") {

        }

        // Only increment retry_count and refresh updated_at (used by scheduler for next interval)
        await db.order.update({
            where: { id: dbOrder.id },
            data: {
                retry_count: { increment: 1 },
                updated_at: new Date()
            }
        });

        console.log(`Reminder sent for order ${dbOrder.name}, retry_count now ${dbOrder.retry_count + 1}`);
        return;
    }

    const response = await client.request(
        `mutation addTags($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { variables: { id: gid, tags: [shoptags.incomplete_tag] } }
    );

    if (response.data?.tagsAdd?.userErrors?.length > 0) {
        const errorMsg = response.data.tagsAdd.userErrors.map(e => e.message).join(", ");
        throw new Error(`Shopify GraphQL Error: ${errorMsg}`);
    }

    const dbOrder = await db.order.upsert({
        where: { shop_order_id: { shop, order_id: orderId.toString() } },
        update: {
            failed_rules: JSON.stringify(failedChecks),
            // retry_count: { increment: 1 },
            updated_at: new Date()
        },
        create: {
            shop,
            order_id: orderId.toString(),
            customer,
            name,
            address_status: "INCOMPLETE",
            failed_rules: JSON.stringify(failedChecks),
            retry_count: 0,
            updated_at: new Date()
        }
    });

    let linkRecord = await db.orderaddresslink.findFirst({
        where: { order_id: dbOrder.id }
    });

    let token = linkRecord?.token;

    if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        linkRecord = await db.orderaddresslink.create({
            data: {
                order_id: dbOrder.id,
                token: token
            }
        });
    }

    const orderDetailsResponse = await client.request(
        `query getOrderDetails($id: ID!) {
            shop {
                name
            }
            order(id: $id) {
                name
                email
                customer {
                    firstName
                    lastName
                    email
                }
                shippingAddress {
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

    const fetchedShop = orderDetailsResponse.data?.shop;
    const fetchedOrder = orderDetailsResponse.data?.order;
    const customerData = fetchedOrder?.customer;
    const addressData = fetchedOrder?.shippingAddress;
    const customerEmail = fetchedOrder?.email || customerData?.email;

    const fullName = [customerData?.firstName, customerData?.lastName].filter(Boolean).join(" ") || "Customer";

    const formattedAddress = addressData
        ? [addressData.address1, addressData.address2, addressData.city, addressData.province, addressData.zip, addressData.country].filter(Boolean).join(", ")
        : "No address provided";

    const updateLink = `${process.env.APP_BASE_URL}/address-update/${token}`;

    const variables = {
        customer_name: fullName,
        order_number: fetchedOrder.name,
        store_name: fetchedShop?.name || shop,
        update_address_link: updateLink,
        current_address: formattedAddress,
    }

    try {
        if (shopnotification.notification_type === "WHATSAPP") {

        }

        if (shopnotification.notification_type === "EMAIL") {
            const subject = renderTemplate(
                shopnotification.email_subject,
                variables
            );

            const body = renderTemplate(
                shopnotification.email_body,
                variables
            );

            await transporter.sendMail({
                from: "Address Validator <no-reply@alihasnain.h3techs@gmail.com>",
                to: customerEmail,
                subject: subject,
                text: body,
            })

            const response = await client.request(
                `mutation switchTags($id: ID!, $add: [String!]!, $remove: [String!]!) {
                    tagsAdd(id: $id, tags: $add) { userErrors { message } }
                    tagsRemove(id: $id, tags: $remove) { userErrors { message } }
                }`,
                {
                    variables: {
                        id: gid,
                        add: [shoptags.awaiting_update_tag],
                        remove: [shoptags.incomplete_tag]
                    },
                }
            );

            if (response.data?.tagsAdd?.userErrors?.length > 0) {
                const errorMsg = response.data.tagsAdd.userErrors.map(e => e.message).join(", ");
                throw new Error(`Shopify GraphQL Error: ${errorMsg}`);
            }

            await db.order.update({
                where: { id: dbOrder.id },
                data: { address_status: "AWAITING_CUSTOMER_RESPONSE" }
            });
        }
    } catch (error) {
        console.error("Error sending email: ", error);
        throw error;
    }
}, { connection: redis, concurrency: 50 })

worker.on("completed", (job) => {
    console.log(`${job.id} has completed!`);
});

worker.on("failed", (job, err) => {
    console.log(`${job.id} has failed with ${err.message}`);
});