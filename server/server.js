const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { InfluxDB, Point } = require("@influxdata/influxdb-client");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Route de healthcheck pour Docker
app.get("/health", (req, res) => res.status(200).send("ok"));

// ========== INFLUXDB ==========
const INFLUX_URL    = process.env.INFLUX_URL;
const INFLUX_TOKEN  = process.env.INFLUX_TOKEN;
const INFLUX_ORG    = process.env.INFLUX_ORG;
const INFLUX_BUCKET = process.env.INFLUX_BUCKET;

if (!INFLUX_TOKEN || !INFLUX_URL || !INFLUX_ORG || !INFLUX_BUCKET) {
    console.error("❌ ERREUR: Variables InfluxDB manquantes. Vérifiez votre fichier .env");
    process.exit(1);
}

const influxDB = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const queryApi = influxDB.getQueryApi(INFLUX_ORG);
const writeApi = influxDB.getWriteApi(INFLUX_ORG, INFLUX_BUCKET);

// ========== MESSKOFFER ==========
const MESSE_IP = process.env.MESSE_IP;
const MESSE_ID = process.env.MESSE_ID;

if (!MESSE_IP || !MESSE_ID) {
    console.error("❌ ERREUR: Variables Messkoffer manquantes. Vérifiez votre fichier .env");
    process.exit(1);
}

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

// ========== KUNDENDATEN LABELS (Bezeichnung par Sensor/Kanal, distinct de la config CH) ==========
let kundenLabels = {};

function getKundenLabelKey(device, kanal) {
    return `${device}_${kanal}`;
}

function getKundenLabel(device, kanal) {
    return kundenLabels[getKundenLabelKey(device, kanal)] || "";
}

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

// ========== ROUTES KUNDENDATEN (Bezeichnung par Sensor/Kanal) ==========

app.get("/kundendaten-labels", (req, res) => {
    res.json(kundenLabels);
});

app.post("/kundendaten-labels", (req, res) => {
    const { device, kanal, label } = req.body;
    if (!device || kanal === undefined || kanal === null) {
        return res.status(400).json({ error: "device und kanal erforderlich" });
    }
    const key = getKundenLabelKey(device, String(kanal));
    kundenLabels[key] = label !== undefined ? String(label) : "";
    console.log(`[Kundendaten] Bezeichnung aktualisiert: ${key} = "${kundenLabels[key]}"`);
    res.json({ success: true, device, kanal: String(kanal), label: kundenLabels[key] });
});

// ========== DECOUVERTE DYNAMIQUE SENSOR/KANAL (FONCTION PARTAGEE) ==========
// ✅ Factorisation : la logique de découverte (groupement Device -> Kanal ->
// dernières valeurs) est commune entre "historique complet" (/sensors-discovery,
// range depuis toujours) et "connecté maintenant" (/sensors-connected, range
// récent). On la met dans une fonction paramétrée par la borne de temps Flux
// (ex: "0" pour tout l'historique, "-2m" pour les 2 dernières minutes),
// pour ne pas dupliquer le code et rester cohérent si la logique évolue.

