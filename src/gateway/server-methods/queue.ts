import { getCommandQueueSnapshot } from "../../process/command-queue.js";
import { validateQueueHealthParams } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const queueHandlers: GatewayRequestHandlers = {
  "queue.health": ({ params, respond }) => {
    if (!assertValidParams(params, validateQueueHealthParams, "queue.health", respond)) {
      return;
    }
    respond(true, getCommandQueueSnapshot(params), undefined);
  },
};
