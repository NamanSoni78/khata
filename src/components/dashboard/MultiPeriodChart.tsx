"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend,
} from "recharts";

interface Bucket {
  date?: string; hour?: string; weekLabel?: string; monthLabel?: string;
  income: number; expense: number;
}

interface Props {
  title: string;
  buckets: Bucket[];
  granularity: "hour" | "day" | "week" | "month";
}

const fmtINR = (v: number) => `₹${Number(v).toLocaleString("en-IN")}`;

const TOOLTIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  fontSize: 12,
  color: "var(--card-foreground)",
} as React.CSSProperties;

export function MultiPeriodChart({ title, buckets, granularity }: Props) {
  const labelKey = granularity === "hour" ? "hour" :
    granularity === "day" ? "date" :
    granularity === "week" ? "weekLabel" : "monthLabel";
  const data = buckets.map((b) => ({
    label: (b as any)[labelKey] ?? "",
    income: b.income,
    expense: b.expense,
  }));

  return (
    <div className="bg-card border border-border rounded-2xl" style={{ boxShadow: "var(--shadow-2)" }}>
      <div className="px-5 pt-5 pb-3">
        <h2 className="font-semibold text-sm text-foreground">{title}</h2>
      </div>
      <div className="px-5 pb-5">
        {/* Empty account: show a friendly hint instead of a bare axis frame */}
        {data.length === 0 || data.every((d) => !d.income && !d.expense) ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground text-sm">Nothing logged in this period yet.</p>
            <p className="text-muted-foreground/70 text-xs mt-1.5">
              Open the app and tell it what you spent today — charts fill in as you go.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data}>
              <defs>
                <linearGradient id="khata-income-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={1} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.55} />
                </linearGradient>
                <linearGradient id="khata-expense-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-3)" stopOpacity={1} />
                  <stop offset="100%" stopColor="var(--chart-3)" stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 6" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="var(--muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                angle={granularity === "day" ? -30 : 0}
                textAnchor={granularity === "day" ? "end" : "middle"}
                height={granularity === "day" ? 60 : 30}
              />
              <YAxis
                stroke="var(--muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `₹${v.toLocaleString("en-IN")}`}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: any) => fmtINR(Number(v))}
                cursor={{ fill: "var(--accent)", opacity: 0.4 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
              <Bar dataKey="income" name="Income" fill="url(#khata-income-grad)" radius={[6, 6, 0, 0]} maxBarSize={26} animationDuration={650} />
              <Bar dataKey="expense" name="Expense" fill="url(#khata-expense-grad)" radius={[6, 6, 0, 0]} maxBarSize={26} animationDuration={650} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
