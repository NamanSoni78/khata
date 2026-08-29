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
    <div className="bg-card border border-border rounded-2xl">
      <div className="px-5 pt-5 pb-3">
        <h2 className="font-semibold text-sm text-foreground">{title}</h2>
      </div>
      <div className="px-5 pb-5">
        {data.length === 0 ? (
          <p className="text-muted-foreground text-sm py-10 text-center">No transactions in this range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
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
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="income" name="Income" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Bar dataKey="expense" name="Expense" fill="var(--chart-3)" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
