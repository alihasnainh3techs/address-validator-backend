import { Queue } from "bullmq";
import redis from "./lib/redis.js";

export const retryQueue = new Queue("retryQueue", {
    connection: redis,
});
