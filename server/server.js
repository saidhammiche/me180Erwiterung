const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const { InfluxDB, Point } = require("@influxdata/influxdb-client");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Route de healthcheck pour Docker
app.get("/health", (req, res) => {
    const configOk = Object.values(channelConfig).some(c => c.updatedAt > 0);
    res.status(configOk ? 200 : 503).send(configOk ? "ok" : "messkoffer not ready");
});

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

// ✅ Nouveau nommage des 18 canaux physiques (aligné avec le flow Node-RED) :
// CH1 a..f (phase L1), CH2 g..l (phase L2), CH3 m..r (phase L3).
// L'ORDRE est important : il correspond à la position 1..18 des CGI Messkoffer
// (labels, scaleend, threshold, énergies) et à l'ordre d'écriture Node-RED.
const channelsList = [
    "CH1 a", "CH1 b", "CH1 c", "CH1 d", "CH1 e", "CH1 f",
    "CH2 g", "CH2 h", "CH2 i", "CH2 j", "CH2 k", "CH2 l",
    "CH3 m", "CH3 n", "CH3 o", "CH3 p", "CH3 q", "CH3 r"
];

// ✅ Les noms de canaux ne contiennent plus le numéro CGI (contrairement à
// l'ancien "CH7" -> 7), donc on ne peut plus faire parseInt(ch.substring(2)).
// On retrouve l'index CGI (1-18) via la position dans channelsList.
function getChannelNumber(ch) {
    const idx = channelsList.indexOf(ch);
    return idx === -1 ? null : idx + 1;
}

// ✅ Canaux nécessitant une correction ×10 sur toutes les valeurs SAUF
// CosinusPhi et Energie (calibration/scaling matériel spécifique à ces voies).
// Numéros CGI 5, 6, 11, 12, 17, 18 -> CH1 e, CH1 f, CH2 k, CH2 l, CH3 q, CH3 r
const CHANNELS_X10 = [5, 6, 11, 12, 17, 18].map(num => channelsList[num - 1]);

function applyX10IfNeeded(ch, value) {
    if (value === null || value === undefined || isNaN(value)) return value;
    return CHANNELS_X10.includes(ch) ? value * 10 : value;
}

// ========== ENCODAGE MESSKOFFER (Latin1 / Windows-1252) ==========
// ✅ Le Messkoffer encode ses champs texte (labels) en Windows-1252/Latin1
// (1 octet par caractère), PAS en UTF-8. decodeURIComponent() attend de l'UTF-8
// et échoue sur un octet seul comme %FC (ü), %E4 (ä), %F6 (ö) -> l'exception est
// catchée et la chaîne brute "%fc" est renvoyée telle quelle au lieu de "ü".
// On décode donc manuellement chaque %XX comme un octet Latin1.
function decodeMesskofferText(raw) {
    if (typeof raw !== "string") return raw;
    try {
        const bytes = [];
        let i = 0;
        while (i < raw.length) {
            if (raw[i] === "%" && i + 2 < raw.length) {
                bytes.push(parseInt(raw.substr(i + 1, 2), 16));
                i += 3;
            } else if (raw[i] === "+") {
                bytes.push(0x20); // '+' = espace en form-urlencoded
                i++;
            } else {
                bytes.push(raw.charCodeAt(i));
                i++;
            }
        }
        return Buffer.from(bytes).toString("latin1");
    } catch {
        return raw;
    }
}

// ✅ Fonction inverse : encoder un label (pouvant contenir ü/ä/ö) au format
// attendu par le Messkoffer (Latin1/Windows-1252) avant de le lui envoyer.
// Sans ça, encodeURIComponent() produirait de l'UTF-8 multi-octets que
// l'appareil ne saurait pas réinterpréter correctement.
function encodeMesskofferText(str) {
    if (typeof str !== "string") return "";
    let result = "";
    for (const ch of str) {
        const code = ch.codePointAt(0);
        if (/[A-Za-z0-9\-_.~]/.test(ch)) {
            result += ch;
        } else if (code <= 0xFF) {
            result += "%" + code.toString(16).padStart(2, "0").toUpperCase();
        } else {
            // Caractère hors Latin1 (ex: emoji) : fallback UTF-8 standard
            result += encodeURIComponent(ch);
        }
    }
    return result;
}

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
    // ✅ Premiers canaux de chaque phase avec le nouveau nommage
    return ch === "CH1 a" || ch === "CH2 g" || ch === "CH3 m" ? 64 : 32;
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
        // ✅ CORRECTION ENCODAGE : décodage Latin1/Windows-1252 (voir decodeMesskofferText)
        // au lieu de decodeURIComponent (UTF-8) qui échouait sur ü/ä/ö.
        const parts = typeof raw === "string"
            ? raw.split(";").map(v => decodeMesskofferText(v))
            : [];
        const result = {};
        for (let i = 0; i < 18; i++) {
            // ✅ CORRECTION : clé = nouveau nom de canal (channelsList[i]) au lieu de CH${i+1}
            result[channelsList[i]] = (parts[i] !== undefined && parts[i] !== "") ? parts[i] : channelsList[i];
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
            // ✅ CORRECTION : clé = nouveau nom de canal
            result[channelsList[i]] = !isNaN(val) ? val : 32;
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
            // ✅ CORRECTION : clé = nouveau nom de canal
            result[channelsList[i]] = !isNaN(val) ? val / 1000 : 0;
        }
        return result;
    } catch (err) {
        console.error("[Messkoffer] Fehler Threshold:", err.message);
        return null;
    }
}

