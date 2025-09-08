// index.js
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";

// Almacenamiento de estado y logs
const store = makeInMemoryStore({ logger: P().child({ level: "silent" }) });
const LOG_FILE = "./logs.txt";

// Advertencias por grupo y usuario
const warnings = {}; // { [groupJid]: { [userJid]: count } }

// Función de log
function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    console.log(fullMessage);
    fs.appendFileSync(LOG_FILE, fullMessage);
}

// Inicio del bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket.default({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: P({ level: "silent" }),
    });

    store.bind(sock.ev);
    sock.ev.on("creds.update", saveCreds);

    // Alertar a todos los admins
    async function alertAdmins(groupJid, message) {
        const groupMetadata = await sock.groupMetadata(groupJid);
        const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
        for (let admin of admins) {
            if (!admin.includes(sock.user.id.split(":")[0])) {
                await sock.sendMessage(admin, { text: `[ALERTA] ${message}` });
            }
        }
    }

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const chat = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!chat.endsWith("@g.us")) return;

        const groupMetadata = await sock.groupMetadata(chat);
        const botAdmin = groupMetadata.participants.find(p => p.id.includes(sock.user.id.split(":")[0]))?.admin || false;

        // Inicializar warnings
        if (!warnings[chat]) warnings[chat] = {};
        if (!warnings[chat][sender]) warnings[chat][sender] = 0;

        // Anti-link
        if (text && /(https?:\/\/[^\s]+)/.test(text)) {
            warnings[chat][sender] += 1;
            const warnCount = warnings[chat][sender];

            if (warnCount === 1) {
                await sock.sendMessage(chat, { text: `⚠️ Advertencia 1/3: No se permiten links.` }, { quoted: msg });
            } else if (warnCount === 2) {
                await sock.sendMessage(chat, { text: `⚠️ Advertencia 2/3: Tu mensaje será eliminado.` }, { quoted: msg });
                await sock.sendMessage(chat, { delete: msg.key });
            } else if (warnCount >= 3) {
                await sock.sendMessage(chat, { delete: msg.key });
                if (botAdmin) {
                    await sock.groupParticipantsUpdate(chat, [sender], "remove");
                    await sock.sendMessage(chat, { text: `❌ ${sender} eliminado por tercera infracción.` });
                    logToFile(`${sender} kickeado en ${groupMetadata.subject} (3ra infracción)`);
                } else {
                    logToFile(`No se pudo kickear a ${sender}, el bot no es admin.`);
                }
                warnings[chat][sender] = 0;
            }

            logToFile(
                `Grupo: ${groupMetadata.subject}\n` +
                `Bot admin: ${botAdmin}\n` +
                `Número remitente: ${sender}\n` +
                `Mensaje: ${text}\n` +
                `Advertencia: ${warnCount}\n` +
                `Miembros: ${groupMetadata.participants.map(p => p.id).join(", ")}`
            );

            await alertAdmins(chat, `${sender} infringió regla de links (Advertencia ${warnCount}/3)`);
        }

        // Comando .kick
        if (text && text.startsWith(".kick")) {
            const senderAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;
            if (!senderAdmin) {
                await sock.sendMessage(chat, { text: "❌ Solo admins pueden usar este comando." }, { quoted: msg });
                return;
            }
            const target = text.split(" ")[1];
            if (!target) return;

            if (botAdmin) {
                await sock.groupParticipantsUpdate(chat, [target + "@s.whatsapp.net"], "remove");
                await sock.sendMessage(chat, { text: `✅ ${target} ha sido eliminado por admin.` });
                logToFile(`${target} kickeado por admin en ${groupMetadata.subject}`);
            } else {
                await sock.sendMessage(chat, { text: "❌ No puedo kickear, necesito ser admin." });
            }
        }
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            logToFile("Conexión cerrada, reintentando...");
            if ((lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
                startBot();
            }
        } else if (connection === "open") {
            logToFile("✅ Bot conectado correctamente.");
        }
    });
}

startBot();