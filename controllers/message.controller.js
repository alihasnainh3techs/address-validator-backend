import db from "../lib/prisma.js";
import {
    createGmailTransporter,
    createOutlookTransporter,
} from "../lib/mail.js";
import renderTemplate from "../lib/template.js";

export async function sendTestEmail(req, res) {
    try {
        const { shop, email } = req.body;

        const session = await db.session.findFirst({ where: { shop } });
        if (!session) {
            res.status(404).json({
                success: false,
                message: "Session not found",
            });
        }

        const [shopnotification, shopemailconfig] = await Promise.all([
            db.shopnotification.findUnique({ where: { shop } }),
            db.shopemailconfig.findUnique({ where: { shop } }),
        ]);

        if (shopnotification.notification_type !== "EMAIL") {
            res.status(400).json({
                success: false,
                message: "Invalid notification type",
            });
        }

        const variables = {
            customer_name: "John Doe",
            order_number: "#1028",
            store_name: "My Store",
            update_address_link: "https://example.com/update-address",
            current_address: "123 Main St, Anytown, USA",
        };

        const subject = renderTemplate(
            shopnotification.email_subject,
            variables
        );
        const body = renderTemplate(shopnotification.email_body, variables);

        const config = JSON.parse(shopemailconfig.config);

        if (config.provider === "default") {
        }

        if (config.provider === "google") {
            const { transporter, from } = createGmailTransporter(config);

            await transporter.sendMail({
                from: from,
                to: email,
                subject: subject,
                text: body,
            });
        }

        if (config.provider === "sendgrid") {
        }

        if (config.provider === "outlook") {
            const { transporter, from } = createOutlookTransporter(config);

            await transporter.sendMail({
                from: from,
                to: email,
                subject: subject,
                text: body,
            });
        }

        res.json({ success: true, message: "Test email sent successfully" });
    } catch (error) {
        console.log("Error occurred while sending test email: ", error);

        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
}
