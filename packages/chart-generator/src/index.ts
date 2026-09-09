// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/chart-generator — Chart generation for code execution results.
 *
 * Inspired by e2b's code-interpreter chart types.
 * Provides typed chart definitions that code execution can emit,
 * with rendering to various formats (SVG, HTML, JSON).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ChartType = "line" | "scatter" | "bar" | "pie" | "box" | "heatmap";
export type ScaleType = "linear" | "datetime" | "categorical" | "log";

export interface ChartAxis {
  label?: string;
  unit?: string;
  scale: ScaleType;
  ticks?: (number | string)[];
  tickLabels?: string[];
}

export interface PointData {
  label: string;
  points: [number | string, number | string][];
}

export interface BarData {
  label: string;
  value: number;
  group?: string;
}

export interface PieData {
  label: string;
  value: number;
  color?: string;
}

export interface BoxData {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers?: number[];
}

export interface Chart {
  type: ChartType;
  title: string;
  xAxis?: ChartAxis;
  yAxis?: ChartAxis;
  data: PointData[] | BarData[] | PieData[] | BoxData[];
}

// ── Chart Generator ──────────────────────────────────────────────────────────

export class ChartGenerator {
  /**
   * Create a line chart.
   */
  static line(config: {
    title: string;
    data: PointData[];
    xLabel?: string;
    yLabel?: string;
  }): Chart {
    return {
      type: "line",
      title: config.title,
      xAxis: { label: config.xLabel, scale: "linear" },
      yAxis: { label: config.yLabel, scale: "linear" },
      data: config.data,
    };
  }

  /**
   * Create a bar chart.
   */
  static bar(config: { title: string; data: BarData[]; xLabel?: string; yLabel?: string }): Chart {
    return {
      type: "bar",
      title: config.title,
      xAxis: { label: config.xLabel, scale: "categorical" },
      yAxis: { label: config.yLabel, scale: "linear" },
      data: config.data,
    };
  }

  /**
   * Create a pie chart.
   */
  static pie(config: { title: string; data: PieData[] }): Chart {
    return {
      type: "pie",
      title: config.title,
      data: config.data,
    };
  }

  /**
   * Create a scatter plot.
   */
  static scatter(config: {
    title: string;
    data: PointData[];
    xLabel?: string;
    yLabel?: string;
  }): Chart {
    return {
      type: "scatter",
      title: config.title,
      xAxis: { label: config.xLabel, scale: "linear" },
      yAxis: { label: config.yLabel, scale: "linear" },
      data: config.data,
    };
  }

