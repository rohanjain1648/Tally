import { config } from "../config.js";
import { LivePayPal } from "./live.js";
import { MockPayPal } from "./mock.js";
import type { PayPalGateway } from "./types.js";

export const live = config.paypal.mode === "sandbox" ? new LivePayPal() : null;
export const mock = config.paypal.mode === "mock" ? new MockPayPal() : null;
export const paypal: PayPalGateway = (live ?? mock)!;

export * from "./types.js";
