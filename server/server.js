const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { InfluxDB, Point } = require("@influxdata/influxdb-client");

const app = express();
app.use(cors());
app.use(express.json());

// ========== INFLUXDB ==========
const INFLUX_URL    = "http://192.168.1.20:8086";
const INFLUX_TOKEN  = "k_L6krRa3thn59MPAVH8bID-oO65diQfYS9ayMMrss53kGULbrE63Jw-a_y4e8xyZbzaqG_nindLwtNbLI48ZA==";
const INFLUX_ORG    = "home";
const INFLUX_BUCKET = "ACAL";

const influxDB = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const queryApi = influxDB.getQueryApi(INFLUX_ORG);
const writeApi = influxDB.getWriteApi(INFLUX_ORG, INFLUX_BUCKET);

// ========== MESSKOFFER ==========
const MESSE_IP = "192.168.1.7";
const MESSE_ID = "51105";

const channelsList = Array.from({ length: 18 }, (_, i) => `CH${i + 1}`);

// ========== MAPPING CH -> Device+Kanal ==========
let channelMapping = {};

function initMapping() {
    for (let i = 0; i < 18; i++) {
        const ch       = `CH${i + 1}`;
        const sensor   = Math.floor(i / 4) + 1;
        const kanalIdx = i % 4;
        const kanals   = ["1", "2", "3", "4"];
        channelMapping[ch] = {
            device: `Sensor${sensor}`,
            kanal:  kanals[kanalIdx]
        };
    }
    console.log("[Mapping] Initialisiert (Standard: 4 Kanäle pro Sensor)");
}
initMapping();

// ========== KONFIGURATION ==========
let channelConfig = {};

function getDefaultHoechstwert(ch) {
    return ch === "CH1" || ch === "CH7" || ch === "CH13" ? 64 : 32;
}

function initConfig() {
    for (const ch of channelsList) {
        channelConfig[ch] = {
            label:       ch,
            schwellwert: 0,
            hoechstwert: getDefaultHoechstwert(ch),
            updatedAt:   0
        };
    }
}
initConfig();

// ========== MESSKOFFER CGI HELPERS ==========

async function getLabelsFromMesskoffer() {
    const url = `http://${MESSE_IP}/get_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&field=label`;
    try {
        console.log(`[Messkoffer] GET labels: ${url}`);
        const res  = await axios.get(url, { timeout: 5000 });
        const raw  = res.data;
        const parts = typeof raw === "string"
            ? raw.split(";").map(v => {
                try { return decodeURIComponent(v.replace(/\+/g, " ")); }
                catch { return v; }
              })
            : [];
        const result = {};
        for (let i = 0; i < 18; i++) {
            result[`CH${i + 1}`] = (parts[i] !== undefined && parts[i] !== "") ? parts[i] : `CH${i + 1}`;
        }
        return result;
    } catch (err) {
        console.error("[Messkoffer] Fehler Labels:", err.message);
        return null;
    }
}

async function getScaleendFromMesskoffer() {
    const url = `http://${MESSE_IP}/get_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&field=scaleend`;
    try {
        const res   = await axios.get(url, { timeout: 5000 });
        const parts = typeof res.data === "string" ? res.data.split(";") : [];
        const result = {};
        for (let i = 0; i < 18; i++) {
            const val = parseFloat(parts[i]);
            result[`CH${i + 1}`] = !isNaN(val) ? val : 32;
        }
        return result;
    } catch (err) {
        console.error("[Messkoffer] Fehler Scaleend:", err.message);
        return null;
    }
}

async function getThresholdFromMesskoffer() {
    const url = `http://${MESSE_IP}/get_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&field=threshold`;
    try {
        const res   = await axios.get(url, { timeout: 5000 });
        const parts = typeof res.data === "string" ? res.data.split(";") : [];
        const result = {};
        for (let i = 0; i < 18; i++) {
            const val = parseFloat(parts[i]);
            result[`CH${i + 1}`] = !isNaN(val) ? val / 1000 : 0;
        }
        return result;
    } catch (err) {
        console.error("[Messkoffer] Fehler Threshold:", err.message);
        return null;
    }
}

