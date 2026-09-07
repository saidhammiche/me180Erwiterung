const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");
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

// ✅ Nommage aligné sur le flow Node-RED (mE180) : 18 canaux physiques
// nommés "PH1 a".."PH3 r" (préfixe "PH" au lieu de l'ancien "CH", mais on
// garde le numéro de groupe 1/2/3 = phase L1/L2/L3 et la lettre a-r qui
// identifie la position exacte parmi les 18 canaux).
// L'ordre positionnel est identique à avant (index 0 = premier canal, etc.),
// donc toute la logique basée sur la position dans ce tableau reste valable.
// ⚠️ Les données déjà écrites dans InfluxDB sous l'ancien tag ("PH1 a"...)
// restent inchangées (non migrées) ; seules les nouvelles écritures utilisent
// désormais "PH1 a".."PH3 r".
const channelsList = [
    "PH1 a", "PH1 b", "PH1 c", "PH1 d", "PH1 e", "PH1 f",
    "PH2 g", "PH2 h", "PH2 i", "PH2 j", "PH2 k", "PH2 l",
    "PH3 m", "PH3 n", "PH3 o", "PH3 p", "PH3 q", "PH3 r"
];

// ✅ Le nom de canal n'est plus "parsable" directement pour tous les cas dans
// l'ancien format ("PH1 a" n'était pas un simple CH+numéro) : on retrouve le
// numéro physique 1-18 par sa position dans channelsList, plutôt que par
// découpage de chaîne.
function channelNumber(ch) {
    const idx = channelsList.indexOf(ch);
    return idx === -1 ? NaN : idx + 1;
}

// ========== MAPPING CH -> Device+Kanal ==========
let channelMapping = {};

