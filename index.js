/**
 * FINAL MERGED index.js
 * WP Loader UI + ALex-Techy simple pairing + Broadcasting (NO REGENERATION / NO AUTO-RECONNECT)
 *
 * Features:
 * - Phone Number Pairing (requestPairingCode)
 * - Stable pairing code (shows ONCE)
 * - NO pairingcode rotation
 * - Fallback QR support
 * - UI: /pairing + /broadcast
 * - Logs via SSE
 * - Base64 token export
 * - Broadcasting with message TXT + mention TXT
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const pino = require("pino");
const moment = require("moment-timezone");
const QRCode = require("qrcode");
const multer = require("multer");

const {
  default: makeWASocket,
  Browsers,
  delay,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "sessions");

// Create sessions folder
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const sessionLogs = new Map();
const activeSessions = new Map();
const activeSockets = new Map();
const pairingRequested = new Set();

// Add log + push to SSE clients
function addSessionLog(sessionKey, msg, type = "info") {
  const ts = moment().format("YYYY-MM-DD HH:mm:ss");
  const log = { message: `[${ts}] ${msg}`, type };

  if (!sessionLogs.has(sessionKey)) sessionLogs.set(sessionKey, []);
  sessionLogs.get(sessionKey).push(log);

  const session = activeSessions.get(sessionKey);
  if (session && session.clients) {
    session.clients.forEach((res) => {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    });
  }
}

// SSE logs endpoint
app.get("/logs/:sessionKey", (req, res) => {
  const key = req.params.sessionKey;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache");

  if (!activeSessions.has(key)) activeSessions.set(key, { clients: [] });
  activeSessions.get(key).clients.push(res);

  const pastLogs = sessionLogs.get(key) || [];
  pastLogs.forEach((log) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  req.on("close", () => {
    const session = activeSessions.get(key);
    if (!session) return;
    session.clients = session.clients.filter((c) => c !== res);
  });
});

// -----------------------------
// PAIRING UI
// -----------------------------
app.get("/pairing", (req, res) => {
  res.send(`
<html>
<head>
<title>WhatsApp Pairing</title>
</head>
<body style="background:#0B1221;color:white;font-family:Arial;padding:20px;">
<h2>WhatsApp Pairing (Stable)</h2>

<input id="phone" placeholder="Phone Number (no +)" style="padding:8px;width:280px;">
<button id="start">Generate Pair Code</button>
<button id="token">Get Token</button>

<div id="session"></div>
<div id="qr"></div>

<pre id="logs" style="background:black;color:#0f0;padding:10px;height:350px;overflow:auto;"></pre>

<script>
const phone = document.getElementById("phone");
const logs = document.getElementById("logs");
const qr = document.getElementById("qr");
const sessionDiv = document.getElementById("session");

document.getElementById("start").onclick = async () => {
    const num = phone.value.trim();
    if (!num) return alert("Enter phone number");

    const r = await fetch('/pair', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ phoneNumber: num })
    });

    const j = await r.json();
    if (!r.ok) return alert(JSON.stringify(j));

    sessionDiv.innerHTML = "Session Key: <b>" + j.sessionKey + "</b>";
    logs.textContent += "\\nSession started: " + j.sessionKey;

    const es = new EventSource('/logs/' + j.sessionKey);

    es.onmessage = (e) => {
        const log = JSON.parse(e.data);
        logs.textContent += "\\n" + log.message;
        logs.scrollTop = logs.scrollHeight;

        if (log.message.includes("PAIRING_QR:")) {
            const img = log.message.split("PAIRING_QR:")[1].trim();
            qr.innerHTML = '<img src="' + img + '" width="250">';
        }
    };
};

document.getElementById("token").onclick = async () => {
    const text = sessionDiv.textContent;
    const match = text.match(/[a-f0-9]{16}/);
    if (!match) return alert("Start pairing first.");

    const key = match[0];
    const r = await fetch('/get-token/' + key);
    const txt = await r.text();

    const w = window.open();
    w.document.body.innerText = txt;
};
</script>
</body>
</html>
  `);
});

// -----------------------------
// BROADCAST UI
// -----------------------------
const upload = multer({ dest: "uploads/" });

app.get("/broadcast", (req, res) => {
  res.send(`
<html>
<head>
<title>Broadcast</title>
</head>
<body style="background:#0B1221;color:white;font-family:Arial;padding:20px;">
<h2>Broadcast Messages</h2>

<label>Session Key:</label>
<input id="sessionKey" placeholder="Session Key" style="padding:8px;width:300px;"><br><br>

<label>Send To:</label>
<select id="targetType">
<option value="user">User</option>
<option value="group">Group</option>
</select><br><br>

<label>Target IDs (comma separated)</label>
<input id="targets" placeholder="Group ID or numbers" style="padding:8px;width:300px;"><br><br>

<label>Upload Message File (.txt)</label>
<input type="file" id="msgFile"><br><br>

<label>Upload Mention File (.txt) [for groups]</label>
<input type="file" id="mentionFile"><br><br>

<label>Delay (ms)</label>
<input id="delay" type="number" value="2000" style="padding:8px;width:100px;"><br><br>

<button id="start">Start Broadcast</button>

<pre id="logs" style="background:black;color:#0f0;padding:10px;height:400px;overflow:auto;"></pre>

<script>
const logs = document.getElementById("logs");

document.getElementById("start").onclick = async () => {
    const sessionKey = document.getElementById("sessionKey").value.trim();
    const targetType = document.getElementById("targetType").value;
    const targets = document.getElementById("targets").value.trim();
    const delayTime = parseInt(document.getElementById("delay").value) || 2000;

    if(!sessionKey || !targets) return alert("Enter session key and targets");

    // Read message file
    const msgFile = document.getElementById("msgFile").files[0];
    const mentionFile = document.getElementById("mentionFile").files[0];

    let messages = [];
    if(msgFile){
        const text = await msgFile.text();
        messages = text.split(/\\r?\\n/).filter(l=>l.trim());
    } else {
        messages = ["Hello!"];
    }

    // Read mentions
    let mentions = [];
    if(mentionFile){
        const text = await mentionFile.text();
        mentions = text.split(/\\r?\\n/).filter(l=>l.trim());
    }

    const formData = new FormData();
    formData.append("sessionKey", sessionKey);
    formData.append("targetType", targetType);
    formData.append("targets", targets);
    formData.append("messages", JSON.stringify(messages));
    formData.append("mentions", JSON.stringify(mentions));
    formData.append("delay", delayTime);

    fetch('/broadcast', {method:'POST', body: formData})
        .then(r=>r.json())
        .then(j=>{ logs.textContent += "\\nBroadcast Started"; })
        .catch(e=>{ logs.textContent += "\\nError: "+e.message; });
};
</script>
</body>
</html>
  `);
});

// -----------------------------
// PAIR ROUTE
// -----------------------------
app.post("/pair", async (req, res) => {
  try {
    const phoneNumber = req.body.phoneNumber;
    if (!phoneNumber)
      return res.status(400).json({ error: "Phone number required" });

    const sessionKey = crypto.randomBytes(8).toString("hex");
    const authDir = path.join(SESSIONS_DIR, sessionKey, "auth");
    fs.mkdirSync(authDir, { recursive: true });

    sessionLogs.set(sessionKey, []);
    activeSessions.set(sessionKey, { clients: [] });

    addSessionLog(sessionKey, "Starting pairing session for: " + phoneNumber);

    startPairingSession(sessionKey, authDir, phoneNumber);

    res.json({ sessionKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// GET TOKEN
// -----------------------------
app.get("/get-token/:sessionKey", (req, res) => {
  const key = req.params.sessionKey;
  const file = path.join(SESSIONS_DIR, key, "auth", "creds.json");

  if (!fs.existsSync(file)) return res.status(404).send("Not paired yet.");

  const creds = fs.readFileSync(file, "utf8");
  const b64 = Buffer.from(creds).toString("base64");

  res.send(b64);
});

// -----------------------------
// BROADCAST POST
// -----------------------------
app.post("/broadcast", upload.none(), async (req, res) => {
  try {
    const { sessionKey, targetType, targets, messages, mentions, delay } = req.body;
    if (!sessionKey || !targets || !messages) return res.status(400).json({error:"Missing data"});

    const sock = activeSockets.get(sessionKey);
    if(!sock) return res.status(400).json({error:"Session not active"});

    const targetList = targets.split(",").map(t=>t.trim());
    const msgs = JSON.parse(messages);
    const mentionList = JSON.parse(mentions).map(n => n.replace(/\D/g,"")+"@s.whatsapp.net");

    addSessionLog(sessionKey, `Starting broadcast to ${targetList.length} ${targetType}(s)`);

    (async()=>{
      for(const target of targetList){
        for(const msg of msgs){
          let textToSend = msg;
          if(targetType==="group" && mentionList.length>0){
            textToSend += "\n\n" + mentionList.map(m=>"@"+m.split("@")[0]).join(" ");
          }
          try{
            await sock.sendMessage(target, { text: textToSend, mentions: mentionList });
            addSessionLog(sessionKey, `Sent to ${target}: ${textToSend}`);
          }catch(e){
            addSessionLog(sessionKey, `Error sending to ${target}: ${e.message}`,"error");
          }
          await delay(parseInt(delay)||2000);
        }
      }
      addSessionLog(sessionKey,"Broadcast finished","success");
    })();

    res.json({status:"Broadcast started"});
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// -----------------------------
// MAIN pairing logic — ALex-Techy style (NO rotation)
// -----------------------------
async function startPairingSession(sessionKey, authDir, phoneNumber) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Firefox"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level:"silent" }))
    },
    printQRInTerminal: false,
    syncFullHistory: false
  });

  activeSockets.set(sessionKey, sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr && !state.creds?.registered) {
      const qrData = await QRCode.toDataURL(qr);
      addSessionLog(sessionKey, "PAIRING_QR:" + qrData);
    }

    if (connection === "open") {
      addSessionLog(sessionKey, "Connected to WhatsApp.");

      if (!state.creds?.registered && !pairingRequested.has(sessionKey)) {
        pairingRequested.add(sessionKey);

        await delay(1500);
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          addSessionLog(sessionKey, "PAIRING_CODE: " + code, "success");
        } catch (err) {
          addSessionLog(sessionKey, "pairing error: " + err.message, "error");
        }
      }
    }

    if (connection === "close") {
      addSessionLog(sessionKey, "Connection closed — NOT restarting to avoid code rotation");
    }
  });
}

app.listen(PORT, () => console.log("Server running on port " + PORT));