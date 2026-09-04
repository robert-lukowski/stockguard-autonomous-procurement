/**
 * Operational metrics for the procurement core.
 *
 * Emitted as CloudWatch Embedded Metric Format (EMF) JSON on stdout. In Lambda
 * that is all CloudWatch needs: the log agent extracts the metrics, so nothing
 * here calls an AWS API, holds a credential, or needs the AWS SDK. Locally and
 * in tests the same events are collected in memory.
 *
 * Amazon Managed Grafana reads these from CloudWatch; no separate exporter is
 * required.
 */

export const PROCUREMENT_METRIC_NAMESPACE = "StockGuard/Procurement";

export type ProcurementMetricName =
  | "RunStarted"
  | "RunAccepted"
  | "RunRejected"
  | "RunHumanReview"
  | "ToolError"
  | "RunDurationMs";

export type MetricUnit = "Count" | "Milliseconds";

export const procurementMetricUnits: Record<ProcurementMetricName, MetricUnit> = {
  RunStarted: "Count",
  RunAccepted: "Count",
  RunRejected: "Count",
  RunHumanReview: "Count",
  ToolError: "Count",
  RunDurationMs: "Milliseconds",
};

export type MetricDimensions = {
  Channel: string;
  MissionId: string;
};

export type ProcurementMetric = {
  name: ProcurementMetricName;
  value: number;
  unit: MetricUnit;
  dimensions: MetricDimensions;
  at: string;
  /** Non-dimension context. High-cardinality values belong here, not above. */
  properties: Record<string, string | number | boolean>;
};

export interface MetricSink {
  record(metric: ProcurementMetric): void;
}

/** Test and Judge Portal sink. Keeps every metric for assertion and display. */
export class InMemoryMetricSink implements MetricSink {
  private readonly metrics: ProcurementMetric[] = [];

  record(metric: ProcurementMetric): void {
    this.metrics.push(structuredClone(metric));
  }

  get all(): ProcurementMetric[] {
    return this.metrics.map((metric) => structuredClone(metric));
  }

  countOf(name: ProcurementMetricName): number {
    return this.metrics
      .filter((metric) => metric.name === name)
      .reduce((total, metric) => total + metric.value, 0);
  }

  clear(): void {
    this.metrics.length = 0;
  }
}

/**
 * The EMF envelope CloudWatch parses out of a log line.
 *
 * Kept as a pure function so the shape is testable without capturing stdout.
 */
export function toEmbeddedMetricFormat(metric: ProcurementMetric): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: Date.parse(metric.at),
      CloudWatchMetrics: [
        {
          Namespace: PROCUREMENT_METRIC_NAMESPACE,
          Dimensions: [["Channel", "MissionId"]],
          Metrics: [{ Name: metric.name, Unit: metric.unit }],
        },
      ],
    },
    Channel: metric.dimensions.Channel,
    MissionId: metric.dimensions.MissionId,
    [metric.name]: metric.value,
    ...metric.properties,
  };
}

/** Production sink: one EMF line per metric, no AWS SDK, no network call. */
export class EmbeddedMetricFormatSink implements MetricSink {
  constructor(private readonly write: (line: string) => void = console.log) {}

  record(metric: ProcurementMetric): void {
    this.write(JSON.stringify(toEmbeddedMetricFormat(metric)));
  }
}
