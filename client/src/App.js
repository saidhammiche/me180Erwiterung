// App_20sensors.jsx — adapté pour cascade Messkoffer + mapping CH→SensorN
import React, { useEffect, useState, useCallback, useRef, memo, useMemo } from "react";
import axios from "axios";
import {
  Paper, Typography, Box, Button, Divider,
  MenuItem, Checkbox, ListItemText, TextField, Alert,
  useMediaQuery, Drawer, Badge, Popover, FormControlLabel, Menu,
  InputAdornment, Chip, Tooltip, ToggleButton, ToggleButtonGroup
} from "@mui/material";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import DashboardIcon from "@mui/icons-material/Dashboard";
import ElectricBoltIcon from "@mui/icons-material/ElectricBolt";
import FunctionsIcon from "@mui/icons-material/Functions";
import SpeedIcon from "@mui/icons-material/Speed";
import FlashOnIcon from "@mui/icons-material/FlashOn";
import TimelineIcon from "@mui/icons-material/Timeline";
import BatteryChargingFullIcon from "@mui/icons-material/BatteryChargingFull";
import DeviceHubIcon from "@mui/icons-material/DeviceHub";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import VoltageSvgIcon from "@mui/icons-material/FlashOn";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ElectricalServicesIcon from "@mui/icons-material/ElectricalServices";
import SaveIcon from "@mui/icons-material/Save";
import FilterListIcon from "@mui/icons-material/FilterList";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import UpdateIcon from "@mui/icons-material/Update";
import SearchIcon from "@mui/icons-material/Search";
import TuneIcon from "@mui/icons-material/Tune";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import BoltIcon from "@mui/icons-material/Bolt";
import SettingsInputComponentIcon from "@mui/icons-material/SettingsInputComponent";
import EditNoteIcon from "@mui/icons-material/EditNote";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SendIcon from "@mui/icons-material/Send";
import RefreshIcon from "@mui/icons-material/Refresh";
import LabelImportantOutlinedIcon from "@mui/icons-material/LabelImportantOutlined";
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, Legend, CartesianGrid, ResponsiveContainer
} from "recharts";

