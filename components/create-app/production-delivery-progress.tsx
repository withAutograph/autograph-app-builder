import { deliveryProgressDetail, deliveryProgressLabels } from "../../lib/delivery-progress";
import type { DeliveryProgress } from "../../lib/delivery-progress";

export const ProductionDeliveryProgress = ({
  progress,
  onOpenLink,
  showAppLink = true,
}: {
  progress: DeliveryProgress;
  onOpenLink?: (url: string) => Promise<void>;
  showAppLink?: boolean;
}) => {
  const detail = deliveryProgressDetail(progress);
  const appUrl = showAppLink ? progress.appUrl : undefined;
  return (
    <section aria-label="Production delivery">
      <p role="status">
        <strong>{deliveryProgressLabels[progress.phase]}</strong>
        {detail === undefined ? null : ` · ${detail}`}
      </p>
      {appUrl === undefined ? null : (
        <a
          href={appUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={
            onOpenLink === undefined
              ? undefined
              : (event) => {
                  event.preventDefault();
                  void onOpenLink(appUrl);
                }
          }
        >
          {progress.phase === "live" ? "Open app" : "Open current app"}
        </a>
      )}
    </section>
  );
};
