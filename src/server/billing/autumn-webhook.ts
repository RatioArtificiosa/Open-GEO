import { z } from "zod";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";
import { captureServerError, captureServerEvent } from "@/server/lib/posthog";
import { trackDubSalesForOrganization } from "@/server/referrals/dub";
import { syncAutumnCustomerStatus } from "./customer-status-sync";
import { verifySvixSignature } from "./svix";
import { FUNNEL_EVENTS } from "@/shared/analytics-events";

export const AUTUMN_WEBHOOK_PATH = "/api/autumn/webhook";

const autumnWebhookPayloadSchema = z
  .object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

type AutumnWebhookPayload = z.infer<typeof autumnWebhookPayloadSchema>;

export async function handleAutumnWebhookRequest(request: Request) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      headers: { Allow: "POST" },
      status: 405,
    });
  }

  const rawPayload = await request.text();
  const webhookSecret = await getRequiredEnvValue("AUTUMN_WEBHOOK_SECRET");
  const isVerified = await verifySvixSignature({
    headers: request.headers,
    payload: rawPayload,
    secret: webhookSecret,
  });

  if (!isVerified) {
    return json({ error: "Invalid webhook signature" }, 401);
  }

  let payload: AutumnWebhookPayload;
  try {
    payload = autumnWebhookPayloadSchema.parse(JSON.parse(rawPayload));
  } catch {
    return json({ error: "Invalid webhook payload" }, 400);
  }

  // Re-syncing the customer's current state from Autumn is idempotent, so a
  // replayed or out-of-order webhook simply converges to the same row — no
  // dedup table needed. Svix retries on a non-2xx response.
  if (payload.type === "billing.updated") {
    const customerId = getCustomerId(payload);
    if (!customerId) {
      return json({ error: "Missing customer_id" }, 400);
    }

    let planChanged = false;
    try {
      ({ planChanged } = await syncAutumnCustomerStatus(customerId));
    } catch (error) {
      // Drizzle truncates its own message to "Failed query:"; the real driver
      // detail (postgres.js code/constraint) lives on error.cause, so log that
      // explicitly. Also forward to PostHog — this raw handler runs outside the
      // server-function middleware, so nothing else captures it as a $exception.
      console.error("Autumn billing.updated sync failed", customerId, error, {
        cause: error instanceof Error ? error.cause : undefined,
      });
      // Webhooks carry no user; the Autumn customer id is the organization id,
      // which at least makes "users affected" count organizations instead of events.
      await captureServerError(
        error,
        {
          source: "autumn_webhook",
          customer_id: customerId,
        },
        customerId,
      );
      return json({ error: "Webhook processing failed" }, 500);
    }

    // Referral revenue attribution; internally fire-and-forget and can never
    // fail the webhook response.
    await trackDubSalesForOrganization(customerId);

    // The funnel's paid stage.
    //
    // Fired after the sync, not before, because the sync is what makes the
    // claim true — an event recorded for a billing state that failed to land is
    // a conversion that did not happen, counted as one that did. The failure
    // path above has already returned by the time this runs.
    //
    // **No plan name is recorded**, deliberately. A webhook payload's customer
    // record is Autumn's shape and we do not parse it here; the sync writes the
    // durable state. Recording a plan we did not read would be inventing a
    // property, and a funnel whose stage carries a field nothing verified is
    // worse than one whose stage carries a count.
    //
    // Fired only on a newly-paying or re-planned org (the sync's verdict),
    // never on a replay: Svix retries every non-2xx, and a retry that
    // re-counted the conversion would inflate paid. Same for out-of-order
    // delivery converging to an older plan — the row converges, the count
    // does not move.
    if (!planChanged) return json({ received: true });
    await captureServerEvent({
      distinctId: customerId,
      event: FUNNEL_EVENTS.planChanged,
      properties: { source: "autumn_webhook" },
      organizationId: customerId,
    });
  }

  return json({ received: true });
}

function getCustomerId(payload: AutumnWebhookPayload) {
  const value = payload.data.customer_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}