const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:4000`;
const STARTSEITE_URL = "http://192.168.1.20:8080";
const PRIMARY_COLOR = "#7cbbcd";

const formatChannelName  = (ch) => ch;
const formatChannelShort = (ch) => ch;

// ── Design-Tokens (Enterprise / Industrie) ────────────────────────────────
// Angelehnt an die reale DIN/IEC-Aderfarbe der drei Phasenleiter (L1 braun,
// L2 schwarz, L3 grau) — so bleibt die Farbcodierung fachlich korrekt und
// sofort wiedererkennbar für Elektrofachpersonal, statt generischer Bunttöne.
const INK        = "#111827";
const INK_MUTED  = "#667085";
const SURFACE    = "#F3F5F7";
const PANEL      = "#FFFFFF";
const BORDER     = "#E3E6EB";
const SUCCESS    = "#1E8A5D";
const SUCCESS_BG = "#E7F5EE";
const WARNING    = "#B7791F";
const WARNING_BG = "#FBF1DE";
const DANGER     = "#C0392B";
const DANGER_BG  = "#FBEAE8";
const MONO_FONT    = '"IBM Plex Mono","JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const DISPLAY_FONT = '"IBM Plex Sans","Inter","Segoe UI", sans-serif';

const PHASE_STYLES = [
  { tag: "L1", color: "#7A5230", bg: "#F7EFE6", name: "Phase 1" },
  { tag: "L2", color: "#22262B", bg: "#ECEDEF", name: "Phase 2" },
  { tag: "L3", color: "#525C68", bg: "#EEF1F3", name: "Phase 3" },
];

// ✅ CORRECTION : "Energie_temp" → "Energie" pour correspondre au champ réel
// renvoyé par /history/:channel (measurement "mego"), sinon dataKey="Energie_temp"
// de <Line> dans GraphDetail ne trouve jamais la valeur et le graphique reste vide
// ("Keine historische Daten" alors que la valeur existe bien dans InfluxDB).
const METRIC_LABELS = {
  Strom:        "Strom (A)",
  Wirkleistung: "Wirkleistung (W)",
  Spannung:     "Spannung (V)",
  CosinusPhi:   "Cosinus Phi",
  Energie:      "Energie (kWh)",
};

const METRIC_OPTIONS = [
  { value: "Strom",         label: "Strom (A)",          icon: ElectricBoltIcon,       decimals: 3, unit: "A"   },
  { value: "CosinusPhi",    label: "Cosinus Phi",         icon: FunctionsIcon,          decimals: 4, unit: ""    },
  { value: "Wirkleistung",  label: "Wirkleistung (W)",    icon: SpeedIcon,              decimals: 2, unit: "W"   },
  { value: "Blindleistung", label: "Blindleistung (var)", icon: FlashOnIcon,            decimals: 2, unit: "var" },
  { value: "Scheinleistung",label: "Scheinleistung (VA)", icon: TimelineIcon,           decimals: 2, unit: "VA"  },
  { value: "Energie_temp",  label: "Energie (kWh)",       icon: BatteryChargingFullIcon,decimals: 2, unit: "kWh" },
];

const TIME_RANGE_OPTIONS = [
  { value: "5m",  label: "letzte 5 Min"      },
  { value: "10m", label: "letzte 10 Min"     },
  { value: "15m", label: "letzte 15 Min"     },
  { value: "1h",  label: "letzte 1 Stunde"   },
  { value: "2h",  label: "letzte 2 Stunden"  },
  { value: "6h",  label: "letzte 6 Stunden"  },
  { value: "24h", label: "letzte 24 Stunden" },
];

const formatValue = (value, decimals = 3, unit = "") => {
  if (value === undefined || value === null) return "—";
  const num = parseFloat(value);
  if (isNaN(num)) return "—";
  return `${num.toFixed(decimals)}${unit ? " " + unit : ""}`;
};

const formatRelativeTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
  if (diffSec < 5) return "gerade eben";
  if (diffSec < 60) return `vor ${diffSec} s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `vor ${diffMin} Min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `vor ${diffH} Std`;
  const diffD = Math.round(diffH / 24);
  return `vor ${diffD} T`;
};

// ─── FILTER BAR ───────────────────────────────────────────────────────────────
const FilterBar = memo(({
  selectedChannels, selectedMetrics,
  onChannelChange, onSelectAllChannels,
  onMetricChange, onSelectAllMetrics,
  onResetFilters, hasActiveFilters,
  orderedChannels, metricOptions,
  mobileDrawer = false,
}) => {
  const isMobile = useMediaQuery("(max-width:600px)");
  const [drawerOpen, setDrawerOpen]           = useState(false);
  const [channelAnchorEl, setChannelAnchorEl] = useState(null);
  const [metricAnchorEl, setMetricAnchorEl]   = useState(null);

  const handleChannelToggle = (ch) => {
    const next = selectedChannels.includes(ch)
      ? selectedChannels.filter(c => c !== ch)
      : [...selectedChannels, ch];
    onChannelChange({ target: { value: next } });
  };

  const handleMetricToggle = (val) => {
    const next = selectedMetrics.includes(val)
      ? selectedMetrics.filter(m => m !== val)
      : [...selectedMetrics, val];
    onMetricChange({ target: { value: next } });
  };

  const selChCount = selectedChannels.length;
  const totChCount = orderedChannels.length;
  const selMtCount = selectedMetrics.length;
  const totMtCount = metricOptions.length;

  const channelPopover = (
    <Popover open={Boolean(channelAnchorEl)} anchorEl={channelAnchorEl}
      onClose={() => setChannelAnchorEl(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      disableAutoFocus disableEnforceFocus keepMounted>
      <Box sx={{ p: 2, minWidth: 250, maxWidth: 350 }}>
        <FormControlLabel
          control={<Checkbox checked={selChCount === totChCount} indeterminate={selChCount > 0 && selChCount < totChCount} onChange={onSelectAllChannels} />}
          label="Alle Kanäle" />
        <Divider sx={{ my: 1 }} />
        <Box sx={{ maxHeight: 300, overflow: "auto" }}>
          {orderedChannels.map(ch => (
            <FormControlLabel key={ch}
              control={<Checkbox checked={selectedChannels.includes(ch)} onChange={() => handleChannelToggle(ch)} />}
              label={formatChannelShort(ch)} sx={{ display: "block" }} />
          ))}
        </Box>
      </Box>
    </Popover>
  );

  const metricPopover = (
    <Popover open={Boolean(metricAnchorEl)} anchorEl={metricAnchorEl}
      onClose={() => setMetricAnchorEl(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      disableAutoFocus disableEnforceFocus keepMounted>
      <Box sx={{ p: 2, minWidth: 250, maxWidth: 350 }}>
        <FormControlLabel
          control={<Checkbox checked={selMtCount === totMtCount} indeterminate={selMtCount > 0 && selMtCount < totMtCount} onChange={onSelectAllMetrics} />}
          label="Alle Messgrößen" />
        <Divider sx={{ my: 1 }} />
        <Box sx={{ maxHeight: 300, overflow: "auto" }}>
          {metricOptions.map(m => (
            <FormControlLabel key={m.value}
              control={<Checkbox checked={selectedMetrics.includes(m.value)} onChange={() => handleMetricToggle(m.value)} />}
              label={m.label} sx={{ display: "block" }} />
          ))}
        </Box>
      </Box>
    </Popover>
  );

  const drawerContent = (
    <Box sx={{ p: 2, width: 280 }}>
      <Typography variant="h6" gutterBottom>Filter</Typography>
      <Typography variant="subtitle2" gutterBottom>Kanäle</Typography>
      <Box sx={{ mb: 2, maxHeight: 200, overflow: "auto" }}>
        <FormControlLabel
          control={<Checkbox checked={selChCount === totChCount} indeterminate={selChCount > 0 && selChCount < totChCount} onChange={onSelectAllChannels} />}
          label="Alle Kanäle" />
        {orderedChannels.map(ch => (
          <FormControlLabel key={ch}
            control={<Checkbox checked={selectedChannels.includes(ch)} onChange={() => handleChannelToggle(ch)} />}
            label={formatChannelShort(ch)} />
        ))}
      </Box>
      <Typography variant="subtitle2" gutterBottom>Messgrößen</Typography>
      <Box sx={{ mb: 2, maxHeight: 200, overflow: "auto" }}>
        <FormControlLabel
          control={<Checkbox checked={selMtCount === totMtCount} indeterminate={selMtCount > 0 && selMtCount < totMtCount} onChange={onSelectAllMetrics} />}
          label="Alle Messgrößen" />
        {metricOptions.map(m => (
          <FormControlLabel key={m.value}
            control={<Checkbox checked={selectedMetrics.includes(m.value)} onChange={() => handleMetricToggle(m.value)} />}
            label={m.label} />
        ))}
      </Box>
      <Button fullWidth variant="contained" onClick={() => { onResetFilters(); setDrawerOpen(false); }}
        startIcon={<ClearAllIcon />} disabled={!hasActiveFilters}
        sx={{ backgroundColor: hasActiveFilters ? "#d32f2f" : "#ccc", borderRadius: 2 }}>
        Filter zurücksetzen
      </Button>
    </Box>
  );

  if (mobileDrawer && isMobile) {
    return (
      <>
        <Badge badgeContent={selChCount + selMtCount} color="primary">
          <Button variant="outlined" onClick={() => setDrawerOpen(true)} startIcon={<FilterListIcon />} size="small">Filter</Button>
        </Badge>
        <Drawer anchor="right" open={drawerOpen} onClose={() => setDrawerOpen(false)}>{drawerContent}</Drawer>
      </>
    );
  }

  return (
    <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
      <Button variant="outlined" onClick={e => { e.stopPropagation(); setChannelAnchorEl(e.currentTarget); }}
        endIcon={<span>▼</span>} sx={{ minWidth: 150, borderRadius: 2, textTransform: "none" }}>
        {selChCount === 0 || selChCount === totChCount ? "Alle Kanäle" : `${selChCount} Kanäle`}
      </Button>
      {channelPopover}
      <Button variant="outlined" onClick={e => { e.stopPropagation(); setMetricAnchorEl(e.currentTarget); }}
        endIcon={<span>▼</span>} sx={{ minWidth: 150, borderRadius: 2, textTransform: "none" }}>
        {selMtCount === 0 || selMtCount === totMtCount ? "Alle Messgrößen" : `${selMtCount} Messgrößen`}
      </Button>
      {metricPopover}
      <Button variant="contained" onClick={onResetFilters} startIcon={<ClearAllIcon />} disabled={!hasActiveFilters}
        sx={{ backgroundColor: hasActiveFilters ? "#d32f2f" : "#ccc", borderRadius: 2, textTransform: "none" }}>
        Filter zurücksetzen
      </Button>
    </Box>
  );
});

// ─── GRAPH DETAIL ─────────────────────────────────────────────────────────────
const GraphDetail = ({ selectedChannel, historyData, isMouseOverGraph, setIsMouseOverGraph,
  selectedMetric, setSelectedMetric, timeRange, setTimeRange, onBack }) => {

  const [metricAnchorEl, setMetricAnchorEl] = useState(null);
  const [timeAnchorEl, setTimeAnchorEl]     = useState(null);

  const formatXAxis    = tick => new Date(tick).toLocaleTimeString();
  const displayName    = selectedChannel ? formatChannelName(selectedChannel) : "";
  const getMetricLabel = () => METRIC_LABELS[selectedMetric] || selectedMetric;
  const getTimeLabel   = () => TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.label || timeRange;

  return (
    <Box>
      <Paper sx={{ p: 2, mb: 2, display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        <Button startIcon={<ArrowBackIcon />} onClick={onBack} variant="outlined" sx={{ textTransform: "none" }}>
          Zurück zum Menü
        </Button>
        <Typography variant="h5">{displayName}</Typography>

        <Button variant="outlined" onClick={e => setMetricAnchorEl(e.currentTarget)}
          endIcon={<span>▼</span>} sx={{ minWidth: 150, textTransform: "none" }}>
          {getMetricLabel()}
        </Button>
        <Menu anchorEl={metricAnchorEl} open={Boolean(metricAnchorEl)}
          onClose={() => setMetricAnchorEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
          transformOrigin={{ vertical: "top", horizontal: "left" }}
          disableAutoFocus disableEnforceFocus disableScrollLock>
          {Object.entries(METRIC_LABELS).map(([key, label]) => (
            <MenuItem key={key}
              onClick={e => { e.stopPropagation(); setSelectedMetric(key); }}
              selected={selectedMetric === key} sx={{ borderRadius: 1 }}>
              <Checkbox checked={selectedMetric === key} size="small" />
              <ListItemText primary={label} />
            </MenuItem>
          ))}
        </Menu>

        <Button variant="outlined" onClick={e => setTimeAnchorEl(e.currentTarget)}
          endIcon={<span>▼</span>} sx={{ minWidth: 150, textTransform: "none" }}>
          {getTimeLabel()}
        </Button>
        <Menu anchorEl={timeAnchorEl} open={Boolean(timeAnchorEl)}
          onClose={() => setTimeAnchorEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
          transformOrigin={{ vertical: "top", horizontal: "left" }}
          disableAutoFocus disableEnforceFocus disableScrollLock>
          {TIME_RANGE_OPTIONS.map(opt => (
            <MenuItem key={opt.value}
              onClick={e => { e.stopPropagation(); setTimeRange(opt.value); }}
              selected={timeRange === opt.value} sx={{ borderRadius: 1 }}>
              <Checkbox checked={timeRange === opt.value} size="small" />
              <ListItemText primary={opt.label} />
            </MenuItem>
          ))}
        </Menu>

        <Typography variant="caption" style={{ color: "#666" }}>
          {isMouseOverGraph ? "⏸ Pause (Maus über Grafik)" : "🔄 Aktualisierung alle 1 Sekunde"}
        </Typography>
      </Paper>

      <Paper sx={{ p: 2, height: "60vh" }}
        onMouseEnter={() => setIsMouseOverGraph(true)}
        onMouseLeave={() => setIsMouseOverGraph(false)}>
        {historyData.length === 0 ? (
          <Typography align="center" color="text.secondary">Keine historischen Daten.</Typography>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={historyData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid stroke="#ddd" strokeDasharray="5 5" />
              <XAxis dataKey="time" tickFormatter={formatXAxis} angle={-30} textAnchor="end" height={60}
                tick={{ fontSize: 11, fill: "#333" }} axisLine={{ stroke: "#888", strokeWidth: 1 }} />
              <YAxis tick={{ fontSize: 11, fill: "#333" }} axisLine={{ stroke: "#888", strokeWidth: 1 }}
                label={{ value: METRIC_LABELS[selectedMetric], angle: -90, position: "insideLeft",
                  style: { textAnchor: "middle", fill: "#555", fontSize: 12 } }} />
              <RTooltip labelFormatter={t => new Date(t).toLocaleString()}
                wrapperStyle={{ pointerEvents: "auto" }}
                contentStyle={{ backgroundColor: "#fff", border: "1px solid #ccc", borderRadius: 6, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
              <Line type="monotone" dataKey={selectedMetric} stroke="#E67E22" strokeWidth={2.5}
                name={METRIC_LABELS[selectedMetric]} dot={false} isAnimationActive={false}
                connectNulls activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Paper>
    </Box>
  );
};

// ─── KANAL-KONFIGURATION ──────────────────────────────────────────────────────
// Enterprise-Redesign: Phasenfarbcodierung nach IEC-Aderfarbe (L1 braun, L2
// schwarz, L3 grau), Suchfeld + Phasen-/Status-Filter mit Zähler-Chips,
// Änderungsverfolgung (unsaved changes) und Statusprüfung Schwellwert/Höchstwert.
const CONFIG_STATUS = {
  ok:      { label: "OK",             color: SUCCESS, bg: SUCCESS_BG, Icon: CheckCircleIcon },
  warn:    { label: "Prüfen",         color: WARNING, bg: WARNING_BG, Icon: WarningAmberIcon },
  error:   { label: "Ungültig",       color: DANGER,  bg: DANGER_BG,  Icon: ErrorOutlineIcon },
};

const getConfigRowStatus = (cfg) => {
  const schwell = parseFloat(cfg?.schwellwert);
  const hoch    = parseFloat(cfg?.hoechstwert);
  if (isNaN(schwell) || isNaN(hoch) || hoch <= 0) return "warn";
  if (schwell > hoch) return "error";
  return "ok";
};

const ChannelConfigManager = () => {
  const [config, setConfig]           = useState({});
  const [savedConfig, setSavedConfig] = useState({});
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [message, setMessage]         = useState("");
  const [messageType, setMessageType] = useState("success");
  const [searchTerm, setSearchTerm]   = useState("");
  const [phaseFilter, setPhaseFilter] = useState([]);   // [] = alle Phasen
  const [statusFilter, setStatusFilter] = useState("all"); // all | warn | error
  const isMobile = useMediaQuery("(max-width:600px)");

  const loadConfig = async () => {
    try {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 5000);
      const res        = await axios.get(`${API_BASE_URL}/config`, { signal: controller.signal });
      clearTimeout(timeoutId);
      setConfig(res.data);
      setSavedConfig(res.data);
    } catch (err) {
      setMessageType("error");
      setMessage(err.name === "AbortError"
        ? "❌ Zeitüberschreitung: Server antwortet nicht."
        : "❌ Fehler beim Laden der Konfiguration: " + (err.message || "Netzwerkproblem"));
      setTimeout(() => setMessage(""), 5000);
    } finally { setLoading(false); }
  };

  useEffect(() => { loadConfig(); }, []);

  const handleChange = (channel, field, value) =>
    setConfig(prev => ({ ...prev, [channel]: { ...prev[channel], [field]: value } }));

  const saveConfig = async () => {
    setSaving(true);
    try {
      await axios.post(`${API_BASE_URL}/config`, config);
      setMessageType("success");
      setMessage("✅ Konfiguration erfolgreich gespeichert");
      setTimeout(() => setMessage(""), 3000);
      await loadConfig();
    } catch {
      setMessageType("error");
      setMessage("❌ Fehler beim Speichern der Konfiguration");
      setTimeout(() => setMessage(""), 3000);
    } finally { setSaving(false); }
  };

  const discardChanges = () => setConfig(savedConfig);

  const togglePhase = (idx) =>
    setPhaseFilter(prev => prev.includes(idx) ? prev.filter(p => p !== idx) : [...prev, idx]);

  if (loading) {
    return (
      <Paper elevation={0} sx={{ p: 4, mt: 3, textAlign: "center", border: `1px dashed ${BORDER}`, borderRadius: 2 }}>
        <Typography sx={{ color: INK_MUTED, fontFamily: DISPLAY_FONT }}>Konfiguration wird geladen…</Typography>
      </Paper>
    );
  }

  const entries = Object.entries(config).filter(([key]) => !key.startsWith("L"));
  const chunkSize = Math.ceil(entries.length / 3) || 1;
  const groups  = [
    { channels: entries.slice(0, chunkSize),              phase: PHASE_STYLES[0] },
    { channels: entries.slice(chunkSize, chunkSize * 2),  phase: PHASE_STYLES[1] },
    { channels: entries.slice(chunkSize * 2),             phase: PHASE_STYLES[2] },
  ];

  const dirtyChannels = Object.keys(config).filter(ch => {
    const a = config[ch] || {}, b = savedConfig[ch] || {};
    return (a.label || "") !== (b.label || "") ||
      (parseFloat(a.schwellwert) || 0) !== (parseFloat(b.schwellwert) || 0) ||
      (parseFloat(a.hoechstwert) || 0) !== (parseFloat(b.hoechstwert) || 0);
  });
  const isDirty = dirtyChannels.length > 0;

  const matchesFilters = (channel, cfg, groupIdx) => {
    if (phaseFilter.length > 0 && !phaseFilter.includes(groupIdx)) return false;
    const status = getConfigRowStatus(cfg);
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      const label = (cfg.label || "").toLowerCase();
      if (!channel.toLowerCase().includes(q) && !label.includes(q)) return false;
    }
    return true;
  };

  const totalWarnCount  = entries.filter(([, cfg]) => getConfigRowStatus(cfg) === "warn").length;
  const totalErrorCount = entries.filter(([, cfg]) => getConfigRowStatus(cfg) === "error").length;
  const hasActiveFilters = Boolean(searchTerm) || phaseFilter.length > 0 || statusFilter !== "all";

  return (
    <Paper elevation={0} sx={{ mt: 3, borderRadius: 3, border: `1px solid ${BORDER}`, overflow: "hidden", fontFamily: DISPLAY_FONT }}>
      {/* ── Kopfzeile ── */}
      <Box sx={{ px: 3, py: 2.5, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2, borderBottom: `1px solid ${BORDER}`, bgcolor: PANEL }}>
        <Box display="flex" alignItems="center" gap={1.5}>
          <Box sx={{ width: 40, height: 40, borderRadius: 2, bgcolor: SURFACE, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <SettingsInputComponentIcon sx={{ color: INK }} />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 700, fontSize: "1.15rem", color: INK, lineHeight: 1.2 }}>Kanal-Einstellungen</Typography>
            <Typography variant="caption" sx={{ color: INK_MUTED }}>Schwellwerte &amp; Bezeichnungen je Messkanal · {entries.length} Kanäle</Typography>
          </Box>
        </Box>

        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          {isDirty && (
            <Chip size="small" label={`${dirtyChannels.length} ungespeichert`} icon={<EditNoteIcon sx={{ fontSize: 16 }} />}
              sx={{ bgcolor: WARNING_BG, color: WARNING, fontWeight: 600, "& .MuiChip-icon": { color: WARNING } }} />
          )}
          {isDirty && (
            <Button size="small" variant="text" onClick={discardChanges} startIcon={<RestartAltIcon />}
              sx={{ textTransform: "none", color: INK_MUTED }}>
              Verwerfen
            </Button>
          )}
          <Button variant="contained" onClick={saveConfig} disabled={saving || !isDirty} startIcon={<SaveIcon />}
            sx={{
              textTransform: "none", borderRadius: 2, fontWeight: 600, px: 2.5,
              bgcolor: isDirty ? INK : BORDER, color: isDirty ? "#fff" : INK_MUTED,
              "&:hover": { bgcolor: isDirty ? "#000" : BORDER },
            }}>
            {saving ? "Speichern…" : "Alle speichern"}
          </Button>
        </Box>
      </Box>

      {message && <Alert severity={messageType === "success" ? "success" : "error"} sx={{ mx: 3, mt: 2 }}>{message}</Alert>}

      {/* ── Filterleiste ── */}
      <Box sx={{ px: 3, py: 2, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", bgcolor: SURFACE, borderBottom: `1px solid ${BORDER}` }}>
        <TextField
          size="small" placeholder="Kanal oder Bezeichnung suchen…" value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          sx={{ minWidth: 240, bgcolor: PANEL, borderRadius: 1.5, "& fieldset": { borderColor: BORDER } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: INK_MUTED }} /></InputAdornment> }}
        />

        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

        <Box display="flex" alignItems="center" gap={0.75}>
          <TuneIcon sx={{ fontSize: 18, color: INK_MUTED }} />
          {PHASE_STYLES.map((p, idx) => (
            <Chip
              key={p.tag} label={p.tag} size="small" onClick={() => togglePhase(idx)}
              icon={<Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: p.color, ml: "6px" }} />}
              sx={{
                fontWeight: 700, cursor: "pointer", border: `1.5px solid ${phaseFilter.length === 0 || phaseFilter.includes(idx) ? p.color : BORDER}`,
                bgcolor: phaseFilter.length === 0 || phaseFilter.includes(idx) ? p.bg : "transparent",
                color: phaseFilter.length === 0 || phaseFilter.includes(idx) ? p.color : INK_MUTED,
                opacity: phaseFilter.length > 0 && !phaseFilter.includes(idx) ? 0.5 : 1,
              }} />
          ))}
        </Box>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

        <ToggleButtonGroup size="small" exclusive value={statusFilter} onChange={(e, v) => v && setStatusFilter(v)}>
          <ToggleButton value="all" sx={{ textTransform: "none", px: 1.5, fontSize: "0.75rem" }}>Alle</ToggleButton>
          <ToggleButton value="warn" sx={{ textTransform: "none", px: 1.5, fontSize: "0.75rem", color: WARNING }}>
            <WarningAmberIcon sx={{ fontSize: 15, mr: 0.5 }} /> {totalWarnCount}
          </ToggleButton>
          <ToggleButton value="error" sx={{ textTransform: "none", px: 1.5, fontSize: "0.75rem", color: DANGER }}>
            <ErrorOutlineIcon sx={{ fontSize: 15, mr: 0.5 }} /> {totalErrorCount}
          </ToggleButton>
        </ToggleButtonGroup>

        {hasActiveFilters && (
          <Button size="small" onClick={() => { setSearchTerm(""); setPhaseFilter([]); setStatusFilter("all"); }}
            startIcon={<ClearAllIcon sx={{ fontSize: 16 }} />} sx={{ textTransform: "none", color: INK_MUTED, ml: "auto" }}>
            Filter zurücksetzen
          </Button>
        )}
      </Box>

      {/* ── Kanalgruppen ── */}
      <Box sx={{ p: 3 }}>
        {groups.map((group, groupIdx) => {
          const visibleChannels = group.channels.filter(([ch, cfg]) => matchesFilters(ch, cfg, groupIdx));
          if (visibleChannels.length === 0) return null;
          return (
            <Box key={groupIdx} sx={{ mb: 3, borderRadius: 2, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.25, bgcolor: group.phase.bg, borderBottom: `1px solid ${BORDER}` }}>
                <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: group.phase.color, border: "2px solid #fff", boxShadow: `0 0 0 1px ${group.phase.color}` }} />
                <Typography sx={{ fontWeight: 700, fontSize: "0.8rem", color: group.phase.color, letterSpacing: "0.4px" }}>
                  {group.phase.name} · {group.phase.tag}
                </Typography>
                <Typography variant="caption" sx={{ color: INK_MUTED, ml: "auto" }}>{visibleChannels.length} Kanäle</Typography>
              </Box>
              <Box sx={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isMobile ? 560 : "auto" }}>
                  <thead>
                    <tr style={{ backgroundColor: SURFACE }}>
                      <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>KANAL</th>
                      <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>BEZEICHNUNG</th>
                      <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>SCHWELLWERT (A)</th>
                      <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>HÖCHSTWERT (A)</th>
                      <th style={{ padding: "10px 16px", textAlign: "center", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleChannels.map(([channel, cfg]) => {
                      const status = CONFIG_STATUS[getConfigRowStatus(cfg)];
                      const StatusIcon = status.Icon;
                      const isRowDirty = dirtyChannels.includes(channel);
                      return (
                        <tr key={channel} style={{ borderBottom: `1px solid ${BORDER}`, backgroundColor: isRowDirty ? WARNING_BG : PANEL }}>
                          <td style={{ padding: "10px 16px" }}>
                            <Box display="flex" alignItems="center" gap={1}>
                              <Box sx={{ width: 4, height: 20, borderRadius: 1, bgcolor: group.phase.color }} />
                              <Typography sx={{ fontFamily: MONO_FONT, fontWeight: 700, fontSize: "0.85rem", color: INK }}>
                                {formatChannelName(channel)}
                              </Typography>
                            </Box>
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <TextField size="small" value={cfg.label || ""} placeholder="Bezeichnung eingeben"
                              onChange={e => handleChange(channel, "label", e.target.value)}
                              fullWidth variant="outlined"
                              sx={{ minWidth: 160, "& .MuiOutlinedInput-root": { bgcolor: PANEL, fontWeight: 600, fontSize: "0.85rem" } }} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <TextField type="number" size="small" value={cfg.schwellwert ?? 0}
                              onChange={e => handleChange(channel, "schwellwert", parseFloat(e.target.value) || 0)}
                              variant="outlined" inputProps={{ step: "0.1" }}
                              sx={{ width: isMobile ? 90 : 110, "& .MuiOutlinedInput-root": { bgcolor: PANEL, fontFamily: MONO_FONT } }} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <TextField type="number" size="small" value={cfg.hoechstwert ?? 0}
                              onChange={e => handleChange(channel, "hoechstwert", parseFloat(e.target.value) || 0)}
                              variant="outlined" inputProps={{ step: "0.1" }}
                              sx={{ width: isMobile ? 90 : 110, "& .MuiOutlinedInput-root": { bgcolor: PANEL, fontFamily: MONO_FONT } }} />
                          </td>
                          <td style={{ padding: "10px 16px", textAlign: "center" }}>
                            <Tooltip title={status.label === "OK" ? "Werte plausibel" : status.label === "Prüfen" ? "Höchstwert fehlt oder ist 0" : "Schwellwert > Höchstwert"}>
                              <Chip size="small" icon={<StatusIcon sx={{ fontSize: "15px !important", color: `${status.color} !important` }} />}
                                label={status.label}
                                sx={{ bgcolor: status.bg, color: status.color, fontWeight: 700, fontSize: "0.7rem" }} />
                            </Tooltip>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Box>
            </Box>
          );
        })}

        {groups.every((group, groupIdx) => group.channels.filter(([ch, cfg]) => matchesFilters(ch, cfg, groupIdx)).length === 0) && (
          <Box sx={{ py: 6, textAlign: "center" }}>
            <SearchIcon sx={{ fontSize: 32, color: BORDER, mb: 1 }} />
            <Typography sx={{ color: INK_MUTED }}>Keine Kanäle entsprechen den aktuellen Filtern.</Typography>
          </Box>
        )}
      </Box>
    </Paper>
  );
};

// ─── ENERGIE-MANAGER ──────────────────────────────────────────────────────────
// Enterprise-Redesign: gleiche Phasenfarbcodierung wie in den Kanal-Einstellungen,
// Such-/Phasenfilter mit Zähler-Chips, Zähler im LCD-Stil (Monospace) und
// relative Zeitangaben für die letzte Änderung. Der Massen-Setzen-Vorgang läuft
// als klar abgegrenzte "Stapelaktion"-Karte.
const EnergyManager = () => {
  const [energyData, setEnergyData]                         = useState({});
  const [loading, setLoading]                               = useState(true);
  const [selectedEnergyChannels, setSelectedEnergyChannels] = useState([]);
  const [globalEnergyValue, setGlobalEnergyValue]           = useState("");
  const [message, setMessage]                               = useState("");
  const [messageType, setMessageType]                       = useState("success");
  const [searchTerm, setSearchTerm]                         = useState("");
  const [phaseFilter, setPhaseFilter]                       = useState([]); // [] = alle Phasen
  const [, setTick]                                         = useState(0);
  const isMobile = useMediaQuery("(max-width:600px)");

  const loadEnergyData = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/energy-values`);
      setEnergyData({ ...res.data });
      return res.data;
    } catch {
      setMessageType("error");
      setMessage("❌ Fehler beim Laden der Energiedaten");
      setTimeout(() => setMessage(""), 5000);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    loadEnergyData();
    const interval = setInterval(loadEnergyData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Aktualisiert nur die Anzeige "vor X Min", ohne neu vom Server zu laden.
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 15000);
    return () => clearInterval(iv);
  }, []);

  const handleSelectAllEnergyChannels = (visibleKeys) => {
    setSelectedEnergyChannels(prev =>
      visibleKeys.every(k => prev.includes(k)) ? prev.filter(k => !visibleKeys.includes(k)) : Array.from(new Set([...prev, ...visibleKeys]))
    );
  };

  const handleEnergyChannelToggle = ch =>
    setSelectedEnergyChannels(prev => prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]);

  const togglePhase = (idx) =>
    setPhaseFilter(prev => prev.includes(idx) ? prev.filter(p => p !== idx) : [...prev, idx]);

  const sendGlobalEnergyValue = async () => {
    const value = parseFloat(globalEnergyValue);
    if (isNaN(value) || value < 0) {
      setMessageType("error"); setMessage("❌ Ungültiger Wert (muss ≥ 0 sein)");
      setTimeout(() => setMessage(""), 3000); return;
    }
    if (selectedEnergyChannels.length === 0) {
      setMessageType("error"); setMessage("❌ Bitte wählen Sie mindestens einen Kanal aus");
      setTimeout(() => setMessage(""), 3000); return;
    }
    setLoading(true);
    let successCount = 0, errorCount = 0;

    for (const channel of selectedEnergyChannels) {
      try {
        await axios.post(`${API_BASE_URL}/energy-values/set`, { [channel]: { temporary: value } });
        successCount++;
      } catch (err) { errorCount++; console.error(`Fehler bei ${channel}:`, err); }
    }

    // ✅ CORRECTION 1 : Mettre à jour le state local IMMÉDIATEMENT
    // sans attendre la relecture du Messkoffer
    setEnergyData(prev => {
      const updated = { ...prev };
      for (const channel of selectedEnergyChannels) {
        updated[channel] = {
          ...updated[channel],
          temporary: value,
          updatedAt: new Date().toISOString()
        };
      }
      return updated;
    });

    setMessageType(errorCount === 0 ? "success" : "error");
    setMessage(errorCount === 0
      ? `✅ ${successCount} Kanäle auf ${value.toFixed(2)} kWh gesetzt`
      : `⚠️ ${successCount} OK, ${errorCount} Fehler`);
    setTimeout(() => setMessage(""), 3000);

    setLoading(false);
    setGlobalEnergyValue("");

    // ✅ CORRECTION 2 : Relire depuis le serveur après 3s
    // (le serveur attend déjà 2s avant de relire le Messkoffer)
    setTimeout(() => loadEnergyData(), 3000);
  };

  if (loading && Object.keys(energyData).length === 0)
    return (
      <Paper elevation={0} sx={{ p: 4, mt: 3, textAlign: "center", border: `1px dashed ${BORDER}`, borderRadius: 2 }}>
        <Typography sx={{ color: INK_MUTED, fontFamily: DISPLAY_FONT }}>Energiedaten werden geladen…</Typography>
      </Paper>
    );
  if (!energyData || typeof energyData !== "object" || Object.keys(energyData).length === 0)
    return (
      <Paper elevation={0} sx={{ p: 4, mt: 3, textAlign: "center", border: `1px dashed ${BORDER}`, borderRadius: 2 }}>
        <Typography sx={{ color: INK_MUTED, fontFamily: DISPLAY_FONT }}>Keine Daten verfügbar.</Typography>
      </Paper>
    );

  const entries       = Object.entries(energyData);
  const chunkSize      = Math.ceil(entries.length / 3) || 1;
  const groups         = [
    { channels: entries.slice(0, chunkSize),             phase: PHASE_STYLES[0] },
    { channels: entries.slice(chunkSize, chunkSize * 2), phase: PHASE_STYLES[1] },
    { channels: entries.slice(chunkSize * 2),            phase: PHASE_STYLES[2] },
  ];

  const matchesFilters = (channel, data_, groupIdx) => {
    if (phaseFilter.length > 0 && !phaseFilter.includes(groupIdx)) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      const label = (data_?.label || "").toLowerCase();
      if (!channel.toLowerCase().includes(q) && !label.includes(q)) return false;
    }
    return true;
  };

  const visibleGroups = groups.map((g, idx) => ({
    ...g, visible: g.channels.filter(([ch, d]) => matchesFilters(ch, d, idx)),
  }));
  const visibleKeys = visibleGroups.flatMap(g => g.visible.map(([ch]) => ch));
  const selectedCount = selectedEnergyChannels.length;
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every(k => selectedEnergyChannels.includes(k));
  const someVisibleSelected = visibleKeys.some(k => selectedEnergyChannels.includes(k));
  const hasActiveFilters = Boolean(searchTerm) || phaseFilter.length > 0;

  return (
    <Paper elevation={0} sx={{ mt: 3, borderRadius: 3, border: `1px solid ${BORDER}`, overflow: "hidden", fontFamily: DISPLAY_FONT }}>
      {/* ── Kopfzeile ── */}
      <Box sx={{ px: 3, py: 2.5, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2, borderBottom: `1px solid ${BORDER}`, bgcolor: PANEL }}>
        <Box display="flex" alignItems="center" gap={1.5}>
          <Box sx={{ width: 40, height: 40, borderRadius: 2, bgcolor: SURFACE, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <BoltIcon sx={{ color: INK }} />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 700, fontSize: "1.15rem", color: INK, lineHeight: 1.2 }}>Zählerstände</Typography>
            <Typography variant="caption" sx={{ color: INK_MUTED }}>Temporäre Energiezähler je Messkanal · {entries.length} Kanäle</Typography>
          </Box>
        </Box>
        <Button variant="outlined" onClick={loadEnergyData} startIcon={<RefreshIcon />}
          sx={{ textTransform: "none", borderRadius: 2, borderColor: BORDER, color: INK }}>
          Aktualisieren
        </Button>
      </Box>

      {message && <Alert severity={messageType === "success" ? "success" : "error"} sx={{ mx: 3, mt: 2 }}>{message}</Alert>}

      {/* ── Filterleiste ── */}
      <Box sx={{ px: 3, py: 2, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", bgcolor: SURFACE, borderBottom: `1px solid ${BORDER}` }}>
        <TextField
          size="small" placeholder="Kanal oder Bezeichnung suchen…" value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          sx={{ minWidth: 240, bgcolor: PANEL, borderRadius: 1.5 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: INK_MUTED }} /></InputAdornment> }}
        />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <Box display="flex" alignItems="center" gap={0.75}>
          <TuneIcon sx={{ fontSize: 18, color: INK_MUTED }} />
          {PHASE_STYLES.map((p, idx) => (
            <Chip
              key={p.tag} label={p.tag} size="small" onClick={() => togglePhase(idx)}
              icon={<Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: p.color, ml: "6px" }} />}
              sx={{
                fontWeight: 700, cursor: "pointer", border: `1.5px solid ${phaseFilter.length === 0 || phaseFilter.includes(idx) ? p.color : BORDER}`,
                bgcolor: phaseFilter.length === 0 || phaseFilter.includes(idx) ? p.bg : "transparent",
                color: phaseFilter.length === 0 || phaseFilter.includes(idx) ? p.color : INK_MUTED,
                opacity: phaseFilter.length > 0 && !phaseFilter.includes(idx) ? 0.5 : 1,
              }} />
          ))}
        </Box>
        {hasActiveFilters && (
          <Button size="small" onClick={() => { setSearchTerm(""); setPhaseFilter([]); }}
            startIcon={<ClearAllIcon sx={{ fontSize: 16 }} />} sx={{ textTransform: "none", color: INK_MUTED, ml: "auto" }}>
            Filter zurücksetzen
          </Button>
        )}
      </Box>

      {/* ── Stapelaktion: Wert setzen ── */}
      <Box sx={{ mx: 3, mt: 3, p: 2.5, borderRadius: 2, border: `1px solid ${BORDER}`, bgcolor: SURFACE }}>
        <Box display="flex" alignItems="center" gap={1} sx={{ mb: 1.5 }}>
          <LabelImportantOutlinedIcon sx={{ fontSize: 18, color: INK_MUTED }} />
          <Typography sx={{ fontWeight: 700, fontSize: "0.85rem", color: INK }}>Stapelaktion — Zählerwert setzen</Typography>
          <Chip size="small" label={`${selectedCount} ausgewählt`}
            sx={{ ml: "auto", bgcolor: selectedCount > 0 ? PRIMARY_COLOR : BORDER, color: selectedCount > 0 ? "#fff" : INK_MUTED, fontWeight: 600 }} />
        </Box>
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          <FormControlLabel
            sx={{ mr: 0 }}
            control={<Checkbox size="small" checked={allVisibleSelected} indeterminate={someVisibleSelected && !allVisibleSelected}
              onChange={() => handleSelectAllEnergyChannels(visibleKeys)} />}
            label={<Typography variant="caption" sx={{ color: INK_MUTED }}>Alle sichtbaren</Typography>} />
          <TextField type="number" size="small" label="Wert (kWh)" value={globalEnergyValue}
            onChange={e => setGlobalEnergyValue(e.target.value)}
            inputProps={{ step: "0.1" }} sx={{ width: 160, bgcolor: PANEL, "& input": { fontFamily: MONO_FONT } }} />
          <Button variant="contained" onClick={sendGlobalEnergyValue} startIcon={<SendIcon />}
            disabled={loading || selectedEnergyChannels.length === 0 || globalEnergyValue === ""}
            sx={{ textTransform: "none", borderRadius: 2, fontWeight: 600, bgcolor: INK, "&:hover": { bgcolor: "#000" } }}>
            Absenden
          </Button>
          <Typography variant="caption" sx={{ color: INK_MUTED }}>
            Kanäle unten anhaken, Wert eingeben, absenden.
          </Typography>
        </Box>
      </Box>

      {/* ── Kanalgruppen ── */}
      <Box sx={{ p: 3 }}>
        {visibleGroups.map((group, groupIdx) => {
          if (group.visible.length === 0) return null;
          return (
            <Box key={groupIdx} sx={{ mb: 3, borderRadius: 2, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.25, bgcolor: group.phase.bg, borderBottom: `1px solid ${BORDER}` }}>
                <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: group.phase.color, border: "2px solid #fff", boxShadow: `0 0 0 1px ${group.phase.color}` }} />
                <Typography sx={{ fontWeight: 700, fontSize: "0.8rem", color: group.phase.color, letterSpacing: "0.4px" }}>
                  {group.phase.name} · {group.phase.tag}
                </Typography>
                <Typography variant="caption" sx={{ color: INK_MUTED, ml: "auto" }}>{group.visible.length} Kanäle</Typography>
              </Box>
              <Box sx={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isMobile ? 560 : "auto" }}>
                  <thead>
                    <tr style={{ backgroundColor: SURFACE }}>
                      <th style={{ padding: "10px 12px", width: 40 }}></th>
                      <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>KANAL</th>
                      <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>BEZEICHNUNG</th>
                      <th style={{ padding: "10px 16px", textAlign: "center", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>ZÄHLERSTAND (KWH)</th>
                      <th style={{ padding: "10px 16px", textAlign: "center", fontSize: "0.72rem", letterSpacing: "0.5px", color: INK_MUTED, fontWeight: 700 }}>LETZTE ÄNDERUNG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.visible.map(([channel, data_]) => {
                      const isSelected  = selectedEnergyChannels.includes(channel);
                      const relative    = formatRelativeTime(data_?.updatedAt);
                      return (
                        <tr key={channel} style={{ borderBottom: `1px solid ${BORDER}`, backgroundColor: isSelected ? SUCCESS_BG : PANEL }}>
                          <td style={{ padding: "10px 12px", textAlign: "center" }}>
                            <Checkbox size="small" checked={isSelected} onChange={() => handleEnergyChannelToggle(channel)} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <Box display="flex" alignItems="center" gap={1}>
                              <Box sx={{ width: 4, height: 20, borderRadius: 1, bgcolor: group.phase.color }} />
                              <Typography sx={{ fontFamily: MONO_FONT, fontWeight: 700, fontSize: "0.85rem", color: INK }}>
                                {formatChannelName(channel)}
                              </Typography>
                            </Box>
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <Typography variant="body2" sx={{ fontWeight: 600, color: INK }}>{data_?.label || formatChannelName(channel)}</Typography>
                          </td>
                          <td style={{ padding: "10px 16px", textAlign: "center" }}>
                            <Box component="span" sx={{
                              display: "inline-block", bgcolor: "#12181f", color: "#7CE2A6", fontFamily: MONO_FONT,
                              fontWeight: 700, fontSize: "0.85rem", borderRadius: 1, px: 1.25, py: 0.5, letterSpacing: "0.5px",
                            }}>
                              {(data_?.temporary || 0).toFixed(2)} kWh
                            </Box>
                          </td>
                          <td style={{ padding: "10px 16px", textAlign: "center" }}>
                            {relative ? (
                              <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                                <ScheduleIcon sx={{ fontSize: 14, color: INK_MUTED }} />
                                <Typography variant="caption" sx={{ color: INK_MUTED }}>{relative}</Typography>
                              </Box>
                            ) : <Typography variant="caption" sx={{ color: INK_MUTED }}>—</Typography>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Box>
            </Box>
          );
        })}

        {visibleKeys.length === 0 && (
          <Box sx={{ py: 6, textAlign: "center" }}>
            <SearchIcon sx={{ fontSize: 32, color: BORDER, mb: 1 }} />
            <Typography sx={{ color: INK_MUTED }}>Keine Kanäle entsprechen den aktuellen Filtern.</Typography>
          </Box>
        )}
      </Box>
    </Paper>
  );
};

// ─── MAPPING METRIC OPTIONS (Strom / Wirkleistung / Spannung / Energie) ────────────────
const MAPPING_METRIC_OPTIONS = [
  { value: "Strom",        label: "Strom (A)",        icon: ElectricBoltIcon,        decimals: 3, unit: "A"   },
  { value: "Wirkleistung", label: "Wirkleistung (W)", icon: SpeedIcon,               decimals: 2, unit: "W"   },
  { value: "Spannung",     label: "Spannung (V)",     icon: VoltageSvgIcon,          decimals: 1, unit: "V"   },
  { value: "Energie",      label: "Energie (kWh)",    icon: BatteryChargingFullIcon, decimals: 2, unit: "kWh" },
];
const MAPPING_METRIC_LABELS = {
  Strom:        "Strom (A)",
  Wirkleistung: "Wirkleistung (W)",
  Spannung:     "Spannung (V)",
  Energie:      "Energie (kWh)",
};
const KANAL_LABELS = { "1": "L1", "2": "L2", "3": "L3", "4": "N" };
const KANAL_OPTIONS = ["1", "2", "3", "4"];

// ─── MAPPING DETAIL (historique d'un Sensor/Kanal, style GraphDetail) ───────
const MappingDetail = ({ device, kanaele, initialKanal, onBack }) => {
  const [selectedKanal, setSelectedKanal]   = useState(initialKanal);
  const [selectedMetric, setSelectedMetric] = useState("Strom");
  const [timeRange, setTimeRange]           = useState("5m");
  const [historyData, setHistoryData]       = useState([]);
  const [isMouseOverGraph, setIsMouseOverGraph] = useState(false);
  const [kanalAnchorEl, setKanalAnchorEl]   = useState(null);
  const [metricAnchorEl, setMetricAnchorEl] = useState(null);
  const [timeAnchorEl, setTimeAnchorEl]     = useState(null);

  const currentKanalData = kanaele.find(k => k.kanal === selectedKanal) || {};

  useEffect(() => {
    if (!selectedKanal) return;
    let cancelled = false;
    const update = async () => {
      try {
        const res = await axios.get(
          `${API_BASE_URL}/sensor-history/${device}/${selectedKanal}?metric=${selectedMetric}&time=${timeRange}`
        );
        if (!cancelled && res.data?.data) setHistoryData(res.data.data);
      } catch (err) { console.error("Erreur historique sensor-history:", err); }
    };
    update();
    const iv = setInterval(() => { if (!isMouseOverGraph) update(); }, 1000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [device, selectedKanal, selectedMetric, timeRange, isMouseOverGraph]);

  const formatXAxis  = tick => new Date(tick).toLocaleTimeString();
  const getTimeLabel = () => TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.label || timeRange;

  return (
    <Box>
      <Paper sx={{ p: 2, mb: 2, display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        <Button startIcon={<ArrowBackIcon />} onClick={onBack} variant="outlined" sx={{ textTransform: "none" }}>
          Zurück zum Menü
        </Button>
        <Typography variant="h5">{device}</Typography>

        <Button variant="outlined" onClick={e => setKanalAnchorEl(e.currentTarget)}
          endIcon={<span>▼</span>} sx={{ minWidth: 130, textTransform: "none" }}>
          {KANAL_LABELS[selectedKanal] || selectedKanal} (Kanal {selectedKanal})
        </Button>
        <Menu anchorEl={kanalAnchorEl} open={Boolean(kanalAnchorEl)} onClose={() => setKanalAnchorEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }} transformOrigin={{ vertical: "top", horizontal: "left" }}
          disableAutoFocus disableEnforceFocus disableScrollLock>
          {kanaele.map(k => (
            <MenuItem key={k.kanal} onClick={e => { e.stopPropagation(); setSelectedKanal(k.kanal); }}
              selected={selectedKanal === k.kanal} sx={{ borderRadius: 1 }}>
              <Checkbox checked={selectedKanal === k.kanal} size="small" />
              <ListItemText primary={`${KANAL_LABELS[k.kanal] || k.kanal} (Kanal ${k.kanal})`} />
            </MenuItem>
          ))}
        </Menu>

        <Button variant="outlined" onClick={e => setMetricAnchorEl(e.currentTarget)}
          endIcon={<span>▼</span>} sx={{ minWidth: 150, textTransform: "none" }}>
          {MAPPING_METRIC_LABELS[selectedMetric]}
        </Button>
        <Menu anchorEl={metricAnchorEl} open={Boolean(metricAnchorEl)} onClose={() => setMetricAnchorEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }} transformOrigin={{ vertical: "top", horizontal: "left" }}
          disableAutoFocus disableEnforceFocus disableScrollLock>
          {Object.entries(MAPPING_METRIC_LABELS).map(([key, label]) => (
            <MenuItem key={key} onClick={e => { e.stopPropagation(); setSelectedMetric(key); }}
              selected={selectedMetric === key} sx={{ borderRadius: 1 }}>
              <Checkbox checked={selectedMetric === key} size="small" />
              <ListItemText primary={label} />
            </MenuItem>
          ))}
        </Menu>

        <Button variant="outlined" onClick={e => setTimeAnchorEl(e.currentTarget)}
          endIcon={<span>▼</span>} sx={{ minWidth: 150, textTransform: "none" }}>
          {getTimeLabel()}
        </Button>
        <Menu anchorEl={timeAnchorEl} open={Boolean(timeAnchorEl)} onClose={() => setTimeAnchorEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }} transformOrigin={{ vertical: "top", horizontal: "left" }}
          disableAutoFocus disableEnforceFocus disableScrollLock>
          {TIME_RANGE_OPTIONS.map(opt => (
            <MenuItem key={opt.value} onClick={e => { e.stopPropagation(); setTimeRange(opt.value); }}
              selected={timeRange === opt.value} sx={{ borderRadius: 1 }}>
              <Checkbox checked={timeRange === opt.value} size="small" />
              <ListItemText primary={opt.label} />
            </MenuItem>
          ))}
        </Menu>

        <Typography variant="caption" style={{ color: "#666" }}>
          {isMouseOverGraph ? "⏸ Pause (Maus über Grafik)" : "🔄 Aktualisierung alle 1 Sekunde"}
        </Typography>
      </Paper>

      {/* Résumé des valeurs actuelles */}
      <Box display="flex" gap={2} sx={{ mb: 2, flexWrap: "wrap" }}>
        {MAPPING_METRIC_OPTIONS.map(m => (
          <Paper key={m.value} elevation={1} sx={{ flex: 1, minWidth: 140, p: 2, textAlign: "center" }}>
            <Typography variant="caption" color="textSecondary">{m.label}</Typography>
            <Typography variant="h5" fontWeight={600}>{formatValue(currentKanalData[m.value], m.decimals, m.unit)}</Typography>
          </Paper>
        ))}
      </Box>

      <Paper sx={{ p: 2, height: "55vh" }}
        onMouseEnter={() => setIsMouseOverGraph(true)} onMouseLeave={() => setIsMouseOverGraph(false)}>
        {historyData.length === 0 ? (
          <Typography align="center" color="text.secondary">Keine historischen Daten.</Typography>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={historyData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid stroke="#ddd" strokeDasharray="5 5" />
              <XAxis dataKey="time" tickFormatter={formatXAxis} angle={-30} textAnchor="end" height={60}
                tick={{ fontSize: 11, fill: "#333" }} axisLine={{ stroke: "#888", strokeWidth: 1 }} />
              <YAxis tick={{ fontSize: 11, fill: "#333" }} axisLine={{ stroke: "#888", strokeWidth: 1 }}
                label={{ value: MAPPING_METRIC_LABELS[selectedMetric], angle: -90, position: "insideLeft",
                  style: { textAnchor: "middle", fill: "#555", fontSize: 12 } }} />
              <RTooltip labelFormatter={t => new Date(t).toLocaleString()}
                wrapperStyle={{ pointerEvents: "auto" }}
                contentStyle={{ backgroundColor: "#fff", border: "1px solid #ccc", borderRadius: 6, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
              <Line type="monotone" dataKey={selectedMetric} stroke="#E67E22" strokeWidth={2.5}
                name={MAPPING_METRIC_LABELS[selectedMetric]} dot={false} isAnimationActive={false}
                connectNulls activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Paper>
    </Box>
  );
};

// ─── MAPPING MANAGER (boxes style Echtzeit + filtres + détail) ──────────────
const MappingManager = () => {
  const [sensors, setSensors]                       = useState([]);
  const [loading, setLoading]                       = useState(true);
  const [refreshing, setRefreshing]                 = useState(false);
  const [message, setMessage]                       = useState("");
  const [messageType, setMessageType]                = useState("success");
  const [selectedSensors, setSelectedSensors]       = useState([]);
  const [selectedMappingMetrics, setSelectedMappingMetrics] = useState([]);
  const [selectedKanaele, setSelectedKanaele]       = useState([]);
  const [kanalAnchorEl, setKanalAnchorEl]           = useState(null);
  const [detailDevice, setDetailDevice]             = useState(null);
  const isMobile = useMediaQuery("(max-width:600px)");

  const loadSensors = async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/sensors-discovery`);
      setSensors(res.data?.sensors || []);
      if (isManualRefresh) {
        setMessageType("success");
        setMessage(`✅ ${res.data?.count || 0} Sensor(en) erkannt`);
        setTimeout(() => setMessage(""), 3000);
      }
    } catch (err) {
      setMessageType("error");
      setMessage("❌ Fehler beim Abrufen der Sensoren: " + (err.message || "Netzwerkproblem"));
      setTimeout(() => setMessage(""), 5000);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadSensors(false); }, []);

  const netzDevice   = sensors.find(s => s.device === "Netz" || s.device === "Sensor0");
  const otherSensors = sensors.filter(s => s !== netzDevice);
  const getNetzVoltage = (kanalNum) => {
    if (!netzDevice) return null;
    const k = netzDevice.kanaele.find(k => k.kanal === String(kanalNum));
    return k?.Spannung ?? null;
  };

  const allDeviceNames = otherSensors.map(s => s.device);
  const hasActiveFilters = selectedSensors.length > 0 || selectedMappingMetrics.length > 0 || selectedKanaele.length > 0;

  const handleSensorChange     = useCallback(e => setSelectedSensors(e.target.value), []);
  const handleSelectAllSensors = useCallback(() => setSelectedSensors(prev => prev.length === allDeviceNames.length ? [] : [...allDeviceNames]), [allDeviceNames]);
  const handleMetricChange     = useCallback(e => setSelectedMappingMetrics(e.target.value), []);
  const handleSelectAllMetrics = useCallback(() => setSelectedMappingMetrics(prev => prev.length === MAPPING_METRIC_OPTIONS.length ? [] : MAPPING_METRIC_OPTIONS.map(m => m.value)), []);
  const resetMappingFilters    = useCallback(() => { setSelectedSensors([]); setSelectedMappingMetrics([]); setSelectedKanaele([]); }, []);

  const handleKanalToggle = (k) => {
    setSelectedKanaele(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
  };
  const handleSelectAllKanaele = () => {
    setSelectedKanaele(prev => prev.length === KANAL_OPTIONS.length ? [] : [...KANAL_OPTIONS]);
  };
  const selKaCount = selectedKanaele.length;
  const totKaCount = KANAL_OPTIONS.length;

  const shouldShowSensor = device => selectedSensors.length === 0 || selectedSensors.includes(device);
  const shouldShowMetric = key    => selectedMappingMetrics.length === 0 || selectedMappingMetrics.includes(key);
  const shouldShowKanal   = kanal  => selectedKanaele.length === 0 || selectedKanaele.includes(kanal);

  if (detailDevice) {
    const sensorObj = otherSensors.find(s => s.device === detailDevice);
    if (sensorObj) {
      return (
        <MappingDetail
          device={sensorObj.device}
          kanaele={sensorObj.kanaele}
          initialKanal={sensorObj.kanaele[0]?.kanal}
          onBack={() => setDetailDevice(null)}
        />
      );
    }
    setDetailDevice(null);
  }

  if (loading) return <Typography sx={{ p: 3 }}>Sensoren werden erkannt...</Typography>;

  const visibleSensors = otherSensors.filter(s => shouldShowSensor(s.device));
  const showNetzBox = Boolean(netzDevice) && (selectedSensors.length === 0) && shouldShowMetric("Spannung") && shouldShowKanal("1") && shouldShowKanal("2") && shouldShowKanal("3");

  return (
    <>
      <Paper elevation={2} style={{ padding: "12px 20px", marginBottom: 20, borderRadius: 10, backgroundColor: "#fff" }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
          <Box display="flex" alignItems="center" gap={1.5}>
            <DeviceHubIcon style={{ color: PRIMARY_COLOR, fontSize: "1.8rem" }} />
            <Typography variant="h5" style={{ fontWeight: 600, color: "#333" }}>Mapping - Sensor-Übersicht</Typography>
          </Box>
          <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
            <FilterBar selectedChannels={selectedSensors} selectedMetrics={selectedMappingMetrics}
              onChannelChange={handleSensorChange} onSelectAllChannels={handleSelectAllSensors}
              onMetricChange={handleMetricChange} onSelectAllMetrics={handleSelectAllMetrics}
              onResetFilters={resetMappingFilters} hasActiveFilters={hasActiveFilters}
              orderedChannels={allDeviceNames} metricOptions={MAPPING_METRIC_OPTIONS} mobileDrawer />

            <Button variant="outlined" onClick={e => { e.stopPropagation(); setKanalAnchorEl(e.currentTarget); }}
              endIcon={<span>▼</span>} sx={{ minWidth: 150, borderRadius: 2, textTransform: "none" }}>
              {selKaCount === 0 || selKaCount === totKaCount ? "Alle Kanäle" : `${selKaCount} Kanäle`}
            </Button>
            <Popover open={Boolean(kanalAnchorEl)} anchorEl={kanalAnchorEl}
              onClose={() => setKanalAnchorEl(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              disableAutoFocus disableEnforceFocus keepMounted>
              <Box sx={{ p: 2, minWidth: 220, maxWidth: 300 }}>
                <FormControlLabel
                  control={<Checkbox checked={selKaCount === totKaCount} indeterminate={selKaCount > 0 && selKaCount < totKaCount} onChange={handleSelectAllKanaele} />}
                  label="Alle Kanäle" />
                <Divider sx={{ my: 1 }} />
                {KANAL_OPTIONS.map(k => (
                  <FormControlLabel key={k}
                    control={<Checkbox checked={selectedKanaele.includes(k)} onChange={() => handleKanalToggle(k)} />}
                    label={`${KANAL_LABELS[k] || k} (Kanal ${k})`} sx={{ display: "block" }} />
                ))}
              </Box>
            </Popover>

            <Button variant="outlined" onClick={() => loadSensors(true)} disabled={refreshing} startIcon={<UpdateIcon />}
              style={{ borderRadius: 20, textTransform: "none" }}>
              {refreshing ? "Aktualisieren..." : "Aktualisieren"}
            </Button>
          </Box>
        </Box>
      </Paper>

      {message && <Alert severity={messageType === "success" ? "success" : "error"} sx={{ mb: 2 }}>{message}</Alert>}

      {showNetzBox && (
        <Box display="flex" gap={2} sx={{ mb: "25px", flexDirection: isMobile ? "column" : "row" }}>
          {[{ phase: "Phase 1", kanal: 1, label: "Spannung L1" },
            { phase: "Phase 2", kanal: 2, label: "Spannung L2" },
            { phase: "Phase 3", kanal: 3, label: "Spannung L3" }].map(({ phase, kanal, label }) => (
            <Paper key={phase} elevation={2} style={{ flex: 1, padding: 15, backgroundColor: "#fff", borderRadius: 10, textAlign: "center" }}>
              <Box display="flex" alignItems="center" justifyContent="center" gap={1}>
                <VoltageSvgIcon style={{ color: PRIMARY_COLOR }} />
                <Typography variant="subtitle1" fontWeight={600}>{phase}</Typography>
              </Box>
              <Typography variant="h3" fontWeight={600}>{formatValue(getNetzVoltage(kanal), 1, "V")}</Typography>
              <Typography variant="caption">{label}</Typography>
            </Paper>
          ))}
        </Box>
      )}

      {visibleSensors.length === 0 ? (
        <Paper elevation={1} sx={{ p: 3 }}>
          <Typography color="text.secondary">Keine aktiven Sensoren in InfluxDB gefunden.</Typography>
        </Paper>
      ) : (
        <div style={{ display: "flex", gap: 15, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
          {visibleSensors.map(({ device, kanaele }) => {
            const cardMetrics = MAPPING_METRIC_OPTIONS.filter(m => m.value !== "Spannung");
            const visibleKanaele = kanaele.filter(k => shouldShowKanal(k.kanal));
            const visibleMetricsExist = cardMetrics.some(m => shouldShowMetric(m.value));
            if (!visibleMetricsExist || visibleKanaele.length === 0) return null;
            return (
              <Paper key={device} elevation={1} onClick={() => setDetailDevice(device)}
                style={{ padding: 10, backgroundColor: "#fff", borderRadius: 8, cursor: "pointer",
                  minWidth: isMobile ? "100%" : 260, flex: isMobile ? "1 1 100%" : "1 1 280px",
                  transition: "transform 0.15s, box-shadow 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.01)"; e.currentTarget.style.boxShadow = "0 6px 12px rgba(0,0,0,0.1)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)";    e.currentTarget.style.boxShadow = ""; }}>
                <Box display="flex" alignItems="center" gap={1} sx={{ mb: 1 }}>
                  <DeviceHubIcon style={{ color: PRIMARY_COLOR, fontSize: "0.9rem" }} />
                  <Typography variant="subtitle2" style={{ fontWeight: 600, color: PRIMARY_COLOR, fontSize: "0.85rem" }}>{device}</Typography>
                  <Typography variant="caption" style={{ color: "#888", flex: 1, textAlign: "right" }}>{visibleKanaele.length} Kanäle</Typography>
                </Box>
                <Divider style={{ marginBottom: 8, backgroundColor: "#e0e0e0" }} />
                {visibleKanaele.map(k => (
                  <Box key={k.kanal} sx={{ mb: "8px" }}>
                    <Typography variant="caption" style={{ color: "#666", fontWeight: 600 }}>
                      {KANAL_LABELS[k.kanal] || k.kanal} (Kanal {k.kanal})
                    </Typography>
                    {cardMetrics.map(m => {
                      if (!shouldShowMetric(m.value)) return null;
                      const Icon = m.icon;
                      return (
                        <Box key={m.value} display="flex" justifyContent="space-between" alignItems="center" sx={{ mb: "4px", pl: 1 }}>
                          <Box display="flex" alignItems="center" gap={0.8}>
                            <Icon style={{ color: "#888", fontSize: "0.8rem" }} />
                            <Typography variant="caption" style={{ color: "#666" }}>{m.label.split(" ")[0]}:</Typography>
                          </Box>
                          <Box sx={{ bgcolor: "#e0e0e0", px: "8px", py: "2px", borderRadius: "4px", minWidth: 90, textAlign: "center" }}>
                            <Typography variant="caption" style={{ fontWeight: 500, color: "#222" }}>
                              {formatValue(k[m.value], m.decimals, m.unit)}
                            </Typography>
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                ))}
              </Paper>
            );
          })}
        </div>
      )}
    </>
  );
};

// ─── HAUPTANWENDUNG ───────────────────────────────────────────────────────────
function App() {
  const [data, setData]                                     = useState({});
  const [loading, setLoading]                               = useState(true);
  const [selectedChannels, setSelectedChannels]             = useState([]);
  const [selectedMetrics, setSelectedMetrics]               = useState([]);
  const [trendSelectedChannels, setTrendSelectedChannels]   = useState([]);
  const [trendSelectedMetrics, setTrendSelectedMetrics]     = useState([]);
  const [view, setView]                                     = useState("dashboard");
  const [selectedChannel, setSelectedChannel]               = useState(null);
  const [historyData, setHistoryData]                       = useState([]);
  const [selectedMetric, setSelectedMetric]                 = useState("Strom");
  const [timeRange, setTimeRange]                           = useState("5m");
  const [isMouseOverGraph, setIsMouseOverGraph]             = useState(false);
  const [orderedChannels, setOrderedChannels]               = useState([]);
  const [voltages, setVoltages]                             = useState({ L1: 0, L2: 0, L3: 0 });
  const isMobile = useMediaQuery("(max-width:600px)");

  useEffect(() => {
    const params    = new URLSearchParams(window.location.search);
    const viewParam = params.get("view");
    if (["config", "graphMenu", "dashboard", "energy", "mapping"].includes(viewParam)) setView(viewParam);
  }, []);

  useEffect(() => {
    axios.get(`${API_BASE_URL}/config`)
      .then(res => {
        const keys = Object.keys(res.data).filter(k => !k.startsWith("L"));
        setOrderedChannels(keys.length > 0 ? keys : Array.from({ length: 18 }, (_, i) => `CH${i + 1}`));
      })
      .catch(() => setOrderedChannels(Array.from({ length: 18 }, (_, i) => `CH${i + 1}`)));
  }, []);

  const fetchVoltages = async () => {
    try { const res = await axios.get(`${API_BASE_URL}/voltages`); setVoltages(res.data); }
    catch (err) { console.error("Erreur tensions:", err); }
  };

  useEffect(() => {
    fetchVoltages();
    const iv = setInterval(fetchVoltages, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try { const res = await axios.get(`${API_BASE_URL}/data`); setData(res.data); setLoading(false); }
      catch (err) { console.error(err); setLoading(false); }
    };
    fetchData();
    const iv = setInterval(fetchData, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (view !== "graphDetail" || !selectedChannel || isMouseOverGraph) return;
    const update = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/history/${selectedChannel}?time=${timeRange}`);
        if (res.data?.data) setHistoryData(res.data.data);
      } catch (err) { console.error("Erreur historique:", err); }
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [view, selectedChannel, timeRange, isMouseOverGraph]);

  const handleOpenGraph = (channel) => { setSelectedChannel(channel); setView("graphDetail"); };

  const handleChannelChange      = useCallback(e => setSelectedChannels(e.target.value), []);
  const handleSelectAllChannels  = useCallback(() => setSelectedChannels(prev => prev.length === orderedChannels.length ? [] : [...orderedChannels]), [orderedChannels]);
  const handleMetricChange       = useCallback(e => setSelectedMetrics(e.target.value), []);
  const handleSelectAllMetrics   = useCallback(() => setSelectedMetrics(prev => prev.length === METRIC_OPTIONS.length ? [] : METRIC_OPTIONS.map(m => m.value)), []);
  const resetFilters             = useCallback(() => { setSelectedChannels([]); setSelectedMetrics([]); }, []);

  const handleTrendChannelChange     = useCallback(e => setTrendSelectedChannels(e.target.value), []);
  const handleTrendSelectAllChannels = useCallback(() => setTrendSelectedChannels(prev => prev.length === orderedChannels.length ? [] : [...orderedChannels]), [orderedChannels]);
  const handleTrendMetricChange      = useCallback(e => setTrendSelectedMetrics(e.target.value), []);
  const handleTrendSelectAllMetrics  = useCallback(() => setTrendSelectedMetrics(prev => prev.length === METRIC_OPTIONS.length ? [] : METRIC_OPTIONS.map(m => m.value)), []);
  const resetTrendFilters            = useCallback(() => { setTrendSelectedChannels([]); setTrendSelectedMetrics([]); }, []);

  const shouldShowChannel      = ch  => selectedChannels.length === 0      || selectedChannels.includes(ch);
  const shouldShowMetric       = key => selectedMetrics.length === 0       || selectedMetrics.includes(key);
  const shouldShowTrendChannel = ch  => trendSelectedChannels.length === 0 || trendSelectedChannels.includes(ch);
  const shouldShowTrendMetric  = key => trendSelectedMetrics.length === 0  || trendSelectedMetrics.includes(key);

  const grafanaUrl = "http://192.168.1.20:3000/d/adkdpz6/energie?orgId=1&from=now-30m&to=now&timezone=browser&var-Kanal=CH1&refresh=5s";

  // ── NavBar ──
  const NavBar = () => (
    <Paper elevation={2} style={{ padding: isMobile ? "8px 12px" : "8px 20px", marginBottom: 20, borderRadius: 10, backgroundColor: "#fff" }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={isMobile ? 1 : 0}>
        <Box display="flex" alignItems="center" gap={1}>
          <DashboardIcon style={{ color: PRIMARY_COLOR }} />
          <Typography variant="h6" style={{ fontWeight: 600, fontSize: isMobile ? "1rem" : "1.25rem" }}>Energy Monitor</Typography>
        </Box>
        <Box display="flex" gap={1}>
          {[
            { key: "dashboard", label: "Echtzeit", icon: <DashboardIcon /> },
            { key: "graphMenu", label: "Trends",   icon: <ShowChartIcon /> },
          ].map(btn => (
            <Button key={btn.key} variant={view === btn.key ? "contained" : "outlined"} startIcon={btn.icon}
              onClick={() => setView(btn.key)}
              style={{ borderRadius: 20, fontSize: isMobile ? "0.7rem" : undefined, padding: isMobile ? "4px 8px" : undefined, textTransform: "none" }}
              size={isMobile ? "small" : "medium"}>{btn.label}</Button>
          ))}
          <Button variant="outlined" startIcon={<AccessTimeIcon />} onClick={() => window.open(STARTSEITE_URL, "_blank")}
            style={{ borderRadius: 20, fontSize: isMobile ? "0.7rem" : undefined, padding: isMobile ? "4px 8px" : undefined, borderColor: "#e67e22", color: "#e67e22", textTransform: "none" }}
            size={isMobile ? "small" : "medium"}>Startseite</Button>
        </Box>
      </Box>
    </Paper>
  );

  // ── Value Row ──
  const ValueRow = ({ metric, value, useTrendFilter = false }) => {
    if (!(useTrendFilter ? shouldShowTrendMetric(metric.value) : shouldShowMetric(metric.value))) return null;
    const Icon = metric.icon;
    return (
      <Box display="flex" justifyContent="space-between" alignItems="center" sx={{ mb: "6px" }}>
        <Box display="flex" alignItems="center" gap={0.8}>
          <Icon style={{ color: "#888", fontSize: "0.85rem" }} />
          <Typography variant="caption" style={{ color: "#666" }}>
            {metric.value === "CosinusPhi" ? "Cosinus Phi:" : metric.label.split(" ")[0] + ":"}
          </Typography>
        </Box>
        <Box sx={{ bgcolor: "#e0e0e0", px: "8px", py: "2px", borderRadius: "4px", minWidth: 100, textAlign: "center" }}>
          <Typography variant="caption" style={{ fontWeight: 500, color: "#222" }}>
            {formatValue(value, metric.decimals, metric.unit)}
          </Typography>
        </Box>
      </Box>
    );
  };

  // ── Channel Card ──
  const ChannelCard = ({ channel, useTrendFilter = false }) => {
    const channelData = data[channel] || {};
    const label       = channelData.Label || channel;
    const hasVisible  = METRIC_OPTIONS.some(m => useTrendFilter ? shouldShowTrendMetric(m.value) : shouldShowMetric(m.value));
    if (!hasVisible) return null;
    return (
      <Paper elevation={1} style={{ padding: 10, backgroundColor: "#fff", borderRadius: 8, marginBottom: 10 }}>
        <Box display="flex" alignItems="center" gap={1} sx={{ mb: 1 }}>
          <DeviceHubIcon style={{ color: PRIMARY_COLOR, fontSize: "0.9rem" }} />
          <Typography variant="subtitle2" style={{ fontWeight: 600, color: PRIMARY_COLOR, fontSize: "0.85rem" }}>{formatChannelName(channel)}</Typography>
          <Typography variant="caption" style={{ color: "#000", fontSize: "0.9rem", fontWeight: 600, flex: 1, textAlign: "right" }}>{label}</Typography>
        </Box>
        <Divider style={{ marginBottom: 8, backgroundColor: "#e0e0e0" }} />
        {METRIC_OPTIONS.map(m => <ValueRow key={m.value} metric={m} value={channelData[m.value]} useTrendFilter={useTrendFilter} />)}
      </Paper>
    );
  };

  // ── Group Section ──
  const GroupSection = ({ channels, title, icon: Icon, useTrendFilter = false }) => {
    const filtered = channels.filter(ch => useTrendFilter ? shouldShowTrendChannel(ch) : shouldShowChannel(ch));
    if (filtered.length === 0) return null;
    return (
      <Paper elevation={2} style={{ flex: 1, padding: 12, background: "#fff", borderRadius: 10 }}>
        <Box display="flex" alignItems="center" justifyContent="center" gap={1} sx={{ mb: "12px" }}>
          <Icon style={{ color: PRIMARY_COLOR, fontSize: "1.1rem" }} />
          <Typography variant="subtitle2" style={{ fontWeight: 600, color: PRIMARY_COLOR, letterSpacing: "0.5px" }}>{title}</Typography>
        </Box>
        {filtered.map(ch => <ChannelCard key={ch} channel={ch} useTrendFilter={useTrendFilter} />)}
      </Paper>
    );
  };

  // ── Dashboard ──
  const DashboardView = () => {
    const hasActiveFilters = selectedChannels.length > 0 || selectedMetrics.length > 0;
    const chunkSize = Math.ceil(orderedChannels.length / 3);
    const group1 = orderedChannels.slice(0, chunkSize);
    const group2 = orderedChannels.slice(chunkSize, chunkSize * 2);
    const group3 = orderedChannels.slice(chunkSize * 2);

    return (
      <>
        <Paper elevation={2} style={{ padding: "12px 20px", marginBottom: 20, borderRadius: 10, backgroundColor: "#fff" }}>
          <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
            <Box display="flex" alignItems="center" gap={1.5}>
              <DashboardIcon style={{ color: PRIMARY_COLOR, fontSize: "1.8rem" }} />
              <Typography variant="h5" style={{ fontWeight: 600, color: "#333" }}>Live Daten</Typography>
            </Box>
            <FilterBar selectedChannels={selectedChannels} selectedMetrics={selectedMetrics}
              onChannelChange={handleChannelChange} onSelectAllChannels={handleSelectAllChannels}
              onMetricChange={handleMetricChange} onSelectAllMetrics={handleSelectAllMetrics}
              onResetFilters={resetFilters} hasActiveFilters={hasActiveFilters}
              orderedChannels={orderedChannels} metricOptions={METRIC_OPTIONS} mobileDrawer />
            <Button variant="outlined" href={grafanaUrl} target="_blank" startIcon={<TrendingUpIcon />}
              style={{ borderColor: PRIMARY_COLOR, color: PRIMARY_COLOR, borderRadius: 20, textTransform: "none" }}>
              Grafana Dashboard
            </Button>
          </Box>
        </Paper>

        {/* Spannungen */}
        <Box display="flex" gap={2} sx={{ mb: "25px", flexDirection: isMobile ? "column" : "row" }}>
          {[{ phase: "Phase 1", voltage: voltages.L1, label: "Spannung L1" },
            { phase: "Phase 2", voltage: voltages.L2, label: "Spannung L2" },
            { phase: "Phase 3", voltage: voltages.L3, label: "Spannung L3" }].map(({ phase, voltage, label }) => (
            <Paper key={phase} elevation={2} style={{ flex: 1, padding: 15, backgroundColor: "#fff", borderRadius: 10, textAlign: "center" }}>
              <Box display="flex" alignItems="center" justifyContent="center" gap={1}>
                <VoltageSvgIcon style={{ color: PRIMARY_COLOR }} />
                <Typography variant="subtitle1" fontWeight={600}>{phase}</Typography>
              </Box>
              <Typography variant="h3" fontWeight={600}>{formatValue(voltage, 1, "V")}</Typography>
              <Typography variant="caption">{label}</Typography>
            </Paper>
          ))}
        </Box>

        <div style={{ display: "flex", gap: 15, flexDirection: isMobile ? "column" : "row" }}>
          <GroupSection channels={group1} title="Phase 1" icon={ViewModuleIcon} />
          <GroupSection channels={group2} title="Phase 2" icon={ViewModuleIcon} />
          <GroupSection channels={group3} title="Phase 3" icon={ViewModuleIcon} />
        </div>
      </>
    );
  };

  // ── Trends Menü ──
  const GraphMenu = () => {
    const chunkSize = Math.ceil(orderedChannels.length / 3);
    const group1    = orderedChannels.slice(0, chunkSize);
    const group2    = orderedChannels.slice(chunkSize, chunkSize * 2);
    const group3    = orderedChannels.slice(chunkSize * 2);
    const hasTrendActiveFilters = trendSelectedChannels.length > 0 || trendSelectedMetrics.length > 0;

    const ChannelGraphCard = ({ channel }) => {
      const channelData = data[channel] || {};
      const label = channelData.Label || channel;
      if (!shouldShowTrendChannel(channel)) return null;
      return (
        <Paper elevation={0} onClick={() => handleOpenGraph(channel)}
          style={{ padding: "24px 12px 20px", backgroundColor: "#fff", borderRadius: 16, marginBottom: 16,
            cursor: "pointer", textAlign: "center", border: "1px solid #000",
            transition: "transform 0.2s, box-shadow 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.05)" }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.01)"; e.currentTarget.style.boxShadow = "0 6px 12px rgba(0,0,0,0.1)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)";    e.currentTarget.style.boxShadow = "0 2px 4px rgba(0,0,0,0.05)"; }}>
          <Box display="flex" flexDirection="column" alignItems="center" gap={1.5}>
            <ElectricalServicesIcon style={{ color: PRIMARY_COLOR, fontSize: "3rem" }} />
            <Typography variant="h6" style={{ fontWeight: 600, color: PRIMARY_COLOR, fontSize: "1rem" }}>{formatChannelName(channel)}</Typography>
            <Typography variant="caption" style={{ color: "#000", fontSize: "0.85rem", fontWeight: 600 }}>{label}</Typography>
          </Box>
        </Paper>
      );
    };

    const GroupGraphSection = ({ channels, title }) => {
      const visible = channels.filter(ch => shouldShowTrendChannel(ch));
      if (visible.length === 0) return null;
      return (
        <Paper elevation={0} style={{ flex: 1, padding: "16px 8px", background: "#fff", borderRadius: 12, border: "1px solid #e0e0e0" }}>
          <Box display="flex" alignItems="center" justifyContent="center" gap={1} sx={{ mb: "16px" }}>
            <ViewModuleIcon style={{ color: PRIMARY_COLOR, fontSize: "1.2rem" }} />
            <Typography variant="subtitle2" style={{ fontWeight: 700, color: PRIMARY_COLOR, letterSpacing: "1px", fontSize: "0.75rem" }}>{title}</Typography>
          </Box>
          {visible.map(ch => <ChannelGraphCard key={ch} channel={ch} />)}
        </Paper>
      );
    };

    return (
      <>
        <Paper elevation={2} style={{ padding: "12px 20px", marginBottom: 20, borderRadius: 10, backgroundColor: "#fff" }}>
          <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
            <Box display="flex" alignItems="center" gap={1.5}>
              <ShowChartIcon style={{ color: PRIMARY_COLOR, fontSize: "1.8rem" }} />
              <Typography variant="h5" style={{ fontWeight: 600, color: "#333" }}>Trends - Kanalübersicht</Typography>
            </Box>
            <FilterBar selectedChannels={trendSelectedChannels} selectedMetrics={trendSelectedMetrics}
              onChannelChange={handleTrendChannelChange} onSelectAllChannels={handleTrendSelectAllChannels}
              onMetricChange={handleTrendMetricChange} onSelectAllMetrics={handleTrendSelectAllMetrics}
              onResetFilters={resetTrendFilters} hasActiveFilters={hasTrendActiveFilters}
              orderedChannels={orderedChannels} metricOptions={METRIC_OPTIONS} />
          </Box>
        </Paper>
        <div style={{ display: "flex", gap: 16, flexDirection: isMobile ? "column" : "row" }}>
          <GroupGraphSection channels={group1} title="Phase 1" />
          <GroupGraphSection channels={group2} title="Phase 2" />
          <GroupGraphSection channels={group3} title="Phase 3" />
        </div>
      </>
    );
  };

  if (loading || orderedChannels.length === 0) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh" bgcolor="#f5f5f5">
        <Typography variant="h5" color={PRIMARY_COLOR}>Laden...</Typography>
      </Box>
    );
  }

  return (
    <div style={{ padding: "15px 40px", backgroundColor: "#f0f0f0", minHeight: "100vh" }}>
      <NavBar />
      {view === "dashboard"   && <DashboardView />}
      {view === "graphMenu"   && <GraphMenu />}
      {view === "graphDetail" && (
        <GraphDetail
          selectedChannel={selectedChannel}
          historyData={historyData}
          isMouseOverGraph={isMouseOverGraph}
          setIsMouseOverGraph={setIsMouseOverGraph}
          selectedMetric={selectedMetric}
          setSelectedMetric={setSelectedMetric}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
          onBack={() => setView("graphMenu")}
        />
      )}
      {view === "config"  && <ChannelConfigManager />}
      {view === "energy"  && <EnergyManager />}
      {view === "mapping" && <MappingManager />}
    </div>
  );
}

export default App;