import { Badge } from "@/components/ui";
import { DELIVERY, deliveryOf } from "./delivery";

/** Delivery state as icon + text, so it never relies on colour alone. */
export function DeliveryBadge({ status }: { status: string }) {
  const d = DELIVERY[deliveryOf(status)];
  return (
    <Badge tone={d.tone} icon={d.icon}>
      {d.label}
    </Badge>
  );
}
