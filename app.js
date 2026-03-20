import express from "express";
import cors from "cors";

const app = express();

app.use(express.json());
app.use(
    cors({
        origin: process.env.CORS_ORIGIN,
        credentials: true,
    })
);

//routes import
import messageRouter from "./routes/message.route.js";

//routes declaration
app.use("/api/v1/message", messageRouter);

export { app };
