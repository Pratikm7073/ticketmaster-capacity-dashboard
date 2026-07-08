import { useState, useMemo, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

// ══════════════════════════════════════════════════════════════════
// ERLANG C ENGINE — implements the standard queuing formula
// Iterative approach prevents factorial overflow for large agent counts
// ══════════════════════════════════════════════════════════════════
function erlangC(N, A) {
  N = Math.floor(N);
  if (A <= 0) return 0;
  if (N <= A) return 1.0;
  let term = 1.0, sumPow = 1.0;
  for (let i = 1; i <= N; i++) {
    term *= A / i;
    if (i < N) sumPow += term;
  }
  const ecNum = term * N / (N - A);
  return ecNum / (sumPow + ecNum);
}

// Service Level = P(wait ≤ t) = 1 - EC × e^(-(N-A)×t/AHT)
function calcSL(N, A, aht, tWait) {
  if (N <= A) return 0;
  return 1 - erlangC(N, A) * Math.exp(-(N - A) * tWait / aht);
}

// Traffic intensity in Erlangs: calls × AHT / interval_seconds
function trafficErlangs(calls, aht, intervalMins) {
  return (calls * aht) / (intervalMins * 60);
}

// Find minimum agents to hit SL target at given occupancy cap
function minAgents(A, aht, tWait, targetSL, maxOcc) {
  let N = Math.max(Math.ceil(A / maxOcc), Math.ceil(A) + 1);
  for (let i = 0; i < 600; i++, N++) {
    if (calcSL(N, A, aht, tWait) >= targetSL) return N;
  }
  return N;
}

// Gross up net agents for shrinkage
function grossUp(net, shrinkage) { return Math.ceil(net / (1 - shrinkage)); }

// ══════════════════════════════════════════════════════════════════
// TICKETMASTER EVENT CALENDAR — live events drive contact spikes
// ══════════════════════════════════════════════════════════════════
const EVENTS = [
  { week: 3,  name: "Taylor Swift Eras On-Sale",  type: "onsale",      mult: 6.5 },
  { week: 7,  name: "Glastonbury On-Sale",         type: "onsale",      mult: 8.3 },
  { week: 11, name: "Coldplay Stadium On-Sale",    type: "onsale",      mult: 4.8 },
  { week: 15, name: "Spring Bank Holiday",         type: "seasonal",    mult: 1.7 },
  { week: 19, name: "Reading & Leeds On-Sale",     type: "onsale",      mult: 3.5 },
  { week: 22, name: "Glastonbury Festival",        type: "event",       mult: 2.8 },
  { week: 26, name: "Festival Season Peak",        type: "seasonal",    mult: 2.0 },
  { week: 28, name: "Major Venue Cancellation",   type: "cancellation", mult: 9.4 },
  { week: 33, name: "Ed Sheeran On-Sale",         type: "onsale",      mult: 5.2 },
  { week: 38, name: "Christmas Shows On-Sale",    type: "onsale",      mult: 4.1 },
  { week: 44, name: "New Year Tours Announce",    type: "onsale",      mult: 3.7 },
  { week: 48, name: "Boxing Day Rush",            type: "seasonal",    mult: 2.1 },
];

const TYPE_COLORS = {
  onsale: "#FF5F00", cancellation: "#E53E3E",
  seasonal: "#FFB200", event: "#00B67A",
};

// Channel configuration — each uses a different capacity model
const CHANNELS = {
  voice: { label: "Voice", color: "#026CDF", split: 0.44, aht: 480, slTarget: 0.80, slSec: 20,  maxOcc: 0.85 },
  chat:  { label: "Chat",  color: "#FF5F00", split: 0.37, aht: 660, slTarget: 0.80, slSec: 30,  maxOcc: 0.88, concurrency: 2.5 },
  email: { label: "Email", color: "#9B59B6", split: 0.19, aht: 900, slTarget: 0.90, slSec: 86400, dailyCap: 38 },
};

// Day-of-week shrinkage (Mon/Fri run 8-12 pts above mid-week — Expedia insight)
const DOW_SHRINKAGE = { Mon: 0.235, Tue: 0.175, Wed: 0.165, Thu: 0.170, Fri: 0.215 };
const AVG_SHRINKAGE = Object.values(DOW_SHRINKAGE).reduce((a, b) => a + b, 0) / 5; // ~0.192

const BASE_WEEKLY_VOL = 3200;

// ══════════════════════════════════════════════════════════════════
// SYNTHETIC DATA — deterministic seeded noise (no Math.random)
// ══════════════════════════════════════════════════════════════════
function seeded(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildAnnualData(eventScale = 1.0) {
  return Array.from({ length: 52 }, (_, i) => {
    const w = i + 1;
    const ev = EVENTS.find(e => e.week === w);
    const seasonal = 1 + 0.18 * Math.sin(((w - 10) / 52) * 2 * Math.PI);
    const noise = 0.93 + seeded(w) * 0.14;
    const mult = ev ? 1 + (ev.mult - 1) * eventScale : 1;
    const totalVol = Math.round(BASE_WEEKLY_VOL * seasonal * noise * mult);

    const voice = Math.round(totalVol * CHANNELS.voice.split);
    const chat  = Math.round(totalVol * CHANNELS.chat.split);
    const email = Math.round(totalVol * CHANNELS.email.split);

    // Peak 30-min interval ≈ 12.5% of daily volume (Poisson assumption)
    const wdays = 5;
    const peakV = Math.round(voice / wdays * 0.125);
    const peakC = Math.round(chat / wdays * 0.125);
    const shrink = ev ? AVG_SHRINKAGE + 0.025 : AVG_SHRINKAGE;

    // Voice: Erlang C model
    const A_v = trafficErlangs(peakV, CHANNELS.voice.aht, 30);
    const netV = minAgents(A_v, CHANNELS.voice.aht, CHANNELS.voice.slSec, CHANNELS.voice.slTarget, CHANNELS.voice.maxOcc);
    const grV  = grossUp(netV, shrink);

    // Chat: concurrent seat model (seats = workload / concurrency / occupancy)
    const workC = (peakC * CHANNELS.chat.aht) / (30 * 60);
    const netC  = Math.ceil(workC / CHANNELS.chat.concurrency / CHANNELS.chat.maxOcc);
    const grC   = grossUp(netC, shrink);

    // Email: pure productivity model (N emails/agent/day)
    const netE = Math.ceil(email / wdays / CHANNELS.email.dailyCap);
    const grE  = grossUp(netE, shrink);

    const required = grV + grC + grE;
    const staffed  = Math.round(required * (0.88 + seeded(w + 100) * 0.18));
    const sl = Math.round(calcSL(Math.round(staffed * CHANNELS.voice.split / (1 - shrink)), A_v, CHANNELS.voice.aht, CHANNELS.voice.slSec) * 100);

    return {
      week: w, label: `W${String(w).padStart(2, "0")}`,
      totalVol, voice, chat, email,
      erlang: Math.round(A_v * 10) / 10,
      required, staffed,
      gap: required - staffed,
      util: Math.round((required / staffed) * 100),
      shrink: Math.round(shrink * 100),
      sl: Math.max(0, Math.min(100, sl)),
      evName: ev?.name ?? null, evType: ev?.type ?? null,
    };
  });
}

// ══════════════════════════════════════════════════════════════════
// THEME
// ══════════════════════════════════════════════════════════════════
const T = {
  navy:   "#0A1628", dark:   "#131F35", card:   "#1A2B45",
  border: "#243348", blue:   "#026CDF", orange: "#FF5F00",
  green:  "#00B67A", amber:  "#FFB200", red:    "#E53E3E",
  purple: "#9B59B6", muted:  "#6B7A99", soft:   "#9BA8C0",
};

// ══════════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ══════════════════════════════════════════════════════════════════
function Kpi({ label, value, sub, color = T.blue, icon }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function TypeBadge({ type }) {
  if (!type) return null;
  const c = TYPE_COLORS[type] ?? T.green;
  return (
    <span style={{ background: `${c}22`, border: `1px solid ${c}`, color: c, borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "2px 6px" }}>
      {type.toUpperCase()}
    </span>
  );
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: T.dark, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
      <div style={{ fontWeight: 700, color: "white", marginBottom: 5 }}>
        {label} {d?.evType && <TypeBadge type={d.evType} />}
      </div>
      {d?.evName && <div style={{ color: T.orange, fontSize: 12, marginBottom: 4 }}>⚡ {d.evName}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color ?? "white", marginTop: 2 }}>
          {p.name}: <strong>{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</strong>
        </div>
      ))}
      {d?.shrink && <div style={{ color: T.muted, marginTop: 4, fontSize: 12 }}>Shrinkage: {d.shrink}%</div>}
    </div>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, unit = "", color = T.blue }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: T.soft }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: color }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TAB 1 — DASHBOARD
