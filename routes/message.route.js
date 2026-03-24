import { Router } from "express";
import {
    sendTestEmail,
    sendTestMessage,
} from "../controllers/message.controller.js";

const router = Router();

router.route("/email").post(sendTestEmail);
router.route("/whatsapp").post(sendTestMessage);

export default router;
