import { createNoSkrapTelemetryHandler } from "noskrap/next";
import { config, verified } from "../../../../shared.js";
export const POST = createNoSkrapTelemetryHandler({ ...config, verifyTelemetry: verified });
