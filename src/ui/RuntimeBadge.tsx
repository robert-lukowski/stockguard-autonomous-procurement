import { Lock } from "lucide-react";
import {
  runtimeClassifications,
  type RuntimeClassificationId,
} from "./runtimeClassification";

type Props = {
  id: RuntimeClassificationId;
  /** Renders the one-line meaning next to the label. */
  withMeaning?: boolean;
  size?: "sm" | "md";
};

export function RuntimeBadge({ id, withMeaning = false, size = "md" }: Props) {
  const classification = runtimeClassifications[id];
  const padding = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border font-medium tracking-wide uppercase ${padding} ${classification.tone}`}
      >
        {classification.available ? (
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${classification.dot}`}
          />
        ) : (
          <Lock aria-hidden="true" className="size-3" />
        )}
        {classification.label}
        {!classification.available && (
          <span className="font-normal normal-case opacity-80">
            · not connected
          </span>
        )}
      </span>
      {withMeaning && (
        <span className="text-xs text-ground-400">{classification.meaning}</span>
      )}
    </span>
  );
}

/** The full legend. Shown once, so a judge can decode every badge on the page. */
export function RuntimeLegend({ ids }: { ids: RuntimeClassificationId[] }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {ids.map((id) => {
        const classification = runtimeClassifications[id];
        return (
          <div
            key={id}
            className="flex flex-col gap-1 rounded-lg border border-ground-700/40 bg-ground-900/40 p-3"
          >
            <dt>
              <RuntimeBadge id={id} size="sm" />
            </dt>
            <dd className="text-xs leading-relaxed text-ground-400">
              {classification.meaning}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
