import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

// const transporter = nodemailer.createTransport({
//     service: "gmail",
//     port: 465,
//     secure: true,
//     auth: {
//         user: process.env.SMTP_EMAIL,
//         pass: process.env.SMTP_PASSWORD,
//     },
// });

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",  // use explicit host instead of service:"gmail"
    port: 587,               // 587 (TLS) instead of 465 (SSL) — more compatible
    secure: false,           // true for 465, false for 587
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
    },
    family: 4,               // 👈 forces IPv4
});

export default transporter;