async function setLabelToMesskoffer(channelNum, label) {
    const idx = channelNum - 1;
    // ✅ CORRECTION ENCODAGE : encodeMesskofferText (Latin1/Windows-1252) au lieu
    // de encodeURIComponent (UTF-8), pour que ü/ä/ö soient envoyés dans le format
    // que le Messkoffer attend et sache réinterpréter correctement.
    const url = `http://${MESSE_IP}/set_sensor_config.cgi?id=${MESSE_ID}&sensor=ch&label${idx}=${encodeMesskofferText(label)}`;
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
                // ✅ CORRECTION : clé = nouveau nom de canal
                temporary[channelsList[i]] = (values[19 + i] || 0) / 10000;
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

// ========== INIT CONFIG DEPUIS MESSKOFFER (avec retry) ==========
// ✅ CORRECTION MAJEURE : au démarrage (ou redémarrage) du conteneur Docker,
// le Messkoffer/contrôleur physique peut ne pas encore être joignable sur le
// réseau (boot plus lent que le conteneur Node). L'ancienne version appelait
// initConfigFromMesskoffer() UNE SEULE FOIS : en cas d'échec, elle tombait
// silencieusement sur les valeurs par défaut (getDefaultHoechstwert -> 64/32)
// et n'essayait plus jamais de récupérer les vraies valeurs. On boucle donc
// désormais jusqu'au succès, avec un délai entre chaque tentative.
async function initConfigFromMesskoffer(retryDelayMs = 3000, maxAttempts = 0) {
    // maxAttempts = 0 -> retry infini jusqu'au succès
    let attempt = 0;
    while (true) {
        attempt++;
        const [labels, scaleends, thresholds] = await Promise.all([
            getLabelsFromMesskoffer(),
            getScaleendFromMesskoffer(),
            getThresholdFromMesskoffer()
        ]);

        // ✅ On considère l'init réussie seulement si on a bien reçu les scaleends
        const success = scaleends !== null;

        if (success) {
            for (const ch of channelsList) {
                channelConfig[ch] = {
                    label:       labels?.[ch]     || ch,
                    hoechstwert: scaleends?.[ch]  || getDefaultHoechstwert(ch),
                    schwellwert: thresholds?.[ch] || 0,
                    updatedAt:   Date.now()
                };
            }
            console.log(`[Config] Aus Messkoffer geladen (Versuch ${attempt})`);
            return;
        }

        console.warn(`[Config] Messkoffer nicht erreichbar (Versuch ${attempt}), retry in ${retryDelayMs}ms...`);

        if (maxAttempts > 0 && attempt >= maxAttempts) {
            console.error(`[Config] Aufgegeben nach ${attempt} Versuchen — Default-Werte werden benutzt`);
            for (const ch of channelsList) {
                channelConfig[ch] = {
                    label:       ch,
                    hoechstwert: getDefaultHoechstwert(ch),
                    schwellwert: 0,
                    updatedAt:   Date.now()
                };
            }
            return;
        }

        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
}
initConfigFromMesskoffer(); // retry infini par défaut jusqu'à ce que le Messkoffer réponde

// ========== ENERGIE CACHE ==========
let energyConfig = {};
function initEnergyConfig() {
    for (const ch of channelsList) {
        // ✅ Uniquement le compteur temporaire (18 dernières valeurs du CGI), pas de cumulé.
        energyConfig[ch] = { temporary: 0, updatedAt: 0 };
    }
}
initEnergyConfig();

// ✅ Tolérance numérique pour comparer deux valeurs d'énergie (évite les faux
// "changements" dus à des arrondis flottants lors de la relecture CGI).
const ENERGY_EPSILON = 1e-6;
const hasEnergyChanged = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) > ENERGY_EPSILON;

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
// réellement présents dans le bucket, avec leurs dernières valeurs Strom / Wirkleistung /
// Spannung / Energie.
// ✅ Spannung ajoutée : le device "Netz" (anciennement "Sensor0") porte la tension du
// réseau sur les Kanal 1/2/3 (L1/L2/L3) ; il n'est plus exclu du résultat.

app.get("/sensors-discovery", async (req, res) => {
    try {
        const fluxQuery = `
            from(bucket: "${INFLUX_BUCKET}")
              |> range(start: 0)
              |> filter(fn: (r) => r["_measurement"] == "sensoren1")
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

        // Construire un résultat trié : "Netz"/"Sensor0" (tension) en premier, puis
        // Sensor1, Sensor2, ... par numéro croissant.
        const sensorNames = Object.keys(bySensor).sort((a, b) => {
            const rank = (name) => {
                if (name === "Netz" || name === "Sensor0") return -1;
                const n = parseInt(name.replace("Sensor", ""), 10);
                return isNaN(n) ? 999 : n;
            };
            return rank(a) - rank(b);
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
    const allowedMetrics = ["Strom", "Wirkleistung", "Spannung", "Energie"];
    if (!allowedMetrics.includes(metric)) {
        return res.status(400).json({ error: "Ungültige Messgröße" });
    }

    let duration = req.query.time || "1h";
    if (duration.includes("d") && parseInt(duration) > 1) duration = "24h";

    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: -${duration})
          |> filter(fn: (r) => r._measurement == "sensoren1")
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

// ========== ROUTE DEBUG TEMPORAIRE (diagnostic mego4) ==========
// ⚠️ Route de diagnostic uniquement, à supprimer une fois le problème résolu.
// Retourne les 20 dernières lignes brutes du champ "Strom" du measurement "mego4",
// sans AUCUN filtre Device/Kanal/Label, pour voir les vraies valeurs des tags en base.
app.get("/debug-mego4", async (req, res) => {
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: -24h)
          |> filter(fn: (r) => r["_measurement"] == "mego4")
          |> filter(fn: (r) => r["_field"] == "Strom")
          |> keep(columns: ["_time", "_value", "Device", "Kanal", "Label"])
          |> limit(n: 20)
    `;
    try {
        const rows = await queryApi.collectRows(fluxQuery);
        res.json({ count: rows.length, rows });
    } catch (err) {
        console.error("/debug-mego4 error:", err);
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
            // ✅ CORRECTION : "CH1 a" n'a plus de chiffre exploitable par substring(2) —
            // on retrouve le numéro CGI (1-18) via la position dans channelsList.
            const chNum      = getChannelNumber(ch);

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

// ✅ CORRECTION : "updatedAt" ne doit refléter que le moment où la valeur d'un
// canal a réellement changé — pas le moment où la route a été appelée. Avant,
// Date.now() était écrit pour LES 18 canaux à chaque appel (polling 30s côté
// frontend), donc "Letzte Änderung" affichait "gerade eben" partout même si un
// seul canal avait été modifié. On compare désormais à la valeur en cache et on
// ne touche l'horodatage que pour les canaux dont la valeur a bougé.
app.get("/energy-values", async (req, res) => {
    try {
        const { temporary } = await getEnergiesFromMesskoffer();

        const result = {};
        for (const ch of channelsList) {
            const previous   = energyConfig[ch] || { temporary: 0, updatedAt: 0 };
            const newTemp     = temporary[ch] ?? previous.temporary ?? 0;
            const changed     = hasEnergyChanged(newTemp, previous.temporary);
            const updatedAt   = changed ? Date.now() : previous.updatedAt;

            result[ch] = {
                label:     channelConfig[ch]?.label || ch,
                // ✅ Uniquement les 18 dernières valeurs (temporaires) du CGI Messkoffer,
                // jamais les valeurs cumulées d'InfluxDB. Jamais multiplié par 10.
                temporary: newTemp,
                updatedAt
            };

            energyConfig[ch] = { temporary: newTemp, updatedAt };
        }

        res.json(result);
    } catch (err) {
        console.error("/energy-values error:", err);
        res.status(500).json({ error: "Interner Fehler" });
    }
});

// ✅ CORRECTION : délai 2s avant relecture Messkoffer, + même correction
// "updatedAt" que ci-dessus dans la boucle de relecture finale.
app.post("/energy-values/set", async (req, res) => {
    const updates = req.body;
    if (typeof updates !== "object") return res.status(400).json({ error: "JSON-Objekt erwartet" });

    try {
        for (const [ch, cfg] of Object.entries(updates)) {
            if (!channelsList.includes(ch)) continue;
            const oldTemp = energyConfig[ch]?.temporary || 0;
            const newTemp = cfg.temporary !== undefined ? parseFloat(cfg.temporary) : oldTemp;
            if (!hasEnergyChanged(newTemp, oldTemp)) continue;

            // ✅ CORRECTION : "CH1 a" n'a plus de chiffre exploitable par substring(2)
            const chNum = getChannelNumber(ch);

            // 1. Envoyer au Messkoffer
            await setEnergyToMesskoffer(chNum, newTemp);

            // 2. Ecrire dans InfluxDB via mapping
            const map = channelMapping[ch];
            if (map) {
                const point = new Point("sensoren1")
                    .tag("Device", map.device)
                    .tag("Kanal",  map.kanal)
                    .floatField("Energie", newTemp)
                    .timestamp(new Date());
                writeApi.writePoint(point);
            }

            // ✅ Mettre à jour le cache local immédiatement — seul ce canal reçoit
            // un nouvel horodatage, puisque c'est le seul dont la valeur a changé.
            energyConfig[ch] = { temporary: newTemp, updatedAt: Date.now() };
        }
        await writeApi.flush();

        // ✅ Attendre 2s que le Messkoffer traite avant de relire
        await new Promise(resolve => setTimeout(resolve, 2000));

        const { temporary } = await getEnergiesFromMesskoffer();
        const result = {};
        for (const ch of channelsList) {
            const previous = energyConfig[ch] || { temporary: 0, updatedAt: 0 };
            // ✅ Si Messkoffer retourne encore 0, on garde la valeur du cache local
            const confirmedTemp = (temporary[ch] && temporary[ch] > 0)
                ? temporary[ch]
                : previous.temporary ?? 0;
            // ✅ On ne rafraîchit l'horodatage que si cette relecture révèle un
            // changement par rapport à ce qui était déjà en cache (ex: le canal
            // qu'on vient de modifier). Les autres canaux, non touchés, gardent
            // leur "Letzte Änderung" d'origine.
            const changed   = hasEnergyChanged(confirmedTemp, previous.temporary);
            const updatedAt = changed ? Date.now() : previous.updatedAt;

            result[ch] = {
                label:     channelConfig[ch]?.label || ch,
                temporary: confirmedTemp,
                updatedAt
            };
            // ✅ Mettre à jour le cache avec la valeur confirmée
            energyConfig[ch] = { temporary: confirmedTemp, updatedAt };
        }
        res.json({ success: true, config: result });
    } catch (err) {
        console.error("[POST /energy-values/set] Fehler:", err);
        res.status(500).json({ error: err.message });
    }
});

// ========== CALCUL SCHEINLEISTUNG / BLINDLEISTUNG via P et cosφ ==========
// S = P / cosφ ; Q = √(S² - P²). Évite la division par zéro / cosφ trop faible.
// ⚠️ Doit toujours être calculé avec les valeurs BRUTES (avant ×10), sinon S et Q
// seraient faussés par un double facteur d'échelle.
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
// ✅ Source désormais : measurement "mego4", Device "mE180" (données Node-RED),
// filtrées par Kanal=CHx ET Label=<label CGI actuel du canal>.
// Spannung reste via /voltages (CGI Messkoffer). Energie reste via cache/CGI (jamais mego4).

const mego4_MEASUREMENT = "mego4";
const mego4_DEVICE      = "mE180";

app.get("/data", async (req, res) => {
    try {
        // ✅ CORRECTION PERFORMANCE : énergies + tensions Messkoffer en PARALLÈLE.
        const [{ temporary: messeEnergy }, voltagesU] = await Promise.all([
            getEnergiesFromMesskoffer(),
            (async () => {
                try {
                    const url      = `http://${MESSE_IP}/get_live_values.cgi?id=${MESSE_ID}&ch=18`;
                    const response = await axios.get(url, { timeout: 5000 });
                    const values   = typeof response.data === "string"
                        ? response.data.split(";").map(v => parseFloat(v.trim()))
                        : [];
                    return {
                        1: !isNaN(values[1]) ? values[1] / 100 : 0,
                        2: !isNaN(values[2]) ? values[2] / 100 : 0,
                        3: !isNaN(values[3]) ? values[3] / 100 : 0
                    };
                } catch (err) {
                    console.error("[/data] Fehler Spannungen:", err.message);
                    return { 1: 0, 2: 0, 3: 0 };
                }
            })()
        ]);

        // ✅ Une requête Flux par canal, car le filtre Label dépend du label CGI courant
        // de chaque canal (peut différer d'un canal à l'autre).
        const queries = channelsList.map(ch => {
            const label = channelConfig[ch]?.label || ch;
            const safeLabel = label.replace(/"/g, '\\"');
            return `
                from(bucket: "${INFLUX_BUCKET}")
                  |> range(start: -10m)
                  |> filter(fn: (r) => r._measurement == "${mego4_MEASUREMENT}")
                  |> filter(fn: (r) => r.Device == "${mego4_DEVICE}")
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
            // ✅ CORRECTION : "CH1 a" n'a plus de chiffre exploitable par substring(2).
            // On détermine la phase (L1/L2/L3) via la position du canal dans channelsList :
            // index 0-5 -> phase 1, 6-11 -> phase 2, 12-17 -> phase 3.
            const idx       = channelsList.indexOf(ch);
            const voltKanal = idx < 6 ? 1 : (idx < 12 ? 2 : 3);
            const U = voltagesU[voltKanal] ?? null;
            const influxData = byChannel[ch] || {};
            const I = influxData.Strom        ?? null;
            const P = influxData.Wirkleistung ?? null;
            const cosPhi = influxData.CosinusPhi ?? null; // ⚠️ jamais touché par ×10

            // ✅ S et Q calculés avec les valeurs BRUTES (avant ×10)
            const { S, Q } = computeApparentAndReactive(P, cosPhi);

            const rawEnergie = (messeEnergy[ch] && messeEnergy[ch] > 0)
                ? messeEnergy[ch]
                : (energyConfig[ch]?.temporary && energyConfig[ch].temporary > 0)
                ? energyConfig[ch].temporary
                : null;

            result[ch] = {
                Label:        channelConfig[ch]?.label || ch,
                // ✅ Correction ×10 pour les canaux 5,6,11,12,17,18
                Strom:          applyX10IfNeeded(ch, I),
                Wirkleistung:   applyX10IfNeeded(ch, P),
                Spannung:       applyX10IfNeeded(ch, U),
                // ✅ CosinusPhi et Energie : jamais multipliés
                CosinusPhi:     cosPhi,
                Energie_temp:   rawEnergie,
                Scheinleistung: applyX10IfNeeded(ch, S),
                Blindleistung:  applyX10IfNeeded(ch, Q)
            };
        }

        res.json(result);
    } catch (error) {
        console.error("/data error:", error);
        res.status(500).send("Fehler: " + error.message);
    }
});

// ========== ROUTE HISTORY ==========
// ✅ Source désormais : measurement "mego4", Device "mE180", filtré par Kanal=CHx
// et Label=<label CGI actuel du canal>.

app.get("/history/:channel", async (req, res) => {
    const { channel } = req.params;
    // ✅ CORRECTION : ne plus forcer .toUpperCase() — les nouveaux noms de canaux
    // contiennent des minuscules ("CH1 a"..."CH3 r"), toUpperCase() les cassait.
    const ch = channel;
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
          |> filter(fn: (r) => r._measurement == "${mego4_MEASUREMENT}")
          |> filter(fn: (r) => r.Device == "${mego4_DEVICE}")
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
            else if (row._field === "Energie")        pointsByTime[t].Energie      = row._value;
        });

        const data = Object.values(pointsByTime)
            .map(point => {
                // ✅ S et Q calculés avec les valeurs BRUTES (avant ×10)
                const { S, Q } = computeApparentAndReactive(point.Wirkleistung ?? null, point.CosinusPhi ?? null);
                return {
                    time: point.time,
                    // ✅ Correction ×10 pour les canaux 5,6,11,12,17,18
                    Strom:          applyX10IfNeeded(ch, point.Strom ?? null),
                    Wirkleistung:   applyX10IfNeeded(ch, point.Wirkleistung ?? null),
                    // ✅ CosinusPhi et Energie : jamais multipliés
                    CosinusPhi:     point.CosinusPhi ?? null,
                    Energie:        point.Energie ?? null,
                    Scheinleistung: applyX10IfNeeded(ch, S),
                    Blindleistung:  applyX10IfNeeded(ch, Q)
                };
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
    console.log(`   Canaux ×10 (sauf CosinusPhi/Energie): ${CHANNELS_X10.join(", ")}`);
});