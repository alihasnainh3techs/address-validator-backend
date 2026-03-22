import "./workers/worker.js";
import "./workers/retry-worker.js";
import { app } from "./app.js";
import dotenv from "dotenv";

dotenv.config();

app.listen(process.env.PORT || 3000, () => {
    console.log(`⚙️ Server is running at port : ${process.env.PORT}`);
});
