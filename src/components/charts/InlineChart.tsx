"use client";

import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import { BarChart3, ChevronDown } from "lucide-react";

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title: string;
  data: Array<{ label: string; value: number }>;
  xLabel?: string;
  yLabel?: string;
}

const PIE_COLORS = ["#059669", "#d97706", "#e11d48", "#8b5cf6", "#0891b2", "#65a30d", "#db2777"];

const TOOLTIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  fontSize: 12,
  color: "var(--card-foreground)",
} as React.CSSProperties;

interface Props {
  spec: ChartSpec;
}

/** Renders a single chart spec inline (used inside the deep-dive chat). */
export function InlineChart({ spec }: Props) {
  return (
    <div className="mt-3 border border-border rounded-xl p-3.5 bg-background anim-pop-in">
      <p className="text-xs font-medium text-muted-foreground mb-2.5">{spec.title}</p>
      <ResponsiveContainer width="100%" height={220}>
        {spec.type === "bar" ? (
          <BarChart data={spec.data}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
            <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v: any) => `₹${Number(v).toLocaleString("en-IN")}`}
              cursor={{ fill: "var(--accent)", opacity: 0.4 }}
            />
            <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        ) : spec.type === "line" ? (
          <LineChart data={spec.data}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
            <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v: any) => `₹${Number(v).toLocaleString("en-IN")}`}
            />
            <Line type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        ) : (
          <PieChart>
            <Pie
              data={spec.data}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={48}
              outerRadius={78}
              paddingAngle={2}
              label={(e: any) => `${e.label} (₹${Number(e.value).toLocaleString("en-IN")})`}
              labelLine={false}
            >
              {spec.data.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v: any) => `₹${Number(v).toLocaleString("en-IN")}`}
            />
          </PieChart>
        )}
      </ResponsiveContainer>
      {spec.xLabel && <p className="text-[11px] text-muted-foreground mt-1.5 text-center">{spec.xLabel}</p>}
    </div>
  );
}

/** Inline chart with a "Show as chart" reveal button — text first, chart on demand. */
export function InlineChartReveal({ spec }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2.5">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="press inline-flex items-center gap-1.5 text-xs font-medium text-primary bg-accent/60 border border-accent rounded-lg px-3 h-8 hover:bg-accent transition-colors"
        >
          <BarChart3 className="w-3.5 h-3.5" />
          Show as chart
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      ) : (
        <InlineChart spec={spec} />
      )}
    </div>
  );
}