async function discoverSensors(rangeStart) {
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: ${rangeStart})
          |> filter(fn: (r) => r["_measurement"] == "sensoren")
          |> filter(fn: (r) => r["_field"] == "Strom" or r["_field"] == "Wirkleistung" or r["_field"] == "Energie" or r["_field"] == "Spannung")
          |> last()
    `;

    const rows = await queryApi.collectRows(fluxQuery);

    // Regrouper par Device -> Kanal -> { Strom, Wirkleistung, Spannung, Energie, time }
    const bySensor = {};

    rows.forEach(row => {
        const device = row.Device;
        const kanal  = String(row.Kanal);
        const field  = row._field;

        if (!device) return;

        if (!bySensor[device]) bySensor[device] = {};
        if (!bySensor[device][kanal]) {
            bySensor[device][kanal] = { kanal, Strom: null, Wirkleistung: null, Spannung: null, Energie: null, updatedAt: null };
        }

        if      (field === "Strom")        bySensor[device][kanal].Strom        = row._value;
        else if (field === "Wirkleistung")  bySensor[device][kanal].Wirkleistung = row._value;
        else if (field === "Spannung")      bySensor[device][kanal].Spannung     = row._value;
        else if (field === "Energie")       bySensor[device][kanal].Energie      = row._value;

        const t = new Date(row._time).getTime();
        if (!bySensor[device][kanal].updatedAt || t > bySensor[device][kanal].updatedAt) {
            bySensor[device][kanal].updatedAt = t;
        }
    });

    // Trier : "Netz"/"Sensor0" (tension) en premier, puis Sensor1, Sensor2, ...
    const sensorNames = Object.keys(bySensor).sort((a, b) => {
        const rank = (name) => {
            if (name === "Netz" || name === "Sensor0") return -1;
            const n = parseInt(name.replace("Sensor", ""), 10);
            return isNaN(n) ? 999 : n;
        };
        return rank(a) - rank(b);
    });

    return sensorNames.map(device => {
        const kanaux = Object.values(bySensor[device])
            .sort((a, b) => parseInt(a.kanal, 10) - parseInt(b.kanal, 10))
            .map(k => ({ ...k, Bezeichnung: getKundenLabel(device, k.kanal) }));
        return { device, kanaele: kanaux };
    });
}

// ========== ROUTE HISTORIQUE COMPLET (onglet Mapping) ==========
// Tous les Device/Kanal ayant EU AU MOINS UNE FOIS des données (depuis toujours).
// C'est la vue "historique" existante, inchangée.

app.get("/sensors-discovery", async (req, res) => {
    try {
        const result = await discoverSensors("0");
        res.json({ sensors: result, count: result.length });
    } catch (err) {
        console.error("/sensors-discovery error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ========== ROUTE "CAPTEURS RÉELLEMENT CONNECTÉS" (via Node-RED) ==========
// ✅ MODIFIÉ : l'ancienne heuristique basée sur une fenêtre de temps InfluxDB
// (ex: "actif dans les 10 dernières secondes") ne fonctionne pas de façon fiable,
// car le flux Node-RED Volt1000S interroge et écrit EN CONTINU tous les canaux
// configurés (Sensor1, Sensor2, ...), qu'un capteur soit physiquement branché ou
// non — un canal "configuré mais débranché" apparaît donc quand même comme actif.
//
// La vraie source de vérité est le registre Modbus Sensoranzahl du Volt1000S
// lui-même, qui reflète le nombre RÉEL de capteurs physiquement branchés. Ce
// registre est lu en continu par Node-RED (global.set('Sensoranzahl', ...)) et
// désormais exposé via un endpoint HTTP : GET /sensoranzahl sur Node-RED.
//
// Ici, on interroge Node-RED en direct à chaque appel (pas de cache), on
// récupère ce nombre réel N, puis on ne garde que Sensor1...SensorN (Netz/
// Sensor0 — la tension réseau — est toujours conservé, ce n'est pas un capteur
// de courant).

const NODERED_URL = process.env.NODERED_URL || "http://192.168.1.20:1880";

async function getRealConnectedSensorCount() {
    const url = `${NODERED_URL}/sensoranzahl`;
    const res = await axios.get(url, { timeout: 3000 });
    const anzahl = parseInt(res.data?.anzahl, 10);
    if (isNaN(anzahl) || anzahl < 0) {
        throw new Error(`Réponse Node-RED invalide pour Sensoranzahl (reçu: ${JSON.stringify(res.data)})`);
    }
    return anzahl;
}

app.get("/sensors-connected", async (req, res) => {
    try {
        const anzahl = await getRealConnectedSensorCount();

        // Historique complet (toutes les données InfluxDB jamais écrites), puis
        // filtrage sur le nombre réel de capteurs branchés selon Node-RED.
        // ✅ MODIFIÉ : "Netz"/"Sensor0" (tension réseau uniquement, pas un vrai
        // capteur de courant) sont désormais exclus de cette vue.
        const allSensors = await discoverSensors("0");
        const result = allSensors.filter(s => {
            if (s.device === "Netz" || s.device === "Sensor0") return false;
            const num = parseInt(s.device.replace("Sensor", ""), 10);
            return !isNaN(num) && num <= anzahl;
        });

        res.json({ sensors: result, count: result.length, sensoranzahl: anzahl });
    } catch (err) {
        // ✅ MODIFIÉ : err.message était vide dans certains cas (ex: erreur réseau
        // sans message standard). On log l'erreur complète et on renvoie aussi le
        // code d'erreur réseau (ECONNREFUSED, ENOTFOUND, ETIMEDOUT...) pour pouvoir
        // diagnostiquer précisément (ex: Node-RED dans un autre conteneur Docker que
        // le backend → "localhost" ne le joint pas).
        console.error("/sensors-connected error:", err);
        res.status(500).json({
            error: "Node-RED nicht erreichbar oder Sensoranzahl ungültig",
            details: err.message || String(err) || "Keine Fehlermeldung verfügbar",
            code: err.code || null,
            nodered_url: `${NODERED_URL}/sensoranzahl`
        });
    }
});

// ========== ROUTE HISTORIQUE DIRECT PAR SENSOR/KANAL (pour onglet Mapping) ==========

app.get("/sensor-history/:device/:kanal", async (req, res) => {
    const { device, kanal } = req.params;
    const metric = req.query.metric || "Strom";
    const allowedMetrics = ["Strom", "Wirkleistung", "Spannung", "Energie"];
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
          |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "Spannung" or r._field == "Energie")
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
            else if (row._field === "Spannung")     pointsByTime[t].Spannung     = row._value;
            else if (row._field === "Energie")      pointsByTime[t].Energie      = row._value;
        });
        const data = Object.values(pointsByTime).sort((a, b) => new Date(a.time) - new Date(b.time));
        res.json({ device, kanal, metric, data });
    } catch (error) {
        console.error(`/sensor-history ${device}/${kanal} error:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ========== ROUTE DEBUG TEMPORAIRE (diagnostic mego) ==========