function initMapping() {
    for (let i = 0; i < 18; i++) {
        // ✅ CORRIGÉ : clé = channelsList[i] (nouveau nommage) au lieu de
        // l'ancien "CH${i+1}" — sinon channelNumber(ch) (utilisé pour la
        // corrélation CosPhi dans discoverSensors) ne retrouvait plus la
        // position du canal et cassait le Cosinus Phi de l'onglet Mapping.
        const ch       = channelsList[i];
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
    // ✅ Avant : comparait le nom exact ("CH1"/"CH7"/"CH13"). Avec le nouveau
    // nommage ("PH1".."PH18"), on se base sur la position (1er canal de
    // chaque groupe de 6 = phase L1/L2/L3) via channelNumber().
    const num = channelNumber(ch);
    return num === 1 || num === 7 || num === 13 ? 64 : 32;
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
            // ✅ CORRIGÉ : clé = nom réel du canal (channelsList[i], ex "PH1")
            // au lieu de l'ancien "CH${i+1}" — sinon channelConfig[ch] ne
            // retrouvait jamais ce label (clé introuvable) et retombait sur
            // le nom du canal lui-même comme "Bezeichnung".
            const ch = channelsList[i];
            result[ch] = (parts[i] !== undefined && parts[i] !== "") ? parts[i] : ch;
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
                // ✅ CORRIGÉ : clé = channelsList[i] (nouveau nommage), sinon
                // "Kanal Zähler" et l'historique d'énergie (writeEnergyHistoryPoints)
                // ne retrouvaient plus aucune valeur (clé introuvable).
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

// ✅ AJOUT : au démarrage (surtout après un reboot système), le réseau ou le
// Messkoffer peuvent ne pas être encore disponibles quand ce conteneur
// démarre. Un seul essai qui échoue figeait alors les labels par défaut
// (nom du canal, ex "PH1") jusqu'à un redémarrage manuel plus tardif du
// conteneur (réseau alors déjà up). On réessaie donc plusieurs fois avec un
// délai, tant que le Messkoffer n'est pas joignable.
async function initConfigFromMesskofferWithRetry(maxAttempts = 20, delayMs = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const labels = await getLabelsFromMesskoffer();
        if (labels) {
            // Labels récupérés avec succès : on charge la config complète normalement
            await initConfigFromMesskoffer();
            console.log(`[Config] Messkoffer erreichbar (Versuch ${attempt}/${maxAttempts})`);
            return;
        }
        console.warn(`[Config] Messkoffer nicht erreichbar (Versuch ${attempt}/${maxAttempts}), erneuter Versuch in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    console.error(`[Config] Messkoffer nach ${maxAttempts} Versuchen nicht erreichbar. Standardwerte werden verwendet.`);
    await initConfigFromMesskoffer(); // dernier essai, garde le fallback existant si toujours KO
}

initConfigFromMesskofferWithRetry();

// ✅ AJOUT : les labels (et scaleend/threshold) peuvent être modifiés
// directement sur le contrôleur Messkoffer, en dehors de l'interface web.
// channelConfig est un cache mémoire qui ne se met à jour que quand CE
// serveur écrit dessus (POST /config) — un changement fait directement sur
// l'appareil n'était donc jamais détecté tant qu'on ne rappelait pas
// manuellement /messkoffer/reload. On synchronise maintenant automatiquement
// toutes les 15 secondes.
const CONFIG_SYNC_INTERVAL_MS = 5000;
setInterval(() => {
    initConfigFromMesskoffer().catch(err =>
        console.error("[Config] Fehler bei periodischer Synchronisierung:", err.message)
    );
}, CONFIG_SYNC_INTERVAL_MS);

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

// ========== RESET LOGICIEL DU COMPTEUR ENERGIE (Sensor1/Sensor2, mesure "sensoren") ==========
// ✅ Le champ Energie vient d'un compteur cumulatif interne au Volt1000S,
// jamais remis à zéro par le matériel lui-même. On simule un "reset" côté
// logiciel : on mémorise la valeur brute actuelle comme "baseline" au moment
// du clic, puis on la soustrait à chaque lecture suivante — comme un
// compteur journalier affiché à côté du kilométrage total d'une voiture.
// ⚠️ Cette baseline est en mémoire uniquement (perdue si le serveur redémarre),
// comme kundenLabels ci-dessus.
// ⚠️ CORRIGÉ : cette baseline était auparavant en mémoire uniquement — si le
// serveur redémarrait (crash, redéploiement...), le reset était "oublié" et
// l'affichage retombait brutalement sur la valeur brute complète (le fameux
// "1230..." qui revenait tout seul). Elle est désormais sauvegardée dans un
// fichier sur disque, chargée au démarrage, et réécrite à chaque reset.
const ENERGIE_RESET_FILE = path.join(__dirname, "energie-reset-offsets.json");

function loadEnergieResetOffsets() {
    try {
        if (fs.existsSync(ENERGIE_RESET_FILE)) {
            return JSON.parse(fs.readFileSync(ENERGIE_RESET_FILE, "utf8"));
        }
    } catch (err) {
        console.error("[Energie-Reset] Fehler beim Laden der gespeicherten Baseline:", err.message);
    }
    return {};
}

function saveEnergieResetOffsets() {
    try {
        fs.writeFileSync(ENERGIE_RESET_FILE, JSON.stringify(energieResetOffsets, null, 2));
    } catch (err) {
        console.error("[Energie-Reset] Fehler beim Speichern der Baseline:", err.message);
    }
}

let energieResetOffsets = loadEnergieResetOffsets();

function getEnergieOffsetKey(device, kanal) {
    return `${device}_${kanal}`;
}

app.get("/energie-reset", (req, res) => {
    res.json(energieResetOffsets);
});

app.post("/energie-reset", async (req, res) => {
    const { device, kanal } = req.body;
    if (!device || kanal === undefined || kanal === null) {
        return res.status(400).json({ error: "device und kanal erforderlich" });
    }
    try {
        const fluxQuery = `
            from(bucket: "${INFLUX_BUCKET}")
              |> range(start: 0)
              |> filter(fn: (r) => r._measurement == "sensoren")
              |> filter(fn: (r) => r.Device == "${device}")
              |> filter(fn: (r) => r.Kanal  == "${String(kanal)}")
              |> filter(fn: (r) => r._field == "Energie")
              |> last()
        `;
        const rows     = await queryApi.collectRows(fluxQuery);
        const rawValue = rows[0]?._value ?? 0;
        const key      = getEnergieOffsetKey(device, String(kanal));
        energieResetOffsets[key] = rawValue;
        saveEnergieResetOffsets();
        console.log(`[Energie-Reset] ${key}: Baseline gesetzt auf ${rawValue} Wh (gespeichert)`);
        res.json({ success: true, device, kanal: String(kanal), baseline: rawValue });
    } catch (err) {
        console.error("[POST /energie-reset] Fehler:", err);
        res.status(500).json({ error: err.message });
    }
});


// ========== CALCUL SCHEINLEISTUNG / BLINDLEISTUNG via P et cosφ (Messkoffer/mego) ==========
// ✅ Conservé tel quel : utilisé par la route /data (système Messkoffer, mego),
// qui reçoit un CosinusPhi ("Leistungsfaktor") déjà mesuré en direct par ce
// système-là. Ne pas confondre avec le système Sensor1/Sensor2/Netz
// (mesure "sensoren") ci-dessous, qui a sa propre fonction de calcul.
function computeApparentAndReactive(P, cosPhi) {
    if (P === null || P === undefined || isNaN(P)) return { S: null, Q: null };
    if (cosPhi === null || cosPhi === undefined || isNaN(cosPhi) || Math.abs(cosPhi) < 0.01) {
        return { S: null, Q: null };
    }
    const S = P / cosPhi;
    const Q = Math.sqrt(Math.max(0, S * S - P * P));
    return { S, Q };
}

// ⚠️ NON UTILISÉE DANS discoverSensors() : cette fonction calculait S/Q/cosφ
// a partir de U x I. Depuis que le flow Node-RED ecrit CosPhi, Blindleistung
// et Scheinleistung directement (lecture Modbus reelle), discoverSensors()
// lit ces valeurs telles quelles depuis InfluxDB au lieu de les recalculer.
// Fonction laissee en place (non appelee) pour ne rien modifier d'autre.
function computeApparentAndReactiveFromUI(U, I, P) {
    if (U === null || U === undefined || isNaN(U) || I === null || I === undefined || isNaN(I)) {
        return { S: null, Q: null, cosPhi: null };
    }
    const S = U * I;
    if (P === null || P === undefined || isNaN(P) || S === 0) {
        return { S, Q: null, cosPhi: null };
    }
    const Q = Math.sqrt(Math.max(0, S * S - P * P));
    const cosPhi = P / S;
    return { S, Q, cosPhi };
}

// ========== DECOUVERTE DYNAMIQUE SENSOR/KANAL (FONCTION PARTAGEE) ==========

// ⚠️ NON UTILISÉE DANS discoverSensors() : servait uniquement a la
// correlation CosPhi horaire (CGI) via un canal global "Sensor0", supprimee
// ci-dessous puisque CosPhi est maintenant lu directement par Device/Kanal.
// Fonction laissee en place (non appelee) pour ne rien modifier d'autre.
function findChannelForDeviceKanal(device, kanal) {
    for (const [ch, map] of Object.entries(channelMapping)) {
        if (map.device === device && map.kanal === String(kanal)) return ch;
    }
    return null;
}

async function discoverSensors(rangeStart) {
    // ✅ CORRIGÉ : la fenêtre était de 30 jours, donc tout capteur ayant écrit
    // ne serait-ce qu'une fois dans le mois (ex: anciens tests Sensor4/5)
    // restait visible indéfiniment ("capteurs fantômes"). Réduit à une
    // fenêtre courte (15s, un peu plus que le cycle de polling Modbus) :
    // seuls les capteurs qui envoient réellement des données maintenant
    // apparaissent — plus besoin de bascule "Verlauf" côté frontend.
    const start = (rangeStart === "0" || rangeStart === 0)
        ? "-15s"
        : rangeStart;

    // ✅ CORRIGÉ : le flow Node-RED Volt1000S écrit désormais Strom,
    // Wirkleistung, Blindleistung, Scheinleistung, CosPhi et Energie bruts
    // pour chaque capteur/canal (plus de calcul U×I nécessaire) — ces champs
    // avaient été retirés de cette requête lors d'une étape intermédiaire
    // (réduction temporaire à 3 valeurs) et jamais remis depuis. Spannung
    // reste lue via le device "Netz"/"Sensor0" (tension par phase).
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: ${start})
          |> filter(fn: (r) => r["_measurement"] == "sensoren")
          |> filter(fn: (r) => r["_field"] == "Strom" or r["_field"] == "Wirkleistung" or r["_field"] == "Blindleistung" or r["_field"] == "Scheinleistung" or r["_field"] == "CosPhi" or r["_field"] == "Energie" or r["_field"] == "Spannung")
          |> last()
    `;

    const rows = await queryApi.collectRows(fluxQuery);

    // Regrouper par Device -> Kanal -> { Strom, Wirkleistung, Blindleistung, Scheinleistung, Energie, CosinusPhi, Spannung, time }
    const bySensor = {};

    rows.forEach(row => {
        const device = row.Device;
        const kanal  = String(row.Kanal);
        const field  = row._field;

        if (!device) return;

        if (!bySensor[device]) bySensor[device] = {};
        if (!bySensor[device][kanal]) {
            bySensor[device][kanal] = {
                kanal,
                Strom: null,
                Wirkleistung: null,
                Blindleistung: null,
                Scheinleistung: null,
                Energie: null,
                CosinusPhi: null,
                Spannung: null,
                updatedAt: null
            };
        }

        if      (field === "Strom")          bySensor[device][kanal].Strom          = row._value;
        else if (field === "Wirkleistung")   bySensor[device][kanal].Wirkleistung   = row._value;
        else if (field === "Blindleistung")  bySensor[device][kanal].Blindleistung  = row._value;
        else if (field === "Scheinleistung") bySensor[device][kanal].Scheinleistung = row._value;
        else if (field === "Energie")        bySensor[device][kanal].Energie        = row._value;
        else if (field === "CosPhi")         bySensor[device][kanal].CosinusPhi     = row._value;
        else if (field === "Spannung")       bySensor[device][kanal].Spannung       = row._value;

        const t = new Date(row._time).getTime();
        if (!bySensor[device][kanal].updatedAt || t > bySensor[device][kanal].updatedAt) {
            bySensor[device][kanal].updatedAt = t;
        }
    });

    // ✅ Tension de référence par phase (device "Netz"/"Sensor0", kanal 1/2/3
    // = L1/L2/L3), à rattacher à chaque capteur de courant selon son canal
    // — uniquement utile en secours si un capteur n'a pas sa propre Spannung.
    const netzDevice = bySensor["Netz"] || bySensor["Sensor0"] || {};
    const netzVoltageByKanal = {
        "1": netzDevice["1"]?.Spannung ?? null,
        "2": netzDevice["2"]?.Spannung ?? null,
        "3": netzDevice["3"]?.Spannung ?? null,
    };

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
            .map(k => {
                // ✅ Applique le reset logiciel (soustrait la baseline mémorisée
                // au dernier clic sur "Zähler zurücksetzen"), le cas échéant.
                // Ne modifie que l'affichage — le compteur matériel réel du
                // Volt1000S continue de tourner en arrière-plan sans interruption.
                const offset = energieResetOffsets[getEnergieOffsetKey(device, k.kanal)] || 0;
                const adjustedEnergie = (k.Energie !== null && k.Energie !== undefined && !isNaN(k.Energie))
                    ? Math.max(0, k.Energie - offset)
                    : k.Energie;
                // Spannung propre au capteur (déjà en base) ; à défaut,
                // secours via la tension de phase du device "Netz".
                const spannung = (device === "Netz" || device === "Sensor0")
                    ? k.Spannung
                    : (k.Spannung ?? netzVoltageByKanal[k.kanal] ?? null);
                return {
                    ...k,
                    Energie:     adjustedEnergie,
                    Spannung:    spannung,
                    Bezeichnung: getKundenLabel(device, k.kanal)
                    // Wirkleistung, Blindleistung, Scheinleistung, CosinusPhi
                    // viennent déjà de k (lus bruts depuis InfluxDB ci-dessus).
                };
            });
        return { device, kanaele: kanaux };
    });
}

// ========== ROUTE HISTORIQUE COMPLET (onglet Mapping) ==========

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

        const allSensors = await discoverSensors("0");
        // ✅ CORRIGÉ : "Netz"/"Sensor0" (tension par phase) est conservé dans
        // la liste renvoyée — le frontend en a besoin pour les boîtes
        // Spannung L1/L2/L3 — mais n'est pas compté comme un "Sensor" dans
        // sensorCount (uniquement Sensor1..N où N = Sensoranzahl réelle).
        const realSensorCount = allSensors.filter(s => {
            if (s.device === "Netz" || s.device === "Sensor0") return false;
            const num = parseInt(s.device.replace("Sensor", ""), 10);
            return !isNaN(num) && num <= anzahl;
        }).length;
        const result = allSensors.filter(s => {
            if (s.device === "Netz" || s.device === "Sensor0") return true;
            const num = parseInt(s.device.replace("Sensor", ""), 10);
            return !isNaN(num) && num <= anzahl;
        });

        res.json({ sensors: result, count: realSensorCount, sensoranzahl: anzahl });
    } catch (err) {
        console.error("/sensors-connected error:", err);
        res.status(500).json({
            error: "Node-RED nicht erreichbar oder Sensoranzahl ungültig",
            details: err.message || String(err) || "Keine Fehlermeldung verfügbar",
            code: err.code || null,
            nodered_url: `${NODERED_URL}/sensoranzahl`
        });
    }
});

