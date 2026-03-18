import crypto from "crypto";
import { Worker } from "bullmq";
import { ApiVersion } from "@shopify/shopify-api";
import shopify from "./lib/shopify.js";
import transporter from "./lib/mail.js";
import db from "./lib/prisma.js";
import redis from "./lib/redis.js";
import renderTemplate from "./lib/template.js";

const worker = new Worker("orderAddressQueue", async (job) => {

    const { shop, orderId, customer, name, failedChecks, action } = job.data;

    const session = await db.Session.findFirst({ where: { shop } });
    if (!session) throw new Error("Session not found");

    const client = new shopify.clients.Graphql({
        session,
        apiVersion: ApiVersion.April26
    })

    const [shoptags, shopconfig, shopnotification] = await Promise.all([
        db.ShopTags.findUnique({ where: { shop } }),
        db.ShopConfig.findUnique({ where: { shop } }),
        db.ShopNotification.findUnique({ where: { shop } }),
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

        return await db.Order.upsert({
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

    const dbOrder = await db.Order.upsert({
        where: { shop_order_id: { shop, order_id: orderId.toString() } },
        update: {
            failed_rules: JSON.stringify(failedChecks),
            updated_at: new Date()
        },
        create: {
            shop,
            order_id: orderId.toString(),
            customer,
            name,
            address_status: "INCOMPLETE",
            failed_rules: JSON.stringify(failedChecks),
            updated_at: new Date()
        }
    });

    let linkRecord = await db.OrderAddressLink.findFirst({
        where: { order_id: dbOrder.id }
    });

    let token = linkRecord?.token;

    if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        linkRecord = await db.orderAddressLink.create({
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

    const updateLink = `https://your-app-url.com/address-update/${token}`;

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

            await db.Order.update({
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