app.get("/debug-mego", async (req, res) => {
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: -24h)
          |> filter(fn: (r) => r["_measurement"] == "mego")
          |> filter(fn: (r) => r["_field"] == "Strom")
          |> keep(columns: ["_time", "_value", "Device", "Kanal", "Label"])
          |> limit(n: 20)
    `;
    try {
        const rows = await queryApi.collectRows(fluxQuery);
        res.json({ count: rows.length, rows });
    } catch (err) {
        console.error("/debug-mego error:", err);
        res.status(500).json({ error: err.message });
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

            await setEnergyToMesskoffer(chNum, newTemp);

            const map = channelMapping[ch];
            if (map) {
                const point = new Point("sensoren")
                    .tag("Device", map.device)
                    .tag("Kanal",  map.kanal)
                    .floatField("Energie", newTemp)
                    .timestamp(new Date());
                writeApi.writePoint(point);
            }

            energyConfig[ch] = { ...energyConfig[ch], temporary: newTemp, updatedAt: Date.now() };
        }
        await writeApi.flush();

        await new Promise(resolve => setTimeout(resolve, 2000));

        const { temporary } = await getEnergiesFromMesskoffer();
        const result = {};
        for (const ch of channelsList) {
            result[ch] = {
                label:     channelConfig[ch]?.label || ch,
                temporary: (temporary[ch] && temporary[ch] > 0)
                    ? temporary[ch]
                    : energyConfig[ch]?.temporary ?? 0,
                updatedAt: Date.now()
            };
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

const MEGO_MEASUREMENT = "mego";
const MEGO_DEVICE      = "mE180";

// ========== HISTORIQUE ENERGIE (écriture périodique dans InfluxDB) ==========
const ENERGY_HISTORY_INTERVAL_MS = 30000;

async function writeEnergyHistoryPoints() {
    try {
        const { temporary } = await getEnergiesFromMesskoffer();
        for (const ch of channelsList) {
            const value = temporary[ch];
            if (value === undefined || value === null || isNaN(value)) continue;
            const point = new Point(MEGO_MEASUREMENT)
                .tag("Device", MEGO_DEVICE)
                .tag("Kanal",  ch)
                .tag("Label",  channelConfig[ch]?.label || ch)
                .floatField("Energie", value)
                .timestamp(new Date());
            writeApi.writePoint(point);
        }
        await writeApi.flush();
    } catch (err) {
        console.error("[EnergyHistory] Fehler beim Schreiben:", err.message);
    }
}
setInterval(writeEnergyHistoryPoints, ENERGY_HISTORY_INTERVAL_MS);

app.get("/data", async (req, res) => {
    try {
        const { temporary: messeEnergy } = await getEnergiesFromMesskoffer();

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
                  |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "Leistungsfaktor")
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
                else if (row._field === "Leistungsfaktor") data_.CosinusPhi  = row._value;
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
                Energie_temp: (messeEnergy[ch] && messeEnergy[ch] > 0)
                    ? messeEnergy[ch]
                    : (energyConfig[ch]?.temporary && energyConfig[ch].temporary > 0)
                    ? energyConfig[ch].temporary
                    : null
            };

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
          |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "Leistungsfaktor" or r._field == "Energie")
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
            else if (row._field === "Leistungsfaktor") pointsByTime[t].CosinusPhi  = row._value;
            else if (row._field === "Energie")         pointsByTime[t].Energie_temp = row._value;
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
    console.log(`   Sensoren "connectés maintenant" : via Node-RED (${NODERED_URL}/sensoranzahl)`);
});