// ✅ AJOUT : au lieu d'une fenêtre d'agrégation fixe (10s) quelle que soit la
// durée demandée, on adapte la taille de fenêtre à la plage sélectionnée —
// comme le fait Grafana avec v.windowPeriod. Une fenêtre fixe trop grande par
// rapport à la durée choisie renvoie trop peu de points, ce qui donne une
// courbe qui ressemble à des points isolés plutôt qu'à une ligne continue.
function getAggregationWindow(duration) {
    const map = {
        "5m":  "2s",
        "10m": "5s",
        "15m": "5s",
        "1h":  "15s",
        "2h":  "30s",
        "6h":  "1m",
        "24h": "5m"
    };
    return map[duration] || "10s";
}

// ✅ AJOUT : conversion d'une durée Flux ("5m", "1h", "24h"...) en millisecondes,
// utilisée pour générer une courbe de secours quand aucune donnée n'existe.
function durationToMs(duration) {
    const m = String(duration).match(/^(\d+)([smhd])$/);
    if (!m) return 60 * 60 * 1000; // repli : 1h
    const n = parseInt(m[1], 10);
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
    return n * mult;
}

// ✅ AJOUT : si un canal/capteur n'a strictement aucune donnée sur la période
// demandée (série jamais écrite, ou hors ligne depuis le début de la
// fenêtre), on génère quand même une courbe plate à 0 sur toute la durée —
// ainsi le graphe "Trends" affiche toujours une ligne au lieu du message
// "Keine historischen Daten".
function generateZeroSeries(duration, fields) {
    const stepMs  = durationToMs(getAggregationWindow(duration));
    const totalMs = durationToMs(duration);
    const now     = Date.now();
    const start   = now - totalMs;
    const points  = [];
    for (let t = start; t <= now; t += stepMs) {
        const point = { time: new Date(t).toISOString() };
        fields.forEach(f => { point[f] = 0; });
        points.push(point);
    }
    return points;
}

