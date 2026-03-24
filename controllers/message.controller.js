import db from "../lib/prisma.js";
import {
    createGmailTransporter,
    createOutlookTransporter,
} from "../lib/mail.js";
import renderTemplate from "../lib/template.js";
import { getWhatsappDeviceStatus, interpolateVariables } from "../utils.js";

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

export async function sendTestMessage(req, res) {
    try {
        const { shop, phone } = req.body;

        const session = await db.session.findFirst({ where: { shop } });
        if (!session) {
            res.status(404).json({
                success: false,
                message: "Session not found",
            });
        }

        const [shopnotification, device] = await Promise.all([
            db.shopnotification.findUnique({ where: { shop } }),
            db.device.findUnique({ where: { shop } }),
        ]);

        if (shopnotification.notification_type !== "WHATSAPP") {
            res.status(400).json({
                success: false,
                message: "Invalid notification type",
            });
        }

        if (!device) {
            return res.status(404).json({
                success: false,
                message: "No WhatsApp device found for this shop",
            });
        }

        const data = await getWhatsappDeviceStatus(device.sessionId);

        if (!data.success) {
            // Sync DB status to DISCONNECTED
            await db.device.update({
                where: { shop },
                data: { status: "DISCONNECTED" },
            });

            return res.status(400).json({
                success: false,
                message:
                    "WhatsApp device is not connected. Please reconnect and try again.",
            });
        }

        const variables = {
            customer_name: "John Doe",
            order_number: "#1028",
            store_name: "My Store",
            update_address_link: "https://example.com/update-address",
            current_address: "123 Main St, Anytown, USA",
        };

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
                    to: phone,
                    msg,
                }),
            }
        );

        const sendData = await sendRes.json();

        if (!sendData.success) {
            return res.status(400).json({
                success: false,
                message: sendData.message || "Failed to send WhatsApp message",
            });
        }

        return res.json({
            success: true,
            message: "Test message sent successfully",
        });
    } catch (error) {
        console.log("Error occurred while sending test message: ", error);

        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
}
