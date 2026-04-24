"use client";

import { useId, useMemo } from "react";

export interface SparklineProps {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}

interface SparkPath {
  stroke: string;
  fill: string;
  last: { x: number; y: number };
}

function buildPath(points: number[], w: number, h: number): SparkPath {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const xy = points.map((p, i) => ({
    x: i * step,
    y: h - ((p - min) / span) * (h - 4) - 2,
  }));

  let stroke = `M ${xy[0].x.toFixed(1)} ${xy[0].y.toFixed(1)}`;
  for (let i = 1; i < xy.length; i++) {
    const prev = xy[i - 1];
    const curr = xy[i];
    const cx = (prev.x + curr.x) / 2;
    stroke += ` C ${cx.toFixed(1)} ${prev.y.toFixed(1)}, ${cx.toFixed(1)} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
  }
  const fill = `${stroke} L ${w} ${h} L 0 ${h} Z`;

  return { stroke, fill, last: xy[xy.length - 1] };
}

export function Sparkline({
  points,
  color = "var(--avy-accent)",
  width = 88,
  height = 26,
  className,
}: SparklineProps) {
  const gradientId = useId();
  const { stroke, fill, last } = useMemo(
    () => buildPath(points, width, height),
    [points, width, height]
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={className}
      style={{ width, height, overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={color} fillOpacity={0.1} />
      <path
        d={stroke}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r={2} fill={color} />
    </svg>
  );
}