// ========== ROUTE HISTORIQUE DIRECT PAR SENSOR/KANAL (pour onglet Mapping) ==========

app.get("/sensor-history/:device/:kanal", async (req, res) => {
    const { device, kanal } = req.params;
    const metric = req.query.metric || "Strom";
    const allowedMetrics = ["Strom", "Wirkleistung", "Blindleistung", "Spannung", "Energie", "CosPhi"];
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
          |> filter(fn: (r) => r._field == "${metric}")
          |> aggregateWindow(every: ${getAggregationWindow(duration)}, fn: mean, createEmpty: true)
          |> fill(value: 0.0)
          |> sort(columns: ["_time"])
    `;

    try {
        const rows = await queryApi.collectRows(fluxQuery);
        // ✅ Applique le même reset logiciel que /sensors-discovery : sans ça,
        // la vue détail (résumé + graphique) réaffichait la valeur brute
        // cumulée depuis toujours, même après un clic sur "zurücksetzen".
        const offset = (metric === "Energie")
            ? (energieResetOffsets[getEnergieOffsetKey(device, kanal)] || 0)
            : 0;
        const data = rows
            .map(row => {
                const raw = row._value ?? 0;
                const value = (metric === "Energie")
                    ? Math.max(0, raw - offset)
                    : raw;
                return { time: row._time, [metric]: value };
            })
            .sort((a, b) => new Date(a.time) - new Date(b.time));
        // ✅ Si le canal n'a strictement aucune donnée sur la période (série
        // jamais écrite), on retourne quand même une courbe plate à 0.
        const finalData = data.length > 0 ? data : generateZeroSeries(duration, [metric]);
        res.json({ device, kanal, metric, data: finalData });
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
            const chNum      = channelNumber(ch);

            if (cfg.label !== undefined && cfg.label !== old.label)
                await setLabelToMesskoffer(chNum, newLabel);
            if (cfg.schwellwert !== undefined && parseFloat(cfg.schwellwert) !== old.schwellwert)
                await setThresholdToMesskoffer(chNum, newSchwell);
            if (cfg.hoechstwert !== undefined && parseFloat(cfg.hoechstwert) !== old.hoechstwert)
                await setScaleendToMesskoffer(chNum, newHoe);

            // ✅ SUPPRIMÉ : écriture InfluxDB dans "sensoren_config" — cette
            // measurement n'était jamais relue nulle part (GET /config sert
            // uniquement depuis la mémoire channelConfig, cf. ci-dessous) et
            // n'est pas utilisée par le frontend. Ne plus l'écrire évite
            // d'accumuler des données inutiles dans la base.

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

            const chNum = channelNumber(ch);

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

        // ✅ SUPPRIMÉ : filtre r.Label (même raison que /history — Device+Kanal
        // suffit à identifier la série de façon unique et fiable).
        const queries = channelsList.map(ch => {
            return `
                from(bucket: "${INFLUX_BUCKET}")
                  |> range(start: -10m)
                  |> filter(fn: (r) => r._measurement == "${MEGO_MEASUREMENT}")
                  |> filter(fn: (r) => r.Device == "${MEGO_DEVICE}")
                  |> filter(fn: (r) => r.Kanal  == "${ch}")
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
            const chNum     = channelNumber(ch);
            // ✅ 18 canaux répartis en 3 groupes de 6 (comme le flow Node-RED) :
            // canaux 1-6 → phase L1, 7-12 → L2, 13-18 → L3.
            const voltKanal = Math.min(3, Math.ceil(chNum / 6));
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
    // ✅ Le nommage "PH1".."PH18" est utilisé tel quel (le frontend envoie déjà
    // la bonne casse, puisqu'il réutilise les clés retournées par /config).
    const ch = channel;
    if (!channelsList.includes(ch)) {
        return res.status(400).json({ error: "Ungültiger Kanal" });
    }

    let duration = req.query.time || "1h";
    if (duration.includes("d") && parseInt(duration) > 1) duration = "24h";

    // ✅ SUPPRIMÉ : le filtre supplémentaire sur r.Label a été retiré. Device
    // + Kanal identifient déjà une série de façon unique — filtrer aussi sur
    // le Label (texte libre, modifiable, sujet à des différences d'encodage
    // entre le cache backend et ce que Node-RED écrit réellement) faisait
    // disparaître silencieusement tout l'historique dès que les deux
    // textes ne matchaient plus au caractère près.
    const fluxQuery = `
        from(bucket: "${INFLUX_BUCKET}")
          |> range(start: -${duration})
          |> filter(fn: (r) => r._measurement == "${MEGO_MEASUREMENT}")
          |> filter(fn: (r) => r.Device == "${MEGO_DEVICE}")
          |> filter(fn: (r) => r.Kanal  == "${ch}")
          |> filter(fn: (r) => r._field == "Strom" or r._field == "Wirkleistung" or r._field == "Leistungsfaktor" or r._field == "Energie")
          |> aggregateWindow(every: ${getAggregationWindow(duration)}, fn: mean, createEmpty: true)
          |> fill(value: 0.0)
          |> sort(columns: ["_time"])
    `;

    try {
        const rows         = await queryApi.collectRows(fluxQuery);
        const pointsByTime = {};
        rows.forEach(row => {
            const t = row._time;
            if (!pointsByTime[t]) pointsByTime[t] = { time: t };
            const val = row._value ?? 0;
            if      (row._field === "Strom")          pointsByTime[t].Strom        = val;
            else if (row._field === "Wirkleistung")   pointsByTime[t].Wirkleistung = val;
            else if (row._field === "Leistungsfaktor") pointsByTime[t].CosinusPhi  = val;
            else if (row._field === "Energie")         pointsByTime[t].Energie_temp = val;
        });
        const data = Object.values(pointsByTime)
            .map(point => {
                const { S, Q } = computeApparentAndReactive(point.Wirkleistung ?? 0, point.CosinusPhi ?? 0);
                return { ...point, Scheinleistung: S ?? 0, Blindleistung: Q ?? 0 };
            })
            .sort((a, b) => new Date(a.time) - new Date(b.time));
        // ✅ Si le canal n'a strictement aucune donnée sur la période (série
        // jamais écrite), on retourne quand même une courbe plate à 0 pour
        // toutes les mesures, plutôt que le message "Keine historischen Daten".
        const finalData = data.length > 0
            ? data
            : generateZeroSeries(duration, ["Strom", "Wirkleistung", "CosinusPhi", "Energie_temp", "Scheinleistung", "Blindleistung"]);
        res.json({ channel: ch, data: finalData });
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
    console.log(`   Kanäle: 18 | Mapping: PH1-PH18 → SensorN/Kanal`);
    console.log(`   Sensoren "connectés maintenant" : via Node-RED (${NODERED_URL}/sensoranzahl)`);
});