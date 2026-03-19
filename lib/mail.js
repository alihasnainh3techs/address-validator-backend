import nodemailer from "nodemailer";

export function createGmailTransporter(config) {
    const { email, app_password, port, custom_from_name, from_name } = config;

    const portNumber = parseInt(port, 10);

    // port 465 = SSL (secure: true), port 587 = TLS (secure: false)
    const isSSL = portNumber === 465;

    const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: portNumber,
        secure: isSSL, // true for 465 (SSL), false for 587 (TLS)
        auth: {
            user: email,
            pass: app_password,
        },
    });

    // Build the "from" string
    const from =
        custom_from_name && from_name
            ? `"${from_name}" <${email}>`
            : email;

    return { transporter, from };
}

export function createOutlookTransporter(config) {
    const { email, app_password, custom_from_name, from_name } = config;

    const transporter = nodemailer.createTransport({
        host: "smtp-mail.outlook.com",
        port: 587,
        secure: false,
        auth: {
            user: email,
            pass: app_password,
        },
    });

    const from =
        custom_from_name && from_name
            ? `"${from_name}" <${email}>`
            : email;

    return { transporter, from };
}