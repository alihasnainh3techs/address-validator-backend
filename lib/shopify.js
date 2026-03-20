import dotenv from "dotenv";
import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";

dotenv.config();

const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SCOPES?.split(","),
    apiVersion: ApiVersion.April26,
    hostName: process.env.HOST_NAME,
    hostScheme: "http",
    isEmbeddedApp: false,
});

export default shopify;
