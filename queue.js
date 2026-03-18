import { Queue } from "bullmq";
import redis from "./lib/redis.js";

export const orderAddressQueue = new Queue("orderAddressQueue", {
    connection: redis,
});