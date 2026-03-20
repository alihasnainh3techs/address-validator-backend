import { Router } from "express";
import { sendTestEmail } from "../controllers/message.controller.js";

const router = Router();

router.route("/email").post(sendTestEmail);

export default router;
