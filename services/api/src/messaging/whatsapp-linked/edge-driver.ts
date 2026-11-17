import { Cp2Error } from "../../cp2/cp2-error.js";
import type { LinkedDriver } from "./connector.js";

// Edge builds substitute this module for baileys-driver.ts. Socket hosting and its protocol
// dependencies belong to a Node connector or the Android sidecar, not the serverless API.
export function createBaileysLinkedDriver(): LinkedDriver {
  return {
    async open() {
      throw new Cp2Error(
        503,
        "whatsapp_linked_host_required",
        "Host your WhatsApp connection on an enrolled connector or Android device."
      );
    }
  };
}

export const baileysLinkedDriver = createBaileysLinkedDriver();