// ══════════════════════════════════════════════════════════════════
function Dashboard({ data }) {
  const totalVol   = data.reduce((s, w) => s + w.totalVol, 0);
  const critWeeks  = data.filter(w => w.gap > 10).length;
  const avgSL      = Math.round(data.reduce((s, w) => s + w.sl, 0) / data.length);
  const avgUtil    = Math.round(data.reduce((s, w) => s + w.util, 0) / data.length);
  const baseVol    = Math.round(data.filter(w => !w.evType).reduce((s, w) => s + w.totalVol, 0) / data.filter(w => !w.evType).length);
  const peakVol    = Math.max(...data.map(w => w.totalVol));
  const spikeRatio = Math.round((peakVol / baseVol) * 10) / 10;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Kpi icon="📞" label="Annual Volume"   value={Math.round(totalVol / 1000) + "K"} sub="All channels · 52 weeks"          color={T.blue}                              />
        <Kpi icon="⚡" label="Peak Spike"      value={spikeRatio + "×"}                  sub="Max event vs baseline"              color={T.orange}                            />
        <Kpi icon="🎯" label="Avg Voice SL"    value={avgSL + "%"}                       sub="Target: 80% in 20s"                 color={avgSL >= 78 ? T.green : T.red}      />
        <Kpi icon="⚠️" label="Critical Weeks"  value={critWeeks}                         sub="Understaffed >10 FTE"               color={critWeeks > 5 ? T.red : T.amber}    />
        <Kpi icon="📊" label="Avg Utilisation" value={avgUtil + "%"}                     sub="Required ÷ Staffed"                 color={avgUtil > 105 ? T.red : T.green}    />
      </div>

      {/* Volume + capacity area chart */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, color: "white", marginBottom: 2 }}>52-Week Contact Volume & Capacity Requirement</div>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 14 }}>Event-driven demand spikes vs staffed capacity — all channels</div>
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} interval={3} />
            <YAxis tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTip />} />
            <Legend wrapperStyle={{ fontSize: 12, color: T.soft }} />
            <Area type="monotone" dataKey="totalVol" fill={`${T.blue}28`} stroke={T.blue} strokeWidth={1.5} name="Contact Volume" dot={false} />
            <Line type="monotone" dataKey="required" stroke={T.orange} strokeWidth={2} dot={false} name="Required FTE" />
            <Line type="monotone" dataKey="staffed"  stroke={T.green}  strokeWidth={2} dot={false} name="Staffed FTE" strokeDasharray="5 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Gap chart */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontWeight: 700, color: "white", marginBottom: 2 }}>Capacity Gap (FTE)</div>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>+ understaffed · − overstaffed</div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={data} margin={{ top: 0, right: 10, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: T.muted, fontSize: 9 }} tickLine={false} interval={3} />
              <YAxis tick={{ fill: T.muted, fontSize: 9 }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTip />} />
              <ReferenceLine y={0} stroke="#4A5568" strokeWidth={1.5} />
              <Bar dataKey="gap" name="Capacity Gap" radius={[2, 2, 0, 0]}>
                {data.map((d, i) => <Cell key={i} fill={d.gap > 0 ? T.red : T.green} opacity={d.evType ? 1 : 0.65} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Channel mix */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px" }}>
          <div style={{ fontWeight: 700, color: "white", marginBottom: 2 }}>Channel Volume Mix</div>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Voice · Chat · Email stacked</div>
          <ResponsiveContainer width="100%" height={170}>
            <AreaChart data={data} margin={{ top: 0, right: 10, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: T.muted, fontSize: 9 }} tickLine={false} interval={3} />
              <YAxis tick={{ fill: T.muted, fontSize: 9 }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: T.soft }} />
              <Area type="monotone" dataKey="voice" stackId="1" stroke={T.blue}   fill={`${T.blue}AA`}   name="Voice" />
              <Area type="monotone" dataKey="chat"  stackId="1" stroke={T.orange} fill={`${T.orange}AA`} name="Chat" />
              <Area type="monotone" dataKey="email" stackId="1" stroke={T.purple} fill={`${T.purple}AA`} name="Email" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TAB 2 — ERLANG C ENGINE
// ══════════════════════════════════════════════════════════════════
function ErlangEngine() {
  const [vol,      setVol]      = useState(150);
  const [aht,      setAht]      = useState(480);
  const [tgtSL,    setTgtSL]    = useState(80);
  const [tgtWait,  setTgtWait]  = useState(20);
  const [maxOcc,   setMaxOcc]   = useState(85);
  const [shrinkPct,setShrinkPct]= useState(18);

  const result = useMemo(() => {
    const A = trafficErlangs(vol, aht, 30);
    const net = minAgents(A, aht, tgtWait, tgtSL / 100, maxOcc / 100);
    const gross = grossUp(net, shrinkPct / 100);
    const occ = Math.round((A / net) * 100);
    const actualSL = Math.round(calcSL(net, A, aht, tgtWait) * 100);

    // SL curve: agents from (A-3) to (A+20)
    const curve = [];
    for (let n = Math.max(1, Math.ceil(A) - 3); n <= Math.ceil(A) + 22; n++) {
      curve.push({
        n,
        sl:  Math.max(0, Math.round(calcSL(n, A, aht, tgtWait) * 100)),
        occ: Math.round((A / n) * 100),
      });
    }
    return { A: Math.round(A * 100) / 100, net, gross, occ, actualSL, curve };
  }, [vol, aht, tgtSL, tgtWait, maxOcc, shrinkPct]);

  const box = (label, value, sub, color) => (
    <div style={{ background: T.dark, borderRadius: 8, padding: "12px 16px" }}>
      <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{sub}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        {/* Inputs */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "18px 20px" }}>
          <div style={{ fontWeight: 700, color: "white", marginBottom: 3 }}>Erlang C Parameters</div>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 18 }}>Adjust — output updates in real time</div>
          <Slider label="Volume (calls / 30-min interval)" value={vol}       onChange={setVol}      min={10}  max={600} color={T.blue}   />
          <Slider label="Average Handle Time (seconds)"    value={aht}       onChange={setAht}      min={60}  max={900} step={10} color={T.orange} />
          <Slider label="Service Level Target (%)"         value={tgtSL}     onChange={setTgtSL}    min={50}  max={95}  unit="%" color={T.green}  />
          <Slider label="Target Answer Time (seconds)"     value={tgtWait}   onChange={setTgtWait}  min={10}  max={120} color={T.green}  />
          <Slider label="Max Occupancy Cap (%)"            value={maxOcc}    onChange={setMaxOcc}   min={60}  max={95}  unit="%" color={T.amber}  />
          <Slider label="Shrinkage Rate (%)"               value={shrinkPct} onChange={setShrinkPct}min={5}   max={45}  unit="%" color={T.purple} />
        </div>

        {/* Outputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ fontWeight: 700, color: "white", marginBottom: 14 }}>Capacity Output</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {box("Traffic (Erlangs)", result.A,       "V × AHT ÷ 1800",             T.blue)}
              {box("Net Agents",        result.net,      `Erlang C @ ${tgtSL}% SL`,   T.orange)}
              {box("Gross FTE",         result.gross,    `÷ (1 − ${shrinkPct}%)`,      T.purple)}
              {box("Occupancy",         result.occ + "%",`Cap: ${maxOcc}%`,            result.occ > maxOcc ? T.red : T.green)}
            </div>
          </div>

          {/* SL Curve */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", flex: 1 }}>
            <div style={{ fontWeight: 700, color: "white", marginBottom: 2 }}>Erlang C Service Level Curve</div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>SL vs agents at current volume · AHT</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={result.curve} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="n" tick={{ fill: T.muted, fontSize: 10 }} label={{ value: "Agents", position: "insideBottom", fill: T.muted, fontSize: 10, dy: 10 }} />
                <YAxis tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} axisLine={false} domain={[0, 100]} />
                <Tooltip formatter={(v, n) => [v + "%", n]} labelFormatter={l => `${l} agents`} contentStyle={{ background: T.dark, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12 }} />
                <ReferenceLine y={tgtSL} stroke={T.amber} strokeDasharray="4 4" label={{ value: `${tgtSL}% target`, fill: T.amber, fontSize: 10 }} />
                <Line type="monotone" dataKey="sl"  stroke={T.blue}   strokeWidth={2.5} dot={false} name="Service Level %" />
                <Line type="monotone" dataKey="occ" stroke={T.orange} strokeWidth={1.5} dot={false} name="Occupancy %"     strokeDasharray="4 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Shrinkage decomposition */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px" }}>
        <div style={{ fontWeight: 700, color: "white", marginBottom: 2 }}>Day-of-Week Shrinkage Decomposition</div>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 14 }}>Mon & Fri run +6–7 pts above mid-week — blended avg understates capacity on those days</div>
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={[
            { day: "Mon", planned: 10, unplanned: 13.5 },
            { day: "Tue", planned: 10, unplanned:  7.5 },
            { day: "Wed", planned: 10, unplanned:  6.5 },
            { day: "Thu", planned: 10, unplanned:  7.0 },
            { day: "Fri", planned: 10, unplanned: 11.5 },
          ]} margin={{ top: 5, right: 20, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
            <XAxis dataKey="day" tick={{ fill: T.soft, fontSize: 13 }} tickLine={false} />
            <YAxis tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} axisLine={false} unit="%" />
            <Tooltip formatter={(v, n) => [v + "%", n]} contentStyle={{ background: T.dark, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12, color: T.soft }} />
            <Bar dataKey="planned"   stackId="a" fill={`${T.blue}CC`}   name="Planned"   radius={[0, 0, 0, 0]} />
            <Bar dataKey="unplanned" stackId="a" fill={`${T.orange}CC`} name="Unplanned" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TAB 3 — EVENT SCENARIOS
// ══════════════════════════════════════════════════════════════════
function Scenarios() {
  const [selEv,    setSelEv]    = useState(EVENTS[1]);
  const [scale,    setScale]    = useState(1.0);
  const [extraShr, setExtraShr] = useState(5);

  const baseInterval = 120; // baseline voice calls per 30-min interval
  const A_base = trafficErlangs(baseInterval, 480, 30);
  const net_base = minAgents(A_base, 480, 20, 0.80, 0.85);
  const gross_base = grossUp(net_base, AVG_SHRINKAGE);

  const evVol  = Math.round(baseInterval * selEv.mult * scale);
  const evShr  = AVG_SHRINKAGE + extraShr / 100;
  const A_ev   = trafficErlangs(evVol, 480, 30);
  const net_ev = minAgents(A_ev, 480, 20, 0.80, 0.85);
  const gr_ev  = grossUp(net_ev, evShr);
  const slAtBase = Math.max(0, Math.round(calcSL(net_base, A_ev, 480, 20) * 100));
  const extraFTE = gr_ev - gross_base;

  // Timeline: week before → event day → week after
  const timeline = [
    { p: "Wk −2",    req: gross_base + 3, stf: gross_base + 2 },
    { p: "Wk −1",    req: gross_base + 5, stf: gross_base + 2 },
    { p: "Event Day",req: gr_ev,           stf: gross_base     },
    { p: "Day +1",   req: Math.round(gr_ev * 0.45), stf: gross_base },
    { p: "Wk +1",    req: gross_base + 4, stf: gross_base + 3 },
    { p: "Wk +2",    req: gross_base,     stf: gross_base + 1 },
  ];

  return (
    <div>
      {/* Event picker */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, color: "white", marginBottom: 12 }}>⚡ Live Event Scenario Simulator</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
          {EVENTS.map(ev => {
            const active = selEv.week === ev.week;
            const c = TYPE_COLORS[ev.type] ?? T.green;
            return (
              <button key={ev.week} onClick={() => setSelEv(ev)}
                style={{ padding: "5px 11px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${active ? c : T.border}`,
                  background: active ? `${c}30` : T.dark, color: active ? c : T.soft }}>
                {ev.name}
              </button>
            );
          })}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <Slider label="Event intensity scale" value={Math.round(scale * 10) / 10} onChange={setScale} min={0.3} max={1.5} step={0.1} color={T.orange}
            unit={` (${Math.round(selEv.mult * scale * 10) / 10}×)`} />
          <Slider label="Additional shrinkage on event day" value={extraShr} onChange={setExtraShr} min={0} max={15} color={T.amber} unit="%" />
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <Kpi icon="📅" label="Baseline FTE"      value={gross_base}               sub="Normal day"                        color={T.green}                          />
        <Kpi icon="⚡" label="Event Day FTE"      value={gr_ev}                    sub={`${Math.round(evShr * 100)}% shrinkage`} color={T.orange}                   />
        <Kpi icon="👥" label="Surge Gap"          value={"+" + extraFTE}           sub="Extra FTE needed"                  color={extraFTE > 30 ? T.red : T.amber}  />
        <Kpi icon="🎯" label="SL at Base Staff"   value={slAtBase + "%"}           sub="Voice peak interval"               color={slAtBase < 40 ? T.red : T.amber}  />
        <Kpi icon="📡" label="Peak Erlangs"       value={Math.round(A_ev * 10) / 10} sub="Traffic intensity"              color={T.blue}                           />
      </div>

      {/* Timeline */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px" }}>
        <div style={{ fontWeight: 700, color: "white", marginBottom: 2 }}>Event Impact Timeline — Required vs Staffed FTE</div>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 14 }}>Red zone = capacity shortfall if no contingency — use for pre-event planning</div>
        <ResponsiveContainer width="100%" height={210}>
          <ComposedChart data={timeline} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
            <XAxis dataKey="p" tick={{ fill: T.soft, fontSize: 12 }} tickLine={false} />
            <YAxis tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ background: T.dark, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12, color: "white" }} />
            <Legend wrapperStyle={{ fontSize: 12, color: T.soft }} />
            <Bar dataKey="req" name="FTE Required" fill={T.red} opacity={0.8} radius={[3, 3, 0, 0]} />
            <Line type="monotone" dataKey="stf" name="Staffed FTE" stroke={T.green} strokeWidth={2.5} dot={{ fill: T.green, r: 5 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TAB 4 — WEEKLY INSIGHTS TABLE
// ══════════════════════════════════════════════════════════════════
function Insights({ data }) {
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("week");

  const shown = useMemo(() => {
    let d = [...data];
    if (filter === "events")   d = d.filter(w => w.evType);
    if (filter === "onsale")   d = d.filter(w => w.evType === "onsale");
    if (filter === "critical") d = d.filter(w => w.gap > 5);
    if (sortBy === "gap")    d.sort((a, b) => b.gap - a.gap);
    if (sortBy === "volume") d.sort((a, b) => b.totalVol - a.totalVol);
    return d;
  }, [data, filter, sortBy]);

  const filters = [["all","All 52 Weeks"],["events","Event Weeks"],["onsale","On-Sale Days"],["critical","Critical Gaps"]];
  const sorts   = [["week","Week"],["gap","Gap"],["volume","Volume"]];

  const btn = (id, label, active, onClick, ac = T.blue) => (
    <button onClick={onClick} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
      border: `1px solid ${active ? ac : T.border}`, background: active ? `${ac}22` : T.dark,
      color: active ? ac : T.soft }}>
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {filters.map(([id, label]) => btn(id, label, filter === id, () => setFilter(id)))}
        <span style={{ marginLeft: "auto", fontSize: 12, color: T.muted }}>Sort:</span>
        {sorts.map(([id, label]) => btn(id, label, sortBy === id, () => setSortBy(id), T.soft))}
      </div>

      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.dark, borderBottom: `1px solid ${T.border}` }}>
                {["Wk", "Event", "Volume", "Erlang", "Required", "Staffed", "Gap", "SL%", "Shrink%"].map(h => (
                  <th key={h} style={{ padding: "9px 12px", textAlign: "left", color: T.muted, fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.4px" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((w, i) => (
                <tr key={w.week} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? "transparent" : `${T.dark}55` }}>
                  <td style={{ padding: "8px 12px", color: T.soft, fontWeight: 600 }}>{w.label}</td>
                  <td style={{ padding: "8px 12px" }}>
                    {w.evName
                      ? <div><TypeBadge type={w.evType} /><div style={{ fontSize: 11, color: T.soft, marginTop: 2 }}>{w.evName}</div></div>
                      : <span style={{ color: "#3A4B6A" }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 12px", color: w.evType ? T.orange : T.soft, fontWeight: w.evType ? 700 : 400 }}>{w.totalVol.toLocaleString()}</td>
                  <td style={{ padding: "8px 12px", color: T.soft }}>{w.erlang}</td>
                  <td style={{ padding: "8px 12px", color: "white", fontWeight: 600 }}>{w.required}</td>
                  <td style={{ padding: "8px 12px", color: T.soft }}>{w.staffed}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{ color: w.gap > 10 ? T.red : w.gap > 0 ? T.amber : T.green, fontWeight: 700 }}>
                      {w.gap > 0 ? "+" : ""}{w.gap}
                    </span>
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{ color: w.sl >= 80 ? T.green : w.sl >= 60 ? T.amber : T.red, fontWeight: 600 }}>{w.sl}%</span>
                  </td>
                  <td style={{ padding: "8px 12px", color: w.shrink > 22 ? T.amber : T.soft }}>{w.shrink}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════════════════════
const TABS = [
  { id: "dashboard", label: "📊 Dashboard",      sub: "52-Week Overview"  },
  { id: "erlang",    label: "⚙️ Erlang C Engine", sub: "Live Calculator"   },
  { id: "scenarios", label: "⚡ Event Scenarios",  sub: "Impact Simulator"  },
  { id: "insights",  label: "📋 Weekly Insights",  sub: "Sortable Table"    },
];

export default function App() {
  const [tab,  setTab]  = useState("dashboard");
  const data = useMemo(() => buildAnnualData(1.0), []);

  return (
    <div style={{ background: T.navy, minHeight: "100vh", color: "white", fontFamily: "-apple-system, 'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ background: T.dark, borderBottom: `1px solid ${T.border}`, padding: "16px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ background: T.blue, borderRadius: 8, padding: "8px 12px", fontSize: 20 }}>🎫</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.3px", lineHeight: 1.2 }}>
              Live Events Contact Centre&nbsp;
              <span style={{ color: T.blue }}>Capacity Intelligence</span>
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
              Ticketmaster UK · Multi-Channel · Event-Driven Demand · Erlang C Engine · Python ML Forecast
            </div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: 11, color: T.muted }}>Built by Pratik More</div>
            <div style={{ fontSize: 11, color: T.blue }}>github.com/Pratikm7073</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ padding: "7px 14px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer",
                border: `1px solid ${tab === t.id ? T.blue : T.border}`,
                background: tab === t.id ? T.blue : "transparent", color: tab === t.id ? "white" : T.soft }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: "20px 24px", maxWidth: 1100, margin: "0 auto" }}>
        {tab === "dashboard" && <Dashboard data={data} />}
        {tab === "erlang"    && <ErlangEngine />}
        {tab === "scenarios" && <Scenarios />}
        {tab === "insights"  && <Insights data={data} />}
      </div>
    </div>
  );
}
