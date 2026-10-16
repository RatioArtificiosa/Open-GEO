import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { billingCustomerStatus } from "@/db/schema";
import { autumn } from "@/server/billing/autumn";
import {
  deriveBillingCustomerStatusSnapshot,
  type BillingCustomerStatusSnapshot,
} from "./customer-status-model";
import { syncBillingStatusToLoops } from "./loops-sync";

export async function syncAutumnCustomerStatus(customerId: string): Promise<{
  snapshot: BillingCustomerStatusSnapshot;
  /** True when this sync observed a newly-paying or re-planned org. */
  planChanged: boolean;
}> {
  // getOrCreate is effectively a "get" here — a billing.updated webhook always
  // references an existing Autumn customer. The SDK returns the camelCase shape.
  const customer = await autumn.customers.getOrCreate({ customerId });
  const snapshot = deriveBillingCustomerStatusSnapshot(customer);
  // Read BEFORE the upsert: the funnel's paid stage must fire on the
  // transition, not on the sync. A replayed or out-of-order webhook that
  // converges to the same row must not count a second conversion — and a
  // downgrade is churn, not a conversion, so it stays silent too.
  const prior = await db
    .select({
      isPaying: billingCustomerStatus.isPaying,
      paidPlanId: billingCustomerStatus.paidPlanId,
    })
    .from(billingCustomerStatus)
    .where(eq(billingCustomerStatus.organizationId, customerId));
  const before = prior[0] ?? null;
  await upsertBillingCustomerStatus(snapshot);
  await syncBillingStatusToLoops(snapshot);
  const planChanged =
    snapshot.isPaying &&
    (before === null ||
      !before.isPaying ||
      before.paidPlanId !== snapshot.paidPlanId);
  return { snapshot, planChanged };
}

async function upsertBillingCustomerStatus(
  snapshot: BillingCustomerStatusSnapshot,
) {
  await db
    .insert(billingCustomerStatus)
    .values(snapshot)
    .onConflictDoUpdate({
      target: billingCustomerStatus.organizationId,
      set: {
        isPaying: snapshot.isPaying,
        paidPlanId: snapshot.paidPlanId,
        paidPlanStatus: snapshot.paidPlanStatus,
        customerJson: snapshot.customerJson,
        syncedAt: snapshot.syncedAt,
        updatedAt: sql`(current_timestamp)`,
      },
    });
}