  /**
   * Create a box-and-whisker chart.
   */
  static box(config: { title: string; data: BoxData[] }): Chart {
    return {
      type: "box",
      title: config.title,
      data: config.data,
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /**
   * Render chart to HTML.
   */
  static toHTML(chart: Chart): string {
    switch (chart.type) {
      case "line":
      case "scatter":
        return ChartGenerator.renderPointChart(chart);
      case "bar":
        return ChartGenerator.renderBarChart(chart);
      case "pie":
        return ChartGenerator.renderPieChart(chart);
      case "box":
        return ChartGenerator.renderBoxChart(chart);
      default:
        return `<div><h3>${chart.title}</h3><p>Unsupported chart type</p></div>`;
    }
  }

  /**
   * Render chart to simple text representation.
   */
  static toText(chart: Chart): string {
    const lines: string[] = [];
    lines.push(`=== ${chart.title} ===`);

    if (chart.type === "bar" && Array.isArray(chart.data)) {
      for (const item of chart.data as BarData[]) {
        const bar = "█".repeat(Math.min(Math.round(item.value), 50));
        lines.push(`${item.label}: ${bar} ${item.value}`);
      }
    } else if (chart.type === "pie" && Array.isArray(chart.data)) {
      const total = (chart.data as PieData[]).reduce((sum, d) => sum + d.value, 0);
      for (const item of chart.data as PieData[]) {
        const pct = ((item.value / total) * 100).toFixed(1);
        lines.push(`${item.label}: ${pct}% (${item.value})`);
      }
    }

    return lines.join("\n");
  }

  // ── Private Renderers ─────────────────────────────────────────────────

  private static renderPointChart(chart: Chart): string {
    const data = chart.data as PointData[];
    const width = 600;
    const height = 400;

    const allPoints = data.flatMap((d) => d.points);
    const xMin = Math.min(...allPoints.map((p) => Number(p[0])));
    const xMax = Math.max(...allPoints.map((p) => Number(p[0])));
    const yMin = Math.min(...allPoints.map((p) => Number(p[1])));
    const yMax = Math.max(...allPoints.map((p) => Number(p[1])));

    const scaleX = (v: number) => ((v - xMin) / (xMax - xMin || 1)) * (width - 60) + 30;
    const scaleY = (v: number) => height - 30 - ((v - yMin) / (yMax - yMin || 1)) * (height - 60);

    const paths = data.map((series) => {
      const points = series.points
        .map((p) => `${scaleX(Number(p[0]))},${scaleY(Number(p[1]))}`)
        .join(" ");
      return `<polyline points="${points}" fill="none" stroke="hsl(${Math.random() * 360},70%,50%)" stroke-width="2" />`;
    });

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="${width / 2}" y="20" text-anchor="middle" font-size="14">${chart.title}</text>
  <line x1="30" y1="${height - 30}" x2="${width - 10}" y2="${height - 30}" stroke="gray" />
  <line x1="30" y1="10" x2="30" y2="${height - 30}" stroke="gray" />
  ${paths.join("\n  ")}
</svg>`;
  }

  private static renderBarChart(chart: Chart): string {
    const data = chart.data as BarData[];
    const width = 600;
    const height = 400;
    const barWidth = Math.min(40, (width - 60) / data.length - 5);
    const maxValue = Math.max(...data.map((d) => d.value));

    const bars = data.map((item, i) => {
      const x = 40 + i * (barWidth + 5);
      const barHeight = (item.value / maxValue) * (height - 80);
      const y = height - 40 - barHeight;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="hsl(${i * 60},70%,50%)" />
  <text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" font-size="10">${item.value}</text>
  <text x="${x + barWidth / 2}" y="${height - 25}" text-anchor="middle" font-size="9">${item.label}</text>`;
    });

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="${width / 2}" y="20" text-anchor="middle" font-size="14">${chart.title}</text>
  <line x1="30" y1="${height - 40}" x2="${width - 10}" y2="${height - 40}" stroke="gray" />
  ${bars.join("\n  ")}
</svg>`;
  }

  private static renderPieChart(chart: Chart): string {
    const data = chart.data as PieData[];
    const size = 300;
    const cx = size / 2;
    const cy = size / 2;
    const r = 120;
    const total = data.reduce((sum, d) => sum + d.value, 0);

    let currentAngle = -Math.PI / 2;
    const slices = data.map((item, i) => {
      const angle = (item.value / total) * 2 * Math.PI;
      const x1 = cx + r * Math.cos(currentAngle);
      const y1 = cy + r * Math.sin(currentAngle);
      const x2 = cx + r * Math.cos(currentAngle + angle);
      const y2 = cy + r * Math.sin(currentAngle + angle);
      const largeArc = angle > Math.PI ? 1 : 0;
      const path = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`;
      currentAngle += angle;
      return `<path d="${path}" fill="${item.color ?? `hsl(${i * 60},70%,50%)`}" />`;
    });

    return `<svg width="${size}" height="${size + 40}" xmlns="http://www.w3.org/2000/svg">
  <text x="${cx}" y="20" text-anchor="middle" font-size="14">${chart.title}</text>
  ${slices.join("\n  ")}
</svg>`;
  }

  private static renderBoxChart(chart: Chart): string {
    const data = chart.data as BoxData[];
    const width = Math.max(400, data.length * 80);
    const height = 300;

    const allValues = data.flatMap((d) => [d.min, d.max, ...((d as any).outliers ?? [])]);
    const vMin = Math.min(...allValues);
    const vMax = Math.max(...allValues);
    const scaleY = (v: number) => 20 + (1 - (v - vMin) / (vMax - vMin || 1)) * (height - 60);

    const boxes = data.map((item, i) => {
      const x = 40 + i * 70;
      const w = 40;
      return `<rect x="${x}" y="${scaleY(item.q3)}" width="${w}" height="${scaleY(item.q1) - scaleY(item.q3)}" fill="hsl(${i * 60},70%,50%)" opacity="0.6" />
  <line x1="${x + w / 2}" y1="${scaleY(item.max)}" x2="${x + w / 2}" y2="${scaleY(item.q3)}" stroke="black" />
  <line x1="${x + w / 2}" y1="${scaleY(item.min)}" x2="${x + w / 2}" y2="${scaleY(item.q1)}" stroke="black" />
  <line x1="${x}" y1="${scaleY(item.median)}" x2="${x + w}" y2="${scaleY(item.median)}" stroke="red" stroke-width="2" />
  <text x="${x + w / 2}" y="${height - 10}" text-anchor="middle" font-size="10">${item.label}</text>`;
    });

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="${width / 2}" y="15" text-anchor="middle" font-size="14">${chart.title}</text>
  ${boxes.join("\n  ")}
</svg>`;
  }
}

export default ChartGenerator;
