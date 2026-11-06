import React, { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';

// Sparkline renders a compact area/line chart with no axes. `points` is an
// array of { t, value } objects (oldest first). `formatValue` controls the
// tooltip text. `stroke` is a CSS color.
function Sparkline({ points, stroke = '#6366f1', height = 36, formatValue }) {
  const data = useMemo(
    () => (points || []).map((p) => ({ t: p.t, value: p.value })),
    [points],
  );

  if (!data.length) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-muted-foreground"
        style={{ height }}
      >
        no data yet
      </div>
    );
  }

  const formatter = (v) => (formatValue ? formatValue(v) : String(v));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Tooltip
          cursor={false}
          content={({ active, payload }) => {
            if (!active || !payload || !payload.length) return null;
            const p = payload[0].payload;
            return (
              <div className="rounded border bg-card px-2 py-1 text-[10px] shadow-md">
                <span className="font-mono text-muted-foreground">
                  {new Date(p.t).toLocaleString()}
                </span>
                <span className="ml-2 font-mono font-semibold">{formatter(p.value)}</span>
              </div>
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default Sparkline;
