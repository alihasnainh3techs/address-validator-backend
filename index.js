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

    const session = await db.session.findFirst({ where: { shop } });
    if (!session) throw new Error("Session not found");

    const client = new shopify.clients.Graphql({
        session,
        apiVersion: ApiVersion.April26
    })

    const [shoptags, shopconfig, shopnotification] = await Promise.all([
        db.shoptags.findUnique({ where: { shop } }),
        db.shopconfig.findUnique({ where: { shop } }),
        db.shopnotification.findUnique({ where: { shop } }),
    ]);

    const gid = `gid://shopify/Order/${orderId}`;

    if (action === "address_verified") {
        const tag = shoptags.verified_tag;

        const response = await client.request(
            `mutation addTags($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                    userErrors { field message }
                }
            }`,
            {
                variables: { id: gid, tags: [tag] },
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

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

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
    console.log("Shop: ", fetchedShop);
    const fetchedOrder = orderDetailsResponse.data?.order;
    const customerData = fetchedOrder?.customer;
    console.log("customerData: ", customerData);
    const addressData = fetchedOrder?.shippingAddress;
    console.log("addressData: ", addressData);
    const customerEmail = fetchedOrder?.email || customerData?.email;

    const fullName = [customerData?.firstName, customerData?.lastName].filter(Boolean).join(" ") || "Customer";

    let formattedAddress = "No address provided";
    if (addressData) {
        formattedAddress = [
            addressData.address1,
            addressData.address2,
            addressData.city,
            addressData.province,
            addressData.zip,
            addressData.country
        ].filter(Boolean).join(", ");
    }

    const updateLink = `https://your-app-url.com/update-address/${token}`;

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
        }
    } catch (error) {
        console.error("Error sending email: ", error);
    } finally {
        await db.orderaddresslink.create({
            data: {
                order_id: orderId,
                token: token
            }
        });
    }
}, { connection: redis, concurrency: 50 })

worker.on("completed", (job) => {
    console.log(`${job.id} has completed!`);
});

worker.on("failed", (job, err) => {
    console.log(`${job.id} has failed with ${err.message}`);
});