async function setLabelToMesskoffer(channelNum, label) {
    const idx = channelNum - 1;
    const url = `http://${MESSE_IP}/set_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&label${idx}=${encodeURIComponent(label)}`;
    try {
        await axios.get(url, { timeout: 3000 });
        return true;
    } catch (err) {
        console.error(`[Messkoffer] Fehler label${idx}:`, err.message);
        return false;
    }
}

async function setScaleendToMesskoffer(channelNum, value) {
    const idx = channelNum - 1;
    const url = `http://${MESSE_IP}/set_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&scaleend${idx}=${value}`;
    try {
        await axios.get(url, { timeout: 3000 });
        return true;
    } catch (err) {
        console.error(`[Messkoffer] Fehler scaleend${idx}:`, err.message);
        return false;
    }
}

async function setThresholdToMesskoffer(channelNum, valueAmps) {
    const idx       = channelNum - 1;
    const threshVal = Math.round(valueAmps * 1000);
    const url = `http://${MESSE_IP}/set_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&threshold${idx}=${threshVal}`;
    try {
        await axios.get(url, { timeout: 3000 });
        return true;
    } catch (err) {
        console.error(`[Messkoffer] Fehler threshold${idx}:`, err.message);
        return false;
    }
}

async function getEnergiesFromMesskoffer() {
    const url = `http://${MESSE_IP}/get_energy_values.cgi?id=${MESSE_ID}`;
    try {
        console.log(`[Messkoffer] GET energies: ${url}`);
        const res    = await axios.get(url, { timeout: 5000 });
        const raw    = res.data;
        const temporary = {};
        if (typeof raw === "string") {
            const values = raw.split(";").map(v => parseFloat(v));
            // ✅ Index 0 = compteur d'inscription (ignoré).
            // Index 1-18  = énergies cumulées (ignorées, non désirées).
            // Index 19-36 = énergies temporaires des 18 derniers canaux (celles qu'on veut).
            for (let i = 0; i < 18; i++) {
                temporary[`CH${i + 1}`] = (values[19 + i] || 0) / 10000;
            }
        }
        return { temporary };
    } catch (err) {
        console.error("[Messkoffer] Fehler Energies:", err.message);
        return { temporary: {} };
    }
}

async function setEnergyToMesskoffer(channelNum, value) {
    const messeValue = Math.round(value * 10000);
    const url = `http://${MESSE_IP}/em_set_counters.cgi?id=${MESSE_ID}&channel=${channelNum}&kwh=${messeValue}`;
    try {
        console.log(`[Messkoffer Energy] SET ch${channelNum}=${value}kWh (${messeValue}): ${url}`);
        const res = await axios.get(url, { timeout: 3000 });
        console.log(`[Messkoffer Energy] Antwort: ${res.data}`);
        return true;
    } catch (err) {
        console.error(`[Messkoffer Energy] Fehler ch${channelNum}:`, err.message);
        return false;
    }
}

// ========== INIT CONFIG DEPUIS MESSKOFFER ==========
async function initConfigFromMesskoffer() {
    const [labels, scaleends, thresholds] = await Promise.all([
        getLabelsFromMesskoffer(),
        getScaleendFromMesskoffer(),
        getThresholdFromMesskoffer()
    ]);
    for (const ch of channelsList) {
        channelConfig[ch] = {
            label:       labels?.[ch]     || ch,
            hoechstwert: scaleends?.[ch]  || getDefaultHoechstwert(ch),
            schwellwert: thresholds?.[ch] || 0,
            updatedAt:   Date.now()
        };
    }
    console.log("[Config] Aus Messkoffer geladen");
}
initConfigFromMesskoffer();

// ========== ENERGIE CACHE ==========
let energyConfig = {};
function initEnergyConfig() {
    for (const ch of channelsList) {
        // ✅ Uniquement le compteur temporaire (18 dernières valeurs du CGI), pas de cumulé.
        energyConfig[ch] = { temporary: 0, updatedAt: 0 };
    }
}
initEnergyConfig();

// ========== ROUTES MAPPING (CH -> Sensor/Kanal, inchangé) ==========

app.get("/mapping", (req, res) => {
    res.json(channelMapping);
});

app.post("/mapping", (req, res) => {
    const updates = req.body;
    if (typeof updates !== "object") return res.status(400).json({ error: "JSON-Objekt erwartet" });
    for (const [ch, map] of Object.entries(updates)) {
        if (!channelsList.includes(ch)) continue;
        if (map.device && map.kanal) {
            channelMapping[ch] = { device: map.device, kanal: String(map.kanal) };
        }
    }
    console.log("[Mapping] Aktualisiert:", channelMapping);
    res.json({ success: true, mapping: channelMapping });
});

// ========== ROUTE DECOUVERTE DYNAMIQUE SENSOR/KANAL (nouvel onglet Mapping) ==========
// Interroge InfluxDB sans limite de temps fixe pour lister tous les Device/Kanal
// réellement présents dans le bucket, avec leurs dernières valeurs Strom / Wirkleistung / Energie.

app.get("/sensors-discovery", async (req, res) => {
    try {
        const fluxQuery = `
            from(bucket: "${INFLUX_BUCKET}")
              |> range(start: 0)
              |> filter(fn: (r) => r["_measurement"] == "sensoren")
              |> filter(fn: (r) => r["_field"] == "Strom" or r["_field"] == "Wirkleistung" or r["_field"] == "Energie")
              |> last()
        `;

        const rows = await queryApi.collectRows(fluxQuery);

        // Regrouper par Device -> Kanal -> { Strom, Wirkleistung, Energie, time }
        const bySensor = {};

        rows.forEach(row => {
            const device = row.Device;
            const kanal  = String(row.Kanal);
            const field  = row._field;

            if (!device || device === "Sensor0") return; // Sensor0 réservé aux tensions, on l'exclut ici

            if (!bySensor[device]) bySensor[device] = {};
            if (!bySensor[device][kanal]) {
                bySensor[device][kanal] = { kanal, Strom: null, Wirkleistung: null, Energie: null, updatedAt: null };
            }

            if (field === "Strom")        bySensor[device][kanal].Strom        = row._value;
            else if (field === "Wirkleistung") bySensor[device][kanal].Wirkleistung = row._value;
            else if (field === "Energie")      bySensor[device][kanal].Energie      = row._value;

            const t = new Date(row._time).getTime();
            if (!bySensor[device][kanal].updatedAt || t > bySensor[device][kanal].updatedAt) {
                bySensor[device][kanal].updatedAt = t;
            }
        });

        // Construire un résultat trié : sensors par numéro, kanaux par numéro
        const sensorNames = Object.keys(bySensor).sort((a, b) => {
            const na = parseInt(a.replace("Sensor", ""), 10) || 0;
            const nb = parseInt(b.replace("Sensor", ""), 10) || 0;
            return na - nb;
        });

        const result = sensorNames.map(device => {
            const kanaux = Object.values(bySensor[device]).sort((a, b) => parseInt(a.kanal, 10) - parseInt(b.kanal, 10));
            return { device, kanaele: kanaux };
        });

        res.json({ sensors: result, count: result.length });
    } catch (err) {
        console.error("/sensors-discovery error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTE HISTORIQUE DIRECT PAR SENSOR/KANAL (pour onglet Mapping) ==========
// Interroge InfluxDB directement avec Device + Kanal, sans passer par channelMapping/CH.

app.get("/sensor-history/:device/:kanal", async (req, res) => {
    const { device, kanal } = req.params;
    const metric = req.query.metric || "Strom";
    const allowedMetrics = ["Strom", "Wirkleistung", "Energie"];
    if (!allowedMetrics.includes(metric)) {
        return res.status(400).json({ error: "Ungültige Messgröße" });
    }

    let duration = req.query.time || "1h";
    if (duration.includes("d") && parseInt(duration) > 1) duration = "24h";

    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: -${duration})
          |> filter(fn: (r) => r._measurement == "sensoren")
          |> filter(fn: (r) => r.Device == "${device}")
          |> filter(fn: (r) => r.Kanal  == "${kanal}")
          |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "Energie")
          |> aggregateWindow(every: 10s, fn: mean, createEmpty: false)
          |> sort(columns: ["_time"])
    `;

    try {
        const rows         = await queryApi.collectRows(fluxQuery);
        const pointsByTime = {};
        rows.forEach(row => {
            const t = row._time;
            if (!pointsByTime[t]) pointsByTime[t] = { time: t };
            if      (row._field === "Strom")        pointsByTime[t].Strom        = row._value;
            else if (row._field === "Wirkleistung") pointsByTime[t].Wirkleistung = row._value;
            else if (row._field === "Energie")      pointsByTime[t].Energie      = row._value;
        });
        const data = Object.values(pointsByTime).sort((a, b) => new Date(a.time) - new Date(b.time));
        res.json({ device, kanal, metric, data });
    } catch (error) {
        console.error(`/sensor-history ${device}/${kanal} error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ========== ROUTES MESSKOFFER DIREKT ==========

app.get("/messkoffer/labels", async (req, res) => {
    const labels = await getLabelsFromMesskoffer();
    if (!labels) return res.status(500).json({ error: "Messkoffer nicht erreichbar" });
    res.json(labels);
});

app.get("/messkoffer/scaleend", async (req, res) => {
    const scaleends = await getScaleendFromMesskoffer();
    if (!scaleends) return res.status(500).json({ error: "Messkoffer nicht erreichbar" });
    res.json(scaleends);
});

app.get("/messkoffer/threshold", async (req, res) => {
    const thresholds = await getThresholdFromMesskoffer();
    if (!thresholds) return res.status(500).json({ error: "Messkoffer nicht erreichbar" });
    res.json(thresholds);
});

app.post("/messkoffer/reload", async (req, res) => {
    await initConfigFromMesskoffer();
    res.json({ success: true, config: channelConfig });
});

// ========== ROUTES CONFIG ==========

app.get("/config", (req, res) => {
    try {
        const result = {};
        for (const ch of channelsList) {
            result[ch] = {
                label:       channelConfig[ch]?.label       || ch,
                schwellwert: channelConfig[ch]?.schwellwert ?? 0,
                hoechstwert: channelConfig[ch]?.hoechstwert ?? getDefaultHoechstwert(ch)
            };
        }
        res.json(result);
    } catch (err) {
        console.error("/config error:", err);
        res.status(500).json({ error: "Interner Fehler" });
    }
});

app.post("/config", async (req, res) => {
    const updates = req.body;
    if (typeof updates !== "object") return res.status(400).json({ error: "JSON-Objekt erwartet" });

    try {
        for (const [ch, cfg] of Object.entries(updates)) {
            if (!channelsList.includes(ch)) continue;

            const old        = channelConfig[ch];
            const newLabel   = cfg.label       !== undefined ? cfg.label                   : old.label;
            const newSchwell = cfg.schwellwert  !== undefined ? parseFloat(cfg.schwellwert) : old.schwellwert;
            const newHoe     = cfg.hoechstwert  !== undefined ? parseFloat(cfg.hoechstwert) : old.hoechstwert;
            const chNum      = parseInt(ch.substring(2), 10);

            if (cfg.label !== undefined && cfg.label !== old.label)
                await setLabelToMesskoffer(chNum, newLabel);
            if (cfg.schwellwert !== undefined && parseFloat(cfg.schwellwert) !== old.schwellwert)
                await setThresholdToMesskoffer(chNum, newSchwell);
            if (cfg.hoechstwert !== undefined && parseFloat(cfg.hoechstwert) !== old.hoechstwert)
                await setScaleendToMesskoffer(chNum, newHoe);

            const point = new Point("sensoren_config")
                .tag("channel", ch)
                .tag("label",   newLabel)
                .floatField("schwellwert", newSchwell)
                .floatField("hoechstwert", newHoe)
                .timestamp(new Date());
            writeApi.writePoint(point);

            channelConfig[ch] = { label: newLabel, schwellwert: newSchwell, hoechstwert: newHoe, updatedAt: Date.now() };
        }
        await writeApi.flush();

        const result = {};
        for (const ch of channelsList) {
            result[ch] = { label: channelConfig[ch].label, schwellwert: channelConfig[ch].schwellwert, hoechstwert: channelConfig[ch].hoechstwert };
        }
        res.json({ success: true, config: result });
    } catch (err) {
        console.error("[POST /config] Fehler:", err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTES ENERGIE ==========

app.get("/energy-values", async (req, res) => {
    try {
        const { temporary } = await getEnergiesFromMesskoffer();

        const result = {};
        for (const ch of channelsList) {
            result[ch] = {
                label:     channelConfig[ch]?.label || ch,
                // ✅ Uniquement les 18 dernières valeurs (temporaires) du CGI Messkoffer,
                // jamais les valeurs cumulées d'InfluxDB.
                temporary: temporary[ch] ?? energyConfig[ch]?.temporary ?? 0,
                updatedAt: Date.now()
            };

            energyConfig[ch] = {
                temporary: result[ch].temporary,
                updatedAt: result[ch].updatedAt
            };
        }

        res.json(result);
    } catch (err) {
        console.error("/energy-values error:", err);
        res.status(500).json({ error: "Interner Fehler" });
    }
});

// ✅ CORRECTION : délai 2s avant relecture Messkoffer
app.post("/energy-values/set", async (req, res) => {
    const updates = req.body;
    if (typeof updates !== "object") return res.status(400).json({ error: "JSON-Objekt erwartet" });

    try {
        for (const [ch, cfg] of Object.entries(updates)) {
            if (!channelsList.includes(ch)) continue;
            const oldTemp = energyConfig[ch]?.temporary || 0;
            const newTemp = cfg.temporary !== undefined ? parseFloat(cfg.temporary) : oldTemp;
            if (newTemp === oldTemp) continue;

            const chNum = parseInt(ch.substring(2), 10);

            // 1. Envoyer au Messkoffer
            await setEnergyToMesskoffer(chNum, newTemp);

            // 2. Ecrire dans InfluxDB via mapping
            const map = channelMapping[ch];
            if (map) {
                const point = new Point("sensoren")
                    .tag("Device", map.device)
                    .tag("Kanal",  map.kanal)
                    .floatField("Energie", newTemp)
                    .timestamp(new Date());
                writeApi.writePoint(point);
            }

            // ✅ Mettre à jour le cache local immédiatement
            energyConfig[ch] = { ...energyConfig[ch], temporary: newTemp, updatedAt: Date.now() };
        }
        await writeApi.flush();

        // ✅ Attendre 2s que le Messkoffer traite avant de relire
        await new Promise(resolve => setTimeout(resolve, 2000));

        const { temporary } = await getEnergiesFromMesskoffer();
        const result = {};
        for (const ch of channelsList) {
            result[ch] = {
                label:     channelConfig[ch]?.label || ch,
                // ✅ Si Messkoffer retourne encore 0, on garde la valeur du cache local
                temporary: (temporary[ch] && temporary[ch] > 0)
                    ? temporary[ch]
                    : energyConfig[ch]?.temporary ?? 0,
                updatedAt: Date.now()
            };
            // ✅ Mettre à jour le cache avec la valeur confirmée
            energyConfig[ch] = {
                temporary: result[ch].temporary,
                updatedAt: result[ch].updatedAt
            };
        }
        res.json({ success: true, config: result });
    } catch (err) {
        console.error("[POST /energy-values/set] Fehler:", err);
        res.status(500).json({ error: err.message });
    }
});

// ========== CALCUL SCHEINLEISTUNG / BLINDLEISTUNG via P et cosφ ==========
// S = P / cosφ ; Q = √(S² - P²). Évite la division par zéro / cosφ trop faible.
function computeApparentAndReactive(P, cosPhi) {
    if (P === null || P === undefined || isNaN(P)) return { S: null, Q: null };
    if (cosPhi === null || cosPhi === undefined || isNaN(cosPhi) || Math.abs(cosPhi) < 0.01) {
        return { S: null, Q: null };
    }
    const S = P / cosPhi;
    const Q = Math.sqrt(Math.max(0, S * S - P * P));
    return { S, Q };
}

// ========== ROUTE DATA (Echtzeit) ==========
// ✅ Source désormais : measurement "mego", Device "mE180" (données Node-RED),
// filtrées par Kanal=CHx ET Label=<label CGI actuel du canal>.
// Spannung reste via /voltages (CGI Messkoffer). Energie reste via cache/CGI (jamais mego).

const MEGO_MEASUREMENT = "mego";
const MEGO_DEVICE      = "mE180";

app.get("/data", async (req, res) => {
    try {
        // ✅ énergies depuis Messkoffer (inchangé)
        const { temporary: messeEnergy } = await getEnergiesFromMesskoffer();

        // ✅ tensions depuis Messkoffer CGI (inchangé, indépendant de mego)
        let voltagesU = { 1: 0, 2: 0, 3: 0 };
        try {
            const url      = `http://${MESSE_IP}/get_live_values.cgi?id=${MESSE_ID}&ch=18`;
            const response = await axios.get(url, { timeout: 5000 });
            const values   = typeof response.data === "string"
                ? response.data.split(";").map(v => parseFloat(v.trim()))
                : [];
            voltagesU = {
                1: !isNaN(values[1]) ? values[1] / 100 : 0,
                2: !isNaN(values[2]) ? values[2] / 100 : 0,
                3: !isNaN(values[3]) ? values[3] / 100 : 0
            };
        } catch (err) {
            console.error("[/data] Fehler Spannungen:", err.message);
        }

        // ✅ Une requête Flux par canal, car le filtre Label dépend du label CGI courant
        // de chaque canal (peut différer d'un canal à l'autre).
        const queries = channelsList.map(ch => {
            const label = channelConfig[ch]?.label || ch;
            const safeLabel = label.replace(/"/g, '\\"');
            return `
                from(bucket: "${INFLUX_BUCKET}")
                  |> range(start: -10m)
                  |> filter(fn: (r) => r._measurement == "${MEGO_MEASUREMENT}")
                  |> filter(fn: (r) => r.Device == "${MEGO_DEVICE}")
                  |> filter(fn: (r) => r.Kanal  == "${ch}")
                  |> filter(fn: (r) => r.Label  == "${safeLabel}")
                  |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "leistungsfaktor")
                  |> last()
            `;
        });

        const results = await Promise.all(
            queries.map(q => queryApi.collectRows(q).catch(err => {
                console.error("[/data] Flux Fehler:", err.message);
                return [];
            }))
        );

        const byChannel = {};
        channelsList.forEach((ch, idx) => {
            const data_ = {};
            results[idx].forEach(row => {
                if      (row._field === "Strom")          data_.Strom        = row._value;
                else if (row._field === "Wirkleistung")   data_.Wirkleistung = row._value;
                else if (row._field === "leistungsfaktor") data_.CosinusPhi  = row._value;
            });
            byChannel[ch] = data_;
        });

        const result = {};
        for (const ch of channelsList) {
            const chNum     = parseInt(ch.substring(2), 10);
            const voltKanal = chNum <= 3 ? chNum : 1;
            const U = voltagesU[voltKanal] ?? null;
            const influxData = byChannel[ch] || {};
            const I = influxData.Strom        ?? null;
            const P = influxData.Wirkleistung ?? null;
            const cosPhi = influxData.CosinusPhi ?? null;

            result[ch] = {
                Label:        channelConfig[ch]?.label || ch,
                Strom:        I,
                Wirkleistung: P,
                Spannung:     U,
                CosinusPhi:   cosPhi,
                // ✅ Energie : Messkoffer en priorité, cache local ensuite — jamais depuis mego
                Energie_temp: (messeEnergy[ch] && messeEnergy[ch] > 0)
                    ? messeEnergy[ch]
                    : (energyConfig[ch]?.temporary && energyConfig[ch].temporary > 0)
                    ? energyConfig[ch].temporary
                    : null
            };

            // ✅ Scheinleistung / Blindleistung calculées via Wirkleistung et CosinusPhi
            const { S, Q } = computeApparentAndReactive(P, cosPhi);
            result[ch].Scheinleistung = S;
            result[ch].Blindleistung  = Q;
        }

        res.json(result);
    } catch (error) {
        console.error("/data error:", error);
        res.status(500).send("Fehler: " + error.message);
    }
});

// ========== ROUTE HISTORY ==========
// ✅ Source désormais : measurement "mego", Device "mE180", filtré par Kanal=CHx
// et Label=<label CGI actuel du canal>. Energie n'est plus lue depuis InfluxDB ici
// (le Messkoffer/cache local ne fournit pas d'historique, donc Energie_temp n'apparaît
// plus dans l'historique pour les canaux migrés vers mego).

app.get("/history/:channel", async (req, res) => {
    const { channel } = req.params;
    const ch = channel.toUpperCase();
    if (!channelsList.includes(ch)) {
        return res.status(400).json({ error: "Ungültiger Kanal" });
    }

    let duration = req.query.time || "1h";
    if (duration.includes("d") && parseInt(duration) > 1) duration = "24h";

    const label = channelConfig[ch]?.label || ch;
    const safeLabel = label.replace(/"/g, '\\"');

    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: -${duration})
          |> filter(fn: (r) => r._measurement == "${MEGO_MEASUREMENT}")
          |> filter(fn: (r) => r.Device == "${MEGO_DEVICE}")
          |> filter(fn: (r) => r.Kanal  == "${ch}")
          |> filter(fn: (r) => r.Label  == "${safeLabel}")
          |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "leistungsfaktor")
          |> aggregateWindow(every: 10s, fn: mean, createEmpty: false)
          |> sort(columns: ["_time"])
    `;

    try {
        const rows         = await queryApi.collectRows(fluxQuery);
        const pointsByTime = {};
        rows.forEach(row => {
            const t = row._time;
            if (!pointsByTime[t]) pointsByTime[t] = { time: t };
            if      (row._field === "Strom")          pointsByTime[t].Strom        = row._value;
            else if (row._field === "Wirkleistung")   pointsByTime[t].Wirkleistung = row._value;
            else if (row._field === "leistungsfaktor") pointsByTime[t].CosinusPhi  = row._value;
        });
        const data = Object.values(pointsByTime)
            .map(point => {
                const { S, Q } = computeApparentAndReactive(point.Wirkleistung ?? null, point.CosinusPhi ?? null);
                return { ...point, Scheinleistung: S, Blindleistung: Q };
            })
            .sort((a, b) => new Date(a.time) - new Date(b.time));
        res.json({ channel: ch, data });
    } catch (error) {
        console.error(`/history ${ch} error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ========== ROUTE VOLTAGES ==========

app.get("/voltages", async (req, res) => {
    try {
        const url      = `http://${MESSE_IP}/get_live_values.cgi?id=${MESSE_ID}&ch=18`;
        const response = await axios.get(url, { timeout: 5000 });
        const values   = typeof response.data === "string"
            ? response.data.split(";").map(v => parseFloat(v.trim()))
            : [];

        res.json({
            L1: !isNaN(values[1]) ? values[1] / 100 : 0,
            L2: !isNaN(values[2]) ? values[2] / 100 : 0,
            L3: !isNaN(values[3]) ? values[3] / 100 : 0
        });
    } catch (error) {
        console.error("/voltages error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ========== START ==========
app.listen(4000, "0.0.0.0", () => {
    console.log("✅ Server läuft auf Port 4000");
    console.log(`   InfluxDB : ${INFLUX_URL} | Bucket: ${INFLUX_BUCKET}`);
    console.log(`   Messkoffer: ${MESSE_IP} | ID: ${MESSE_ID}`);
    console.log(`   Kanäle: 18 | Mapping: CH1-CH18 → SensorN/Kanal